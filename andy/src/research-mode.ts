/**
 * Research-style routing (used only in multi-user group chats, not DMs):
 *
 * All messages route to **verify** mode. The `/verify` and `/collaborate`
 * slash commands are still accepted (they strip the prefix) but both resolve
 * to verify. Per-bot @mentions / group triggers are unchanged in the router.
 *
 * This is intentionally lightweight pattern matching, not an LLM classifier.
 */
export type ResearchMode = 'verify';

export type ResearchModeSource = 'command' | 'classifier';

export interface ResearchModeDecision {
  mode: ResearchMode;
  source: ResearchModeSource;
  cleanedContent: string;
}

const COMMAND_PATTERNS: RegExp[] = [
  /^\/verify\b[:\s-]*/i,
  /^\/(?:col|collab|collaborate)\b[:\s-]*/i,
];

export function classifyResearchMode(content: string): ResearchModeDecision {
  const trimmed = content.trim();

  for (const pattern of COMMAND_PATTERNS) {
    if (pattern.test(trimmed)) {
      const cleanedContent = trimmed.replace(pattern, '').trim();
      return {
        mode: 'verify',
        source: 'command',
        cleanedContent: cleanedContent || trimmed,
      };
    }
  }

  return {
    mode: 'verify',
    source: 'classifier',
    cleanedContent: trimmed,
  };
}

export function isResearchModeCommand(content: string): boolean {
  const trimmed = content.trim();
  return COMMAND_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function shouldAgentRunForResearchMode(
  _mode: ResearchMode,
  _waitForBotResponse: boolean,
): boolean {
  return true;
}

/**
 * Short line posted to the group before this bot's container reply, so users see
 * how the classifier (or slash command) routed the turn.
 */
export function formatResearchModeUserNotice(
  decision: ResearchModeDecision,
  assistantName: string,
  waitForBotResponse: boolean,
): string {
  const srcLabel =
    decision.source === 'command' ? 'slash command' : 'auto';
  const roleHint = waitForBotResponse
    ? `${assistantName} = secondary (verifier)`
    : `${assistantName} = primary (does the work)`;
  return `⏵ **verify** (${srcLabel}) · ${roleHint}`;
}

export function buildResearchModePrompt(
  formattedMessages: string,
  decision: ResearchModeDecision,
  assistantName: string,
  waitForBotResponse: boolean,
): string {
  const isSecondary = waitForBotResponse;
  const roleInstruction = getRoleInstruction(assistantName, isSecondary);

  return [
    `<research_group_mode mode="verify" selected_by="${decision.source}">`,
    `Current user request, with any routing command removed: ${decision.cleanedContent}`,
    roleInstruction,
    '</research_group_mode>',
    '',
    formattedMessages,
  ].join('\n');
}

function getRoleInstruction(
  assistantName: string,
  isSecondary: boolean,
): string {
  if (isSecondary) {
    return [
      `${assistantName}: verify the primary assistant's last answer only — do not redo their work or summarize their plan.`,
      'If it looks correct for the user request, reply in **at most 2 short sentences** (or ~400 characters): confirm + any critical caveat only.',
      'If something is materially wrong, or a tool failed (git, workspace, etc.), start with `@Andy` (or the primary name in this chat) and state what broke in plain language so the primary can do one more fix pass; after that follow-up, accept the result as final for this turn.',
      'Do not re-read files the primary assistant already quoted unless you dispute a specific claim; do not propose new "next steps" unless fixing an error.',
    ].join(' ');
  }

  return [
    `${assistantName}: you are the primary assistant — carry the user request through to completion (branch, reads, edits, **commit + push**) before stopping.`,
    'After substantive edits under /workspace/common: `git add`, `git commit -m "..."`, then `github push` with the correct repo path — treat that as part of "done" unless the user explicitly asked not to push.',
    'Use tools until the job is done, not after one file preview: if the user named paths under /workspace/common, use github/git with those paths or the single shared clone auto-target.',
    'Do not stop on the first clarifying question unless you are truly blocked; prefer sensible defaults and continue.',
    'Keep the reply complete enough that the secondary assistant can verify in a short note.',
  ].join(' ');
}
