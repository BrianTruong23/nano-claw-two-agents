import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  ASSISTANT_NAME,
  buildTriggerPattern,
  CONTROL_PLANE_URL,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  ONECLI_URL,
  OTHER_BOT_TRIGGERS,
  POLL_INTERVAL,
  TIMEZONE,
  WAIT_FOR_BOT_RESPONSE,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import {
  initRuntimeDashboardState,
  markRuntimeDashboardStopped,
  updateRuntimeDashboardState,
} from './dashboard-state.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  deleteSession,
  getAllTasks,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  countCrossBotResponses,
  hasCrossBotMention,
  hasCrossBotResponse,
  isRoutingBanner,
  isProgressPing,
  isSubstantiveBotMessage,
  isGroupChat,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  buildResearchModePrompt,
  classifyResearchMode,
  formatResearchModeUserNotice,
  humanWantsGitMachineReport,
  isResearchModeCommand,
  shouldAgentRunForResearchMode,
} from './research-mode.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSessionCleanup } from './session-cleanup.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import { runCodexExec } from './codex-runner.js';
import { runClaudeExec } from './claude-runner.js';
import { applySupportedEnvAliases } from './env.js';
import { startControlPlaneWorker } from './control-plane-worker.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

applySupportedEnvAliases();

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;
const bannerSentForCursor: Record<string, string> = {};
const verifiedForMessage: Record<string, string> = {};
// How many substantive cross-bot responses existed when Bob last verified.
// If the count grows (Andy responded to a handoff), Bob re-verifies.
const verifiedBotCount: Record<string, number> = {};
// How many verification rounds Bob has done for the current user message.
// Hard-capped at MAX_VERIFY_ROUNDS to avoid infinite handoff loops.
const verifyRoundCount: Record<string, number> = {};
const MAX_VERIFY_ROUNDS = 3;
// Settle logic: track cross-bot response count per user-message cursor.
// Bob waits until the count stabilises (same for two consecutive checks)
// before starting verification, so late-arriving responses are included.
const settledCrossBotCount: Record<string, number> = {};

const channels: Channel[] = [];
const queue = new GroupQueue();

const onecli = new OneCLI({ url: ONECLI_URL });

function ensureOneCLIAgent(jid: string, group: RegisteredGroup): void {
  if (group.isMain) return;
  const identifier = group.folder.toLowerCase().replace(/_/g, '-');
  onecli.ensureAgent({ name: group.name, identifier }).then(
    (res) => {
      logger.info(
        { jid, identifier, created: res.created },
        'OneCLI agent ensured',
      );
    },
    (err) => {
      logger.debug(
        { jid, identifier, err: String(err) },
        'OneCLI agent ensure skipped',
      );
    },
  );
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function messageAddressesOnlyOtherBot(
  message: NewMessage,
  group: RegisteredGroup,
): boolean {
  if (OTHER_BOT_TRIGGERS.length === 0) return false;
  const content = message.content.trim();
  const otherPatterns = OTHER_BOT_TRIGGERS.map(buildTriggerPattern);
  const myPattern = getTriggerPattern(group.trigger);
  const addressesOther = otherPatterns.some((p) => p.test(content));
  const addressesMe = myPattern.test(content);
  return addressesOther && !addressesMe;
}

function retryMessageCheckSoon(chatJid: string): void {
  setTimeout(() => {
    queue.enqueueMessageCheck(chatJid);
    queue.closeStdin(chatJid);
  }, 2000);
}

function canMessageStartResearchMode(
  message: NewMessage,
  _group: RegisteredGroup,
  chatJid: string,
): boolean {
  if (!isGroupChat(chatJid)) return false;
  if (message.is_bot_message) return false;
  if (message.is_from_me) return true;
  return isTriggerAllowed(chatJid, message.sender, loadSenderAllowlist());
}

function isPrimaryFixHandoffMessage(message: NewMessage): boolean {
  if (WAIT_FOR_BOT_RESPONSE) return false;
  if (!message.is_bot_message || message.is_from_me) return false;
  const mentionPattern = new RegExp(`@${ASSISTANT_NAME}\\b`, 'i');
  return mentionPattern.test(message.content);
}

function shouldWaitForPrimaryResearchTurn(
  modeDecision: ReturnType<typeof classifyResearchMode> | null,
  newestHumanMsg: NewMessage | undefined,
  chatJid: string,
  isMainGroup: boolean,
): boolean {
  if (isMainGroup || !WAIT_FOR_BOT_RESPONSE) return false;
  if (!modeDecision || !newestHumanMsg) return false;
  const cursor = newestHumanMsg.timestamp || lastAgentTimestamp[chatJid] || '';

  // Explicit @mention from the primary = proceed immediately
  if (hasCrossBotMention(chatJid, cursor, ASSISTANT_NAME)) return false;

  const count = countCrossBotResponses(chatJid, cursor);
  if (count === 0) return true; // primary hasn't responded yet

  // Settle: wait until the substantive-message count is stable across two
  // consecutive polling cycles.  This gives the bridge time to sync any
  // follow-up messages the primary posts shortly after its first reply.
  const settleKey = `${chatJid}:${cursor}`;
  if (settledCrossBotCount[settleKey] === count) {
    delete settledCrossBotCount[settleKey];
    return false; // count stable — proceed to verify
  }

  settledCrossBotCount[settleKey] = count;
  return true; // count changed or first observation — wait one more cycle
}

function getAgentAuthProblem(): string | null {
  const token = process.env.ANTHROPIC_AUTH_TOKEN?.trim();
  if (!token || token === 'YOUR_OPENROUTER_API_KEY') {
    return 'NanoClaw cannot answer yet because the OpenRouter API key is not configured. Replace the placeholder in this agent .env with a real OpenRouter key, then restart with ./start.sh stop && ./start.sh.';
  }
  return null;
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Copy CLAUDE.md template into the new group folder so agents have
  // identity and instructions from the first run.  (Fixes #1391)
  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMdFile)) {
    const templateFile = path.join(
      GROUPS_DIR,
      group.isMain ? 'main' : 'global',
      'CLAUDE.md',
    );
    if (fs.existsSync(templateFile)) {
      let content = fs.readFileSync(templateFile, 'utf-8');
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(groupMdFile, content);
      logger.info({ folder: group.folder }, 'Created CLAUDE.md from template');
    }
  }

  // Ensure a corresponding OneCLI agent exists (best-effort, non-blocking)
  ensureOneCLIAgent(jid, group);

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );

  if (missedMessages.length === 0) return true;

  // Nothing to respond to if every pending message is from this bot
  if (missedMessages.every((m) => m.is_from_me)) {
    lastAgentTimestamp[chatJid] =
      missedMessages[missedMessages.length - 1].timestamp;
    saveState();
    return true;
  }

  const newestHumanMsg = [...missedMessages]
    .reverse()
    .find((m) => !m.is_from_me && !m.is_bot_message);
  const newestPrimaryHandoffMsg = [...missedMessages]
    .reverse()
    .find((m) => isPrimaryFixHandoffMessage(m));
  if (!WAIT_FOR_BOT_RESPONSE && !newestHumanMsg && !newestPrimaryHandoffMsg) {
    lastAgentTimestamp[chatJid] =
      missedMessages[missedMessages.length - 1].timestamp;
    saveState();
    return true;
  }

  // Multi-bot coordination: skip if messages exclusively address the other bot
  if (OTHER_BOT_TRIGGERS.length > 0) {
    const otherPatterns = OTHER_BOT_TRIGGERS.map(buildTriggerPattern);
    const myPattern = getTriggerPattern(group.trigger);
    const hasOther = missedMessages.some(
      (m) =>
        !m.is_from_me &&
        !m.is_bot_message &&
        otherPatterns.some((p) => p.test(m.content.trim())),
    );
    const hasMine = missedMessages.some(
      (m) =>
        !m.is_from_me && !m.is_bot_message && myPattern.test(m.content.trim()),
    );
    if (hasOther && !hasMine) return true;
  }

  // Research verify mode applies only to multi-user groups (chats.is_group = 1), not 1:1 DMs.
  const modeDecision =
    newestHumanMsg && isGroupChat(chatJid)
      ? classifyResearchMode(newestHumanMsg.content)
      : null;
  if (
    modeDecision &&
    !shouldAgentRunForResearchMode(modeDecision.mode, WAIT_FOR_BOT_RESPONSE)
  ) {
    lastAgentTimestamp[chatJid] =
      missedMessages[missedMessages.length - 1].timestamp;
    saveState();
    logger.info(
      { group: group.name, mode: modeDecision.mode },
      'Skipping message due to research group mode',
    );
    return true;
  }

  // In research modes, secondary must always wait for the primary bot's reply.
  if (
    shouldWaitForPrimaryResearchTurn(
      modeDecision,
      newestHumanMsg,
      chatJid,
      isMainGroup,
    )
  ) {
    retryMessageCheckSoon(chatJid);
    return true;
  }

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        (triggerPattern.test(m.content.trim()) ||
          isResearchModeCommand(m.content) ||
          canMessageStartResearchMode(m, group, chatJid) ||
          isPrimaryFixHandoffMessage(m)) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    // Verifier: any new substantive cross-bot message is an implicit trigger
    // (Andy responded — Bob must verify, no explicit trigger required)
    const hasNewBotWork =
      WAIT_FOR_BOT_RESPONSE &&
      missedMessages.some(
        (m) => !m.is_from_me && m.is_bot_message && isSubstantiveBotMessage(m.content),
      );
    if (!hasTrigger && !hasNewBotWork) return true;
  }

  const substantiveMessages = missedMessages.filter(
    (m) => !isRoutingBanner(m.content) && !isProgressPing(m.content),
  );
  if (substantiveMessages.length === 0) {
    retryMessageCheckSoon(chatJid);
    return true;
  }
  // Verifier: keep only the **current** user turn onward so the model does not
  // @-reply about an older task (e.g. Transformers) still present in the batch window.
  let messagesForPrompt = substantiveMessages;
  if (
    WAIT_FOR_BOT_RESPONSE &&
    newestHumanMsg &&
    modeDecision &&
    isGroupChat(chatJid)
  ) {
    const idx = substantiveMessages.findIndex(
      (m) => m.timestamp === newestHumanMsg.timestamp,
    );
    if (idx >= 0) messagesForPrompt = substantiveMessages.slice(idx);
  }
  const formattedPrompt = formatMessages(messagesForPrompt, TIMEZONE);
  const prompt = modeDecision
    ? buildResearchModePrompt(
        formattedPrompt,
        modeDecision,
        ASSISTANT_NAME,
        WAIT_FOR_BOT_RESPONSE,
      )
    : formattedPrompt;
  const gitMachineReportWanted = humanWantsGitMachineReport(
    modeDecision?.cleanedContent ?? null,
    newestHumanMsg?.content ?? null,
  );

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    {
      group: group.name,
      messageCount: missedMessages.length,
      researchMode: modeDecision?.mode,
      researchSource: modeDecision?.source,
    },
    'Processing messages',
  );

  const authProblem = getAgentAuthProblem();
  if (authProblem) {
    lastAgentTimestamp[chatJid] =
      missedMessages[missedMessages.length - 1].timestamp;
    saveState();
    logger.error({ group: group.name }, 'Agent auth is not configured');
    await channel.sendMessage(chatJid, authProblem);
    return true;
  }

  const bannerKey = newestHumanMsg?.timestamp || missedMessages[missedMessages.length - 1].timestamp;

  // Reset round counter when a new user message arrives
  if (WAIT_FOR_BOT_RESPONSE && verifiedForMessage[chatJid] !== bannerKey) {
    verifyRoundCount[chatJid] = 0;
  }

  // Secondary: skip if already verified AND no new responses, OR max rounds reached
  if (WAIT_FOR_BOT_RESPONSE && verifiedForMessage[chatJid] === bannerKey) {
    const currentBotCount = countCrossBotResponses(chatJid, bannerKey);
    if (verifiedBotCount[chatJid] === currentBotCount) {
      logger.debug({ group: group.name }, 'Already verified for this user message, skipping');
      return true;
    }
    if ((verifyRoundCount[chatJid] || 0) >= MAX_VERIFY_ROUNDS) {
      logger.info({ group: group.name, rounds: verifyRoundCount[chatJid] }, 'Max verify rounds reached, stopping');
      return true;
    }
    logger.info(
      { group: group.name, prev: verifiedBotCount[chatJid], now: currentBotCount, round: (verifyRoundCount[chatJid] || 0) + 1 },
      'Primary sent new response after handoff — re-verifying',
    );
  }

  if (modeDecision && isGroupChat(chatJid) && bannerSentForCursor[chatJid] !== bannerKey) {
    bannerSentForCursor[chatJid] = bannerKey;
    const banner = formatResearchModeUserNotice(
      modeDecision,
      ASSISTANT_NAME,
      WAIT_FOR_BOT_RESPONSE,
    );
    try {
      await channel.sendMessage(chatJid, banner);
    } catch (err) {
      logger.warn({ chatJid, err }, 'Failed to send research mode banner');
    }
  }

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  try {
    await channel.setTyping?.(chatJid, true);
  } catch (err) {
    logger.warn({ chatJid, err }, 'Failed to set typing indicator');
  }
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(
    group,
    prompt,
    chatJid,
    async (result) => {
      // Streaming output callback — called for each agent result
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
        if (text) {
          await channel.sendMessage(chatJid, text);
          outputSentToUser = true;
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.status === 'success') {
        queue.notifyIdle(chatJid);
      }

      if (result.status === 'error') {
        hadError = true;
      }
    },
    { gitMachineReportWanted },
  );

  try {
    await channel.setTyping?.(chatJid, false);
  } catch (err) {
    logger.warn({ chatJid, err }, 'Failed to clear typing indicator');
  }
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      if (WAIT_FOR_BOT_RESPONSE) {
        verifiedForMessage[chatJid] = bannerKey;
        verifiedBotCount[chatJid] = countCrossBotResponses(chatJid, bannerKey);
        verifyRoundCount[chatJid] = (verifyRoundCount[chatJid] || 0) + 1;
      }
      return true;
    }
    // Notify the user that something went wrong (instead of silent retry)
    try {
      await channel.sendMessage(
        chatJid,
        `⚠️ ${ASSISTANT_NAME} encountered an error processing your message. Retrying...`,
      );
    } catch {
      /* best-effort */
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  if (WAIT_FOR_BOT_RESPONSE) {
    verifiedForMessage[chatJid] = bannerKey;
    verifiedBotCount[chatJid] = countCrossBotResponses(chatJid, bannerKey);
    verifyRoundCount[chatJid] = (verifyRoundCount[chatJid] || 0) + 1;
  }
  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  opts?: { gitMachineReportWanted?: boolean },
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        verifierMode: WAIT_FOR_BOT_RESPONSE,
        gitMachineReportWanted: opts?.gitMachineReportWanted,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      // Detect stale/corrupt session — clear it so the next retry starts fresh.
      // The session .jsonl can go missing after a crash mid-write, manual
      // deletion, or disk-full. The existing backoff in group-queue.ts
      // handles the retry; we just need to remove the broken session ID.
      const isStaleSession =
        sessionId &&
        output.error &&
        /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(
          output.error,
        );

      if (isStaleSession) {
        logger.warn(
          { group: group.name, staleSessionId: sessionId, error: output.error },
          'Stale session detected — clearing for next retry',
        );
        delete sessions[group.folder];
        deleteSession(group.folder);
      }

      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // Skip if all new messages are from this bot — nothing to respond to
          if (groupMessages.every((m) => m.is_from_me)) continue;

          // Prevent active containers from intercepting messages addressed to the other bot
          if (OTHER_BOT_TRIGGERS.length > 0) {
            const newestHumanMsg = [...groupMessages]
              .reverse()
              .find((m) => !m.is_from_me && !m.is_bot_message);
            if (newestHumanMsg) {
              if (messageAddressesOnlyOtherBot(newestHumanMsg, group)) continue;
            }
          }

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                (triggerPattern.test(m.content.trim()) ||
                  isResearchModeCommand(m.content) ||
                  canMessageStartResearchMode(m, group, chatJid) ||
                  isPrimaryFixHandoffMessage(m)) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            const hasNewBotWork =
              WAIT_FOR_BOT_RESPONSE &&
              groupMessages.some(
                (m) => !m.is_from_me && m.is_bot_message && isSubstantiveBotMessage(m.content),
              );
            if (!hasTrigger && !hasNewBotWork) continue;
          }

          const newestHumanMsg = [...groupMessages]
            .reverse()
            .find((m) => !m.is_from_me && !m.is_bot_message);
          const modeDecision =
            newestHumanMsg && isGroupChat(chatJid)
              ? classifyResearchMode(newestHumanMsg.content)
              : null;
          if (
            modeDecision &&
            !shouldAgentRunForResearchMode(
              modeDecision.mode,
              WAIT_FOR_BOT_RESPONSE,
            )
          ) {
            const allPending = getMessagesSince(
              chatJid,
              getOrRecoverCursor(chatJid),
              ASSISTANT_NAME,
              MAX_MESSAGES_PER_PROMPT,
            );
            const messagesToSkip =
              allPending.length > 0 ? allPending : groupMessages;
            lastAgentTimestamp[chatJid] =
              messagesToSkip[messagesToSkip.length - 1].timestamp;
            saveState();
            logger.info(
              { group: group.name, mode: modeDecision.mode },
              'Skipping message due to research group mode',
            );
            continue;
          }

          // In research modes, secondary must always wait for primary output,
          // including the hot path where we can pipe to an active container.
          if (
            shouldWaitForPrimaryResearchTurn(
              modeDecision,
              newestHumanMsg,
              chatJid,
              isMainGroup,
            )
          ) {
            retryMessageCheckSoon(chatJid);
            continue;
          }

          // Secondary: skip only if already verified AND no new responses, OR max rounds reached
          const pipeVerifyKey = newestHumanMsg?.timestamp || groupMessages[groupMessages.length - 1]?.timestamp;
          if (WAIT_FOR_BOT_RESPONSE && pipeVerifyKey && verifiedForMessage[chatJid] === pipeVerifyKey) {
            const currentBotCount = countCrossBotResponses(chatJid, pipeVerifyKey);
            if (verifiedBotCount[chatJid] === currentBotCount || (verifyRoundCount[chatJid] || 0) >= MAX_VERIFY_ROUNDS) {
              logger.debug({ chatJid }, 'Already verified for this user message (pipe), skipping');
              continue;
            }
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            getOrRecoverCursor(chatJid),
            ASSISTANT_NAME,
            MAX_MESSAGES_PER_PROMPT,
          );
          const rawMessagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const messagesToSend = rawMessagesToSend.filter(
            (m) => !isRoutingBanner(m.content) && !isProgressPing(m.content),
          );
          if (messagesToSend.length === 0) {
            retryMessageCheckSoon(chatJid);
            continue;
          }
          const formattedBase = formatMessages(messagesToSend, TIMEZONE);
          const formatted = modeDecision
            ? buildResearchModePrompt(
                formattedBase,
                modeDecision,
                ASSISTANT_NAME,
                WAIT_FOR_BOT_RESPONSE,
              )
            : formattedBase;

          const pipeBannerKey = newestHumanMsg?.timestamp || messagesToSend[messagesToSend.length - 1]?.timestamp;
          if (
            modeDecision &&
            isGroupChat(chatJid) &&
            queue.canPipeMessage(chatJid) &&
            pipeBannerKey &&
            bannerSentForCursor[chatJid] !== pipeBannerKey
          ) {
            bannerSentForCursor[chatJid] = pipeBannerKey;
            const banner = formatResearchModeUserNotice(
              modeDecision,
              ASSISTANT_NAME,
              WAIT_FOR_BOT_RESPONSE,
            );
            try {
              await channel.sendMessage(chatJid, banner);
            } catch (err) {
              logger.warn(
                { chatJid, err },
                'Failed to send research mode banner (pipe)',
              );
            }
          }

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverCursor(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

function syncDashboardState(
  status?: Parameters<typeof updateRuntimeDashboardState>[0]['status'],
): void {
  updateRuntimeDashboardState({
    status,
    channels: channels.map((channel) => ({
      name: channel.name,
      connected: channel.isConnected(),
    })),
    queue: queue.getSnapshot(),
  });
}

async function main(): Promise<void> {
  initRuntimeDashboardState();
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Ensure OneCLI agents exist for all registered groups.
  // Recovers from missed creates (e.g. OneCLI was down at registration time).
  for (const [jid, group] of Object.entries(registeredGroups)) {
    ensureOneCLIAgent(jid, group);
  }

  restoreRemoteControl();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    syncDashboardState('shutting_down');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    markRuntimeDashboardStopped('stopped');
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  async function handleCodexCommand(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group) {
      const channel = findChannel(channels, chatJid);
      if (channel) {
        await channel.sendMessage(
          chatJid,
          'Codex commands are only enabled in registered chats.',
        );
      }
      logger.warn(
        { chatJid, sender: msg.sender },
        'Codex command rejected: unregistered chat',
      );
      return;
    }

    const prompt = command.replace(/^\/codex\b/i, '').trim();
    if (!prompt) {
      const channel = findChannel(channels, chatJid);
      if (channel) {
        await channel.sendMessage(chatJid, 'Usage: /codex <coding task>');
      }
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    await channel.sendMessage(chatJid, 'Starting Codex coding agent…');
    try {
      await channel.setTyping?.(chatJid, true);
    } catch (e) {}

    try {
      const workspaceDir = path.resolve(process.cwd(), '../common/host-coding-work');
      if (!fs.existsSync(workspaceDir)) {
        fs.mkdirSync(workspaceDir, { recursive: true });
      }
      const result = await runCodexExec(prompt, workspaceDir);
      try {
        await channel.setTyping?.(chatJid, false);
      } catch (e) {}
      if (result.ok) {
        await channel.sendMessage(chatJid, result.text || 'Codex completed.');
      } else {
        await channel.sendMessage(
          chatJid,
          `Codex failed: ${result.error || 'unknown error'}`,
        );
      }
    } catch (err) {
      try {
        await channel.setTyping?.(chatJid, false);
      } catch (e) {}
      await channel.sendMessage(
        chatJid,
        `Codex failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function handleClaudeCommand(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group) {
      const channel = findChannel(channels, chatJid);
      if (channel) {
        await channel.sendMessage(
          chatJid,
          'Claude commands are only enabled in registered chats.',
        );
      }
      logger.warn(
        { chatJid, sender: msg.sender },
        'Claude command rejected: unregistered chat',
      );
      return;
    }

    const prompt = command.replace(/^\/claude\b/i, '').trim();
    if (!prompt) {
      const channel = findChannel(channels, chatJid);
      if (channel) {
        await channel.sendMessage(chatJid, 'Usage: /claude <coding task>');
      }
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    await channel.sendMessage(chatJid, 'Starting Claude coding agent…');
    try {
      await channel.setTyping?.(chatJid, true);
    } catch (e) {}

    try {
      const workspaceDir = path.resolve(process.cwd(), '../common/host-coding-work');
      if (!fs.existsSync(workspaceDir)) {
        fs.mkdirSync(workspaceDir, { recursive: true });
      }
      const result = await runClaudeExec(prompt, workspaceDir);
      try {
        await channel.setTyping?.(chatJid, false);
      } catch (e) {}
      if (result.ok) {
        await channel.sendMessage(chatJid, result.text || 'Claude completed.');
      } else {
        await channel.sendMessage(
          chatJid,
          `Claude failed: ${result.error || 'unknown error'}`,
        );
      }
    } catch (err) {
      try {
        await channel.setTyping?.(chatJid, false);
      } catch (e) {}
      await channel.sendMessage(
        chatJid,
        `Claude failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  function extractCodexPrompt(text: string): string | null {
    const trimmed = text.trim();
    if (/^\/codex\b/i.test(trimmed)) {
      const prompt = trimmed
        .replace(/^\/(?:codex|claude)\b[:\s-]*/i, '')
        .trim();
      return prompt || null;
    }

    const naturalLanguagePatterns = [
      /^use codex (?:to |for )?(.*)$/i,
      /^spawn codex (?:to |for )?(.*)$/i,
      /^have codex (?:handle|do|fix|work on|look at|review)\s+(.*)$/i,
      /^ask codex (?:to )?(.*)$/i,
      /^codex[:,]?\s*(.*)$/i,
      /^use (?:the )?(?:coding|code) agent (?:to |for )?(.*)$/i,
      /^spawn (?:the )?(?:coding|code) agent (?:to |for )?(.*)$/i,
      /^have (?:the )?(?:coding|code) agent (?:handle|do|fix|work on|look at|review)\s+(.*)$/i,
      /^ask (?:the )?(?:coding|code) agent (?:to )?(.*)$/i,
      /^(?:coding|code) agent[:,]?\s*(.*)$/i,
      /^(commit .* and push(?: .*github)?|push .* to github|push to github)$/i,
    ];

    for (const pattern of naturalLanguagePatterns) {
      const match = trimmed.match(pattern);
      const prompt = match?.[1]?.trim();
      if (prompt) return prompt;
    }

    return null;
  }

  function extractClaudePrompt(text: string): string | null {
    const trimmed = text.trim();
    if (/^\/claude\b/i.test(trimmed)) {
      const prompt = trimmed
        .replace(/^\/(?:claude|claude)\b[:\s-]*/i, '')
        .trim();
      return prompt || null;
    }

    const naturalLanguagePatterns = [
      /^use claude (?:to |for )?(.*)$/i,
      /^spawn claude (?:to |for )?(.*)$/i,
      /^have claude (?:handle|do|fix|work on|look at|review)\s+(.*)$/i,
      /^ask claude (?:to )?(.*)$/i,
      /^claude[:,]?\s*(.*)$/i,
      /^use (?:the )?(?:coding|code) agent (?:to |for )?(.*)$/i,
      /^spawn (?:the )?(?:coding|code) agent (?:to |for )?(.*)$/i,
      /^have (?:the )?(?:coding|code) agent (?:handle|do|fix|work on|look at|review)\s+(.*)$/i,
      /^ask (?:the )?(?:coding|code) agent (?:to )?(.*)$/i,
      /^(?:coding|code) agent[:,]?\s*(.*)$/i,
      /^(commit .* and push(?: .*github)?|push .* to github|push to github)$/i,
    ];

    for (const pattern of naturalLanguagePatterns) {
      const match = trimmed.match(pattern);
      const prompt = match?.[1]?.trim();
      if (prompt) return prompt;
    }

    return null;
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }
      const codexPrompt = extractCodexPrompt(trimmed);
      if (codexPrompt) {
        const group = registeredGroups[chatJid];
        const myPattern = group ? getTriggerPattern(group.trigger) : null;
        const otherPatterns = OTHER_BOT_TRIGGERS.map(buildTriggerPattern);
        const addressesMe = !!myPattern?.test(trimmed);
        const addressesOther = otherPatterns.some((p) => p.test(trimmed));
        const shouldHandleCodex =
          group?.isMain ||
          addressesMe ||
          (!WAIT_FOR_BOT_RESPONSE && !addressesOther);
        if (shouldHandleCodex) {
          handleCodexCommand(`/codex ${codexPrompt}`, chatJid, msg).catch(
            (err) => logger.error({ err, chatJid }, 'Codex command error'),
          );
        }
        return;
      }
      const claudePrompt = extractClaudePrompt(trimmed);
      if (claudePrompt) {
        const group = registeredGroups[chatJid];
        const myPattern = group ? getTriggerPattern(group.trigger) : null;
        const otherPatterns = OTHER_BOT_TRIGGERS.map(buildTriggerPattern);
        const addressesMe = !!myPattern?.test(trimmed);
        const addressesOther = otherPatterns.some((p) => p.test(trimmed));
        const shouldHandleClaude =
          group?.isMain ||
          addressesMe ||
          (!WAIT_FOR_BOT_RESPONSE && !addressesOther);
        if (shouldHandleClaude) {
          handleClaudeCommand(`/claude ${claudePrompt}`, chatJid, msg).catch(
            (err) => logger.error({ err, chatJid }, 'Claude command error'),
          );
        }
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
    syncDashboardState('starting');
  }
  if (channels.length === 0) {
    markRuntimeDashboardStopped('error');
    logger.fatal('No channels connected');
    process.exit(1);
  }

  syncDashboardState('running');
  setInterval(() => syncDashboardState('running'), 1000).unref();

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
  });
  startSessionCleanup();
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    markRuntimeDashboardStopped('error');
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });

  if (CONTROL_PLANE_URL) {
    logger.info(
      'CONTROL_PLANE_URL set — starting embedded control-plane worker',
    );
    startControlPlaneWorker({ embedded: true }).catch((err) => {
      logger.error({ err }, 'Control-plane worker failed');
    });
  }
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    markRuntimeDashboardStopped('error');
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
