/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 * using OpenRouter chat completions directly.
 */

import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

interface ConversationMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface SessionState {
  id: string;
  createdAt: string;
  updatedAt: string;
  messages: ConversationMessage[];
}

interface OpenRouterResponse {
  choices?: Array<{
    message?: {
      content?:
        | string
        | Array<{
            type?: string;
            text?: string;
          }>;
    };
  }>;
  error?: {
    message?: string;
  };
}

const REQUESTED_MODEL = process.env.NANOCLAW_MODEL;
const OPENROUTER_API_KEY = process.env.ANTHROPIC_AUTH_TOKEN;
const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;
const SCRIPT_TIMEOUT_MS = 30_000;
const TOOL_TIMEOUT_MS = 30_000;
const MAX_TOOL_ITERATIONS = 4;
const MAX_TOOL_COMMANDS_PER_TURN = 4;
const GROUP_DIR = '/workspace/group';
const GLOBAL_DIR = '/workspace/global';
const PROJECT_DIR = '/workspace/project';
const COMMON_DIR = '/workspace/common';
const SKILLS_DIR = '/home/node/.claude/skills';
const SESSIONS_DIR = path.join(GROUP_DIR, '.nanoclaw-sessions');
const CONVERSATIONS_DIR = path.join(GROUP_DIR, 'conversations');
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function resolveOpenRouterApiUrl(): string {
  const explicit = process.env.OPENROUTER_API_URL || process.env.OPENROUTER_BASE_URL;
  if (explicit) return explicit;

  const anthropicCompat = process.env.ANTHROPIC_BASE_URL;
  if (anthropicCompat?.includes('/anthropic')) {
    return anthropicCompat.replace(/\/anthropic\/?$/, '/chat/completions');
  }
  if (anthropicCompat?.endsWith('/api/v1')) {
    return `${anthropicCompat}/chat/completions`;
  }

  return 'https://openrouter.ai/api/v1/chat/completions';
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sessionPath(sessionId: string): string {
  ensureDir(SESSIONS_DIR);
  return path.join(SESSIONS_DIR, `${sessionId}.json`);
}

function loadSession(sessionId?: string): SessionState | null {
  if (!sessionId) return null;
  const filePath = sessionPath(sessionId);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as SessionState;
  } catch (err) {
    log(`Failed to load session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function saveSession(session: SessionState): void {
  session.updatedAt = new Date().toISOString();
  fs.writeFileSync(sessionPath(session.id), JSON.stringify(session, null, 2));
}

function readOptionalFile(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const text = fs.readFileSync(filePath, 'utf8').trim();
    return text || null;
  } catch {
    return null;
  }
}

function appendMemoryFile(
  parts: string[],
  label: string,
  baseDir: string,
  filename: string,
): void {
  const content = readOptionalFile(path.join(baseDir, filename));
  if (!content) return;
  parts.push(`${label} (${filename}):`);
  parts.push(content);
}

function readInstalledSkills(): string | null {
  try {
    if (!fs.existsSync(SKILLS_DIR)) return null;
    const skillNames = fs
      .readdirSync(SKILLS_DIR)
      .filter((name) => fs.statSync(path.join(SKILLS_DIR, name)).isDirectory())
      .sort();

    const sections: string[] = [];
    for (const name of skillNames) {
      const skillPath = path.join(SKILLS_DIR, name, 'SKILL.md');
      const content = readOptionalFile(skillPath);
      if (!content) continue;
      sections.push(`## /${name}\n${content.slice(0, 2500)}`);
    }
    return sections.length > 0 ? sections.join('\n\n') : null;
  } catch (err) {
    log(`Failed to read installed skills: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function buildSystemPrompt(containerInput: ContainerInput): string {
  const parts = [
    `You are ${containerInput.assistantName || 'Andy'}, the NanoClaw assistant replying inside a chat.`,
    'Be concise, direct, and helpful.',
    'If the user asks for code or debugging help, focus on actionable technical guidance.',
    'Do not claim to have completed actions you did not actually complete.',
    'Executable commands available in this runtime: agent-browser, github, safe git commands, workspace-list, workspace-read, workspace-write.',
    'For files that should be visible to both Andy and Bob, use /workspace/common. For chat-specific notes, use /workspace/group.',
  ];

  const groupMemory = readOptionalFile(path.join(GROUP_DIR, 'CLAUDE.md'));
  const globalMemory = readOptionalFile(path.join(GLOBAL_DIR, 'CLAUDE.md'));

  if (globalMemory) {
    parts.push('Global memory/context:');
    parts.push(globalMemory);
  }
  if (groupMemory) {
    parts.push('Group-specific memory/context:');
    parts.push(groupMemory);
  }

  appendMemoryFile(parts, 'Global personality memory', GLOBAL_DIR, 'soul.md');
  appendMemoryFile(parts, 'Global user context', GLOBAL_DIR, 'user.md');
  appendMemoryFile(parts, 'Global heartbeat/status context', GLOBAL_DIR, 'heartbeat.md');
  appendMemoryFile(parts, 'Group personality memory', GROUP_DIR, 'soul.md');
  appendMemoryFile(parts, 'Group user context', GROUP_DIR, 'user.md');
  appendMemoryFile(parts, 'Group heartbeat/status context', GROUP_DIR, 'heartbeat.md');

  const installedSkills = readInstalledSkills();
  if (installedSkills) {
    parts.push('Installed skills and usage instructions:');
    parts.push(installedSkills);
  }

  return parts.join('\n\n');
}

function toMarkdownTitle(messages: ConversationMessage[]): string {
  const firstUser = messages.find((message) => message.role === 'user')?.content;
  if (!firstUser) return 'Conversation';
  return firstUser.replace(/\s+/g, ' ').trim().slice(0, 60) || 'Conversation';
}

function archiveConversation(session: SessionState, assistantName?: string): void {
  const visibleMessages = session.messages.filter((message) => message.role !== 'system');
  if (visibleMessages.length === 0) return;

  ensureDir(CONVERSATIONS_DIR);
  const date = new Date().toISOString().split('T')[0];
  const title = toMarkdownTitle(visibleMessages)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'conversation';
  const filePath = path.join(CONVERSATIONS_DIR, `${date}-${title}.md`);

  const lines = [`# ${toMarkdownTitle(visibleMessages)}`, '', `Archived: ${new Date().toISOString()}`, '', '---', ''];
  for (const message of visibleMessages) {
    const sender =
      message.role === 'assistant' ? assistantName || 'Assistant' : 'User';
    lines.push(`**${sender}**: ${message.content}`);
    lines.push('');
  }

  fs.writeFileSync(filePath, lines.join('\n'));
}

function shouldClose(): boolean {
  if (!fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) return false;
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }
  return true;
}

function drainIpcInput(): string[] {
  try {
    ensureDir(IPC_INPUT_DIR);
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((file) => file.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
          type?: string;
          text?: string;
        };
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

function extractResponseText(payload: OpenRouterResponse): string {
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (part.type === 'text' ? part.text || '' : ''))
      .join('')
      .trim();
  }
  const errorMessage = payload.error?.message?.trim();
  if (errorMessage) {
    throw new Error(errorMessage);
  }
  throw new Error('OpenRouter returned no response text');
}

async function queryOpenRouter(
  session: SessionState,
  containerInput: ContainerInput,
): Promise<string> {
  if (!REQUESTED_MODEL) {
    throw new Error('NANOCLAW_MODEL is not configured');
  }
  if (!OPENROUTER_API_KEY) {
    throw new Error('OpenRouter API key is not configured');
  }

  const response = await fetch(resolveOpenRouterApiUrl(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/BrianTruong23/nanoclaw',
      'X-Title': 'NanoClaw',
    },
    body: JSON.stringify({
      model: REQUESTED_MODEL,
      messages: session.messages,
      temperature: 0.2,
    }),
  });

  const text = await response.text();
  let payload: OpenRouterResponse;
  try {
    payload = JSON.parse(text) as OpenRouterResponse;
  } catch {
    throw new Error(`OpenRouter returned non-JSON response (${response.status})`);
  }

  if (!response.ok) {
    throw new Error(
      payload.error?.message?.trim() ||
        `OpenRouter request failed with status ${response.status}`,
    );
  }

  const result = extractResponseText(payload);
  if (!result) {
    throw new Error('OpenRouter returned an empty response');
  }

  log(`OpenRouter reply received (${result.length} chars) for ${containerInput.groupFolder}`);
  return result;
}

async function runScript(script: string): Promise<ScriptResult | null> {
  const scriptPath = '/tmp/task-script.sh';
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise((resolve) => {
    execFile(
      'bash',
      [scriptPath],
      {
        timeout: SCRIPT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: process.env,
      },
      (error, stdout, stderr) => {
        if (stderr) {
          log(`Script stderr: ${stderr.slice(0, 500)}`);
        }
        if (error) {
          log(`Script error: ${error.message}`);
          resolve(null);
          return;
        }

        const lines = stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        if (!lastLine) {
          log('Script produced no output');
          resolve(null);
          return;
        }

        try {
          const result = JSON.parse(lastLine) as ScriptResult;
          if (typeof result.wakeAgent !== 'boolean') {
            log(`Script output missing wakeAgent boolean: ${lastLine.slice(0, 200)}`);
            resolve(null);
            return;
          }
          resolve(result);
        } catch {
          log(`Script output is not valid JSON: ${lastLine.slice(0, 200)}`);
          resolve(null);
        }
      },
    );
  });
}

function shellSplit(command: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const char of command.trim()) {
    if (escaping) {
      if (char === 'n') current += '\n';
      else if (char === 't') current += '\t';
      else if (char === 'r') current += '\r';
      else current += char;
      escaping = false;
      continue;
    }
    if (char === '\\') {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (current) args.push(current);
  return args;
}

function normalizeAgentBrowserArgs(args: string[]): string[] {
  if (args[0] !== 'open' || !args[1]) return args;
  const target = args.slice(1).join(' ').trim();
  if (/^(https?:|about:)/i.test(target)) return ['open', target];
  return ['open', `https://search.brave.com/search?q=${encodeURIComponent(target)}`];
}

function isAllowedGitCommand(args: string[]): boolean {
  const subcommand = args[0];
  if (!subcommand) return false;
  return new Set([
    'add',
    'branch',
    'checkout',
    'clone',
    'commit',
    'diff',
    'fetch',
    'log',
    'merge',
    'pull',
    'push',
    'rebase',
    'remote',
    'revert',
    'stash',
    'status',
  ]).has(subcommand);
}

function isToolCommand(command: string): boolean {
  return /^(agent-browser|git|github|touch|workspace-list|workspace-read|workspace-write|workspace-delete|workspace-rename|workspace-mkdir|workspace-copy|workspace-download)\b/.test(command.trim());
}

function extractToolCommands(reply: string): string[] {
  const commands: string[] = [];
  const seen = new Set<string>();
  const isRunnable = (command: string): boolean => {
    const [executable, ...args] = shellSplit(command);
    if (!executable) return false;
    if (executable === 'workspace-write' || executable === 'workspace-copy' || executable === 'workspace-download') {
      return args.length >= 2 && args.slice(1).join(' ').trim() !== '...';
    }
    if (executable === 'workspace-read' || executable === 'touch' || executable === 'workspace-delete' || executable === 'workspace-mkdir') {
      return args.length >= 1 && args[0] !== '...';
    }
    if (executable === 'workspace-rename') {
      return args.length >= 2;
    }
    if (executable === 'git') return isAllowedGitCommand(args);
    if (executable === 'github') return args.length >= 1;
    return executable === 'agent-browser' || executable === 'workspace-list';
  };
  const add = (raw: string) => {
    const command = raw.trim().replace(/[.;]+$/, '');
    if (!isToolCommand(command)) return;
    if (!isRunnable(command)) return;
    if (seen.has(command)) return;
    seen.add(command);
    commands.push(command);
  };

  for (const match of reply.matchAll(/`((?:agent-browser|git|github|touch|workspace-list|workspace-read|workspace-write|workspace-delete|workspace-rename|workspace-mkdir|workspace-copy|workspace-download)(?:\s+[^`]+)?)`/g)) {
    add(match[1] || '');
  }

  for (const line of reply.split('\n')) {
    const trimmed = line.trim().replace(/^[$>]\s*/, '');
    if (isToolCommand(trimmed)) add(trimmed);
  }

  return commands.slice(0, MAX_TOOL_COMMANDS_PER_TURN);
}

function commandCwd(): string {
  return fs.existsSync(PROJECT_DIR) ? PROJECT_DIR : GROUP_DIR;
}

function gitEnv(): NodeJS.ProcessEnv {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
  };
  if (!token) return env;

  const askPassPath = '/tmp/nanoclaw-git-askpass.sh';
  fs.writeFileSync(
    askPassPath,
    '#!/bin/sh\ncase "$1" in\n*Username*) printf "%s\\n" "x-access-token" ;;\n*) printf "%s\\n" "$GITHUB_TOKEN" ;;\nesac\n',
    { mode: 0o700 },
  );
  env.GIT_ASKPASS = askPassPath;
  env.GITHUB_TOKEN = token;
  env.GH_TOKEN = token;
  return env;
}

async function execCommand(
  executable: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      executable,
      args,
      {
        cwd: options?.cwd,
        env: options?.env || process.env,
        timeout: options?.timeoutMs || TOOL_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const output = [
          stdout.trim() ? `stdout:\n${stdout.trim()}` : '',
          stderr.trim() ? `stderr:\n${stderr.trim()}` : '',
          error ? `error:\n${error.message}` : '',
        ]
          .filter(Boolean)
          .join('\n\n');
        resolve(output || 'Command completed with no output.');
      },
    );
  });
}

async function runGithubPseudoCommand(args: string[]): Promise<string> {
  const action = args[0] || 'status';
  if (action === 'status') {
    const [status, remote, branch] = await Promise.all([
      execCommand('git', ['status', '--short', '--branch'], {
        cwd: commandCwd(),
        env: gitEnv(),
      }),
      execCommand('git', ['remote', '-v'], { cwd: commandCwd(), env: gitEnv() }),
      execCommand('git', ['branch', '--show-current'], {
        cwd: commandCwd(),
        env: gitEnv(),
      }),
    ]);
    return [`git status:\n${status}`, `git remote:\n${remote}`, `branch:\n${branch}`].join('\n\n');
  }
  if (action === 'push') {
    const branch = args[1];
    const pushArgs = branch ? ['push', 'origin', branch] : ['push'];
    return execCommand('git', pushArgs, { cwd: commandCwd(), env: gitEnv(), timeoutMs: 120_000 });
  }
  if (action === 'whoami') {
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (!token) return 'No GITHUB_TOKEN/GH_TOKEN is available.';
    const response = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'NanoClaw',
      },
    });
    const text = await response.text();
    return `GitHub API status ${response.status}\n${text.slice(0, 4000)}`;
  }
  return `Unsupported github command: ${['github', ...args].join(' ')}. Supported: github status, github push [branch], github whoami.`;
}

function resolveWorkspacePath(inputPath: string, defaultBase = COMMON_DIR): string {
  const requested = inputPath || '.';
  const base = requested.startsWith('/workspace/group')
    ? GROUP_DIR
    : requested.startsWith('/workspace/common')
      ? COMMON_DIR
      : defaultBase;
  const fullPath = path.resolve(
    base,
    requested.startsWith('/workspace/group')
      ? path.relative(GROUP_DIR, requested)
      : requested.startsWith('/workspace/common')
        ? path.relative(COMMON_DIR, requested)
        : requested,
  );
  const rel = path.relative(base, fullPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${inputPath}`);
  }
  return fullPath;
}

async function runWorkspaceCommand(command: string, args: string[]): Promise<string> {
  try {
    if (command === 'touch') {
      const target = args[0];
      if (!target) return 'Usage: touch <path>';
      const filePath = resolveWorkspacePath(target, COMMON_DIR);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.closeSync(fs.openSync(filePath, 'a'));
      return `Touched ${filePath}`;
    }
    if (command === 'workspace-list') {
      const dir = resolveWorkspacePath(args[0] || '.', COMMON_DIR);
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      return entries
        .map((entry) => `${entry.isDirectory() ? 'dir ' : 'file'} ${entry.name}`)
        .join('\n') || 'Workspace directory is empty.';
    }
    if (command === 'workspace-read') {
      const filePath = resolveWorkspacePath(args[0] || '', COMMON_DIR);
      return fs.readFileSync(filePath, 'utf8').slice(0, 20_000);
    }
    if (command === 'workspace-write') {
      const target = args[0];
      const content = args.slice(1).join(' ');
      if (!target) return 'Usage: workspace-write <path> <content>';
      const filePath = resolveWorkspacePath(target, COMMON_DIR);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content.endsWith('\n') ? content : `${content}\n`);
      return `Wrote ${Buffer.byteLength(content)} bytes to ${filePath}`;
    }
    if (command === 'workspace-delete') {
      const target = args[0];
      if (!target) return 'Usage: workspace-delete <path>';
      const filePath = resolveWorkspacePath(target, COMMON_DIR);
      if (!fs.existsSync(filePath)) return `File not found: ${filePath}`;
      fs.unlinkSync(filePath);
      return `Deleted ${filePath}`;
    }
    if (command === 'workspace-rename') {
      const src = args[0];
      const dest = args[1];
      if (!src || !dest) return 'Usage: workspace-rename <old_path> <new_path>';
      const srcPath = resolveWorkspacePath(src, COMMON_DIR);
      const destPath = resolveWorkspacePath(dest, COMMON_DIR);
      if (!fs.existsSync(srcPath)) return `File not found: ${srcPath}`;
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.renameSync(srcPath, destPath);
      return `Renamed ${srcPath} to ${destPath}`;
    }
    if (command === 'workspace-mkdir') {
      const target = args[0];
      if (!target) return 'Usage: workspace-mkdir <path>';
      const dirPath = resolveWorkspacePath(target, COMMON_DIR);
      fs.mkdirSync(dirPath, { recursive: true });
      return `Created directory ${dirPath}`;
    }
    if (command === 'workspace-copy') {
      const src = args[0];
      const dest = args[1];
      if (!src || !dest) return 'Usage: workspace-copy <src_path> <dest_path>';
      const srcPath = resolveWorkspacePath(src, COMMON_DIR);
      const destPath = resolveWorkspacePath(dest, COMMON_DIR);
      if (!fs.existsSync(srcPath)) return `File or directory not found: ${srcPath}`;
      fs.cpSync(srcPath, destPath, { recursive: true });
      return `Copied ${srcPath} to ${destPath}`;
    }
    if (command === 'workspace-download') {
      const url = args[0];
      const target = args[1];
      if (!url || !target) return 'Usage: workspace-download <url> <filename>';
      const destPath = resolveWorkspacePath(target, COMMON_DIR);
      try {
        const response = await fetch(url);
        if (!response.ok) return `Download failed: HTTP ${response.status} ${response.statusText}`;
        const buffer = await response.arrayBuffer();
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.writeFileSync(destPath, Buffer.from(buffer));
        return `Downloaded ${buffer.byteLength} bytes from ${url} to ${destPath}`;
      } catch (err) {
        return `Failed to download ${url}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  } catch (err) {
    return `Workspace command failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  return `Unsupported workspace command: ${command}`;
}

async function runToolCommand(command: string): Promise<string> {
  const parts = shellSplit(command);
  const executable = parts[0];
  const args = parts.slice(1);
  if (executable === 'agent-browser') {
    return execCommand('agent-browser', normalizeAgentBrowserArgs(args));
  }
  if (executable === 'git') {
    if (!isAllowedGitCommand(args)) {
      return `Skipped unsupported git command: ${command}`;
    }
    const timeoutMs = args[0] === 'push' || args[0] === 'pull' || args[0] === 'fetch' || args[0] === 'clone' ? 120_000 : TOOL_TIMEOUT_MS;
    return execCommand('git', args, { cwd: commandCwd(), env: gitEnv(), timeoutMs });
  }
  if (executable === 'github') {
    return runGithubPseudoCommand(args);
  }
  if (executable === 'touch' || executable === 'workspace-list' || executable === 'workspace-read' || executable === 'workspace-write' || executable === 'workspace-delete' || executable === 'workspace-rename' || executable === 'workspace-mkdir' || executable === 'workspace-copy' || executable === 'workspace-download') {
    return runWorkspaceCommand(executable, args);
  }
  return `Skipped unsupported command: ${command}`;
}

async function runToolCommands(commands: string[]): Promise<string> {
  const results: string[] = [];
  for (const command of commands) {
    log(`Running tool command: ${command}`);
    const output = await runToolCommand(command);
    results.push(`$ ${command}\n${output}`);
  }
  return results.join('\n\n---\n\n');
}

async function runTurn(
  prompt: string,
  session: SessionState,
  containerInput: ContainerInput,
): Promise<string> {
  session.messages.push({ role: 'user', content: prompt });

  let reply = '';
  for (let iteration = 0; iteration <= MAX_TOOL_ITERATIONS; iteration++) {
    reply = await queryOpenRouter(session, containerInput);
    const commands = extractToolCommands(reply);
    if (commands.length === 0 || iteration === MAX_TOOL_ITERATIONS) {
      session.messages.push({ role: 'assistant', content: reply });
      break;
    }

    session.messages.push({ role: 'assistant', content: reply });
    const toolResults = await runToolCommands(commands);
    session.messages.push({
      role: 'user',
      content:
        `[Tool results from executed commands]\n\n${toolResults}\n\n` +
        'Use these results to answer the user directly. Do not print tool commands unless you still need another tool action.',
    });
  }

  saveSession(session);
  return reply;
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData) as ContainerInput;
    try {
      fs.unlinkSync('/tmp/input.json');
    } catch {
      /* ignore */
    }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
    return;
  }

  ensureDir(IPC_INPUT_DIR);
  ensureDir(SESSIONS_DIR);

  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }

  let session =
    loadSession(containerInput.sessionId) || {
      id: containerInput.sessionId || randomUUID(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [
        {
          role: 'system',
          content: buildSystemPrompt(containerInput),
        },
      ],
    };
  const systemPrompt = buildSystemPrompt(containerInput);
  if (session.messages[0]?.role === 'system') {
    session.messages[0].content = systemPrompt;
  } else {
    session.messages.unshift({ role: 'system', content: systemPrompt });
  }

  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }

  const pending = drainIpcInput();
  if (pending.length > 0) {
    prompt += '\n' + pending.join('\n');
  }

  if (containerInput.script && containerInput.isScheduledTask) {
    log('Running task script...');
    const scriptResult = await runScript(containerInput.script);
    if (!scriptResult || !scriptResult.wakeAgent) {
      writeOutput({
        status: 'success',
        result: null,
        newSessionId: session.id,
      });
      return;
    }
    prompt = `[SCHEDULED TASK]\n\nScript output:\n${JSON.stringify(scriptResult.data, null, 2)}\n\nInstructions:\n${containerInput.prompt}`;
  }

  try {
    while (true) {
      log(`Starting OpenRouter turn for session ${session.id}`);
      const reply = await runTurn(prompt, session, containerInput);
      writeOutput({
        status: 'success',
        result: reply,
        newSessionId: session.id,
      });

      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, archiving conversation and exiting');
        archiveConversation(session, containerInput.assistantName);
        break;
      }

      prompt = nextMessage;
      log(`Received follow-up IPC message (${prompt.length} chars)`);
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: session.id,
      error: errorMessage,
    });
    process.exit(1);
  }
}

main();
