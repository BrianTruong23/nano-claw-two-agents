/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 * using OpenRouter chat completions directly.
 */
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
const REQUESTED_MODEL = process.env.NANOCLAW_MODEL;
const OPENROUTER_API_KEY = process.env.ANTHROPIC_AUTH_TOKEN;
const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;
const SCRIPT_TIMEOUT_MS = 30_000;
const TOOL_TIMEOUT_MS = 30_000;
/** Max (model reply → execute parsed tools) cycles before forcing a plain-language wrap-up. */
const MAX_TOOL_ROUNDS = 20;
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
function writeOutput(output) {
    console.log(OUTPUT_START_MARKER);
    console.log(JSON.stringify(output));
    console.log(OUTPUT_END_MARKER);
}
function log(message) {
    console.error(`[agent-runner] ${message}`);
}
async function readStdin() {
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
function resolveOpenRouterApiUrl() {
    const explicit = process.env.OPENROUTER_API_URL || process.env.OPENROUTER_BASE_URL;
    if (explicit)
        return explicit;
    const anthropicCompat = process.env.ANTHROPIC_BASE_URL;
    if (anthropicCompat?.includes('/anthropic')) {
        return anthropicCompat.replace(/\/anthropic\/?$/, '/chat/completions');
    }
    if (anthropicCompat?.endsWith('/api/v1')) {
        return `${anthropicCompat}/chat/completions`;
    }
    return 'https://openrouter.ai/api/v1/chat/completions';
}
function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}
function sessionPath(sessionId) {
    ensureDir(SESSIONS_DIR);
    return path.join(SESSIONS_DIR, `${sessionId}.json`);
}
function loadSession(sessionId) {
    if (!sessionId)
        return null;
    const filePath = sessionPath(sessionId);
    if (!fs.existsSync(filePath))
        return null;
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
    catch (err) {
        log(`Failed to load session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
}
function saveSession(session) {
    session.updatedAt = new Date().toISOString();
    fs.writeFileSync(sessionPath(session.id), JSON.stringify(session, null, 2));
}
function readOptionalFile(filePath) {
    try {
        if (!fs.existsSync(filePath))
            return null;
        const text = fs.readFileSync(filePath, 'utf8').trim();
        return text || null;
    }
    catch {
        return null;
    }
}
function appendMemoryFile(parts, label, baseDir, filename) {
    const content = readOptionalFile(path.join(baseDir, filename));
    if (!content)
        return;
    parts.push(`${label} (${filename}):`);
    parts.push(content);
}
function readInstalledSkills() {
    try {
        if (!fs.existsSync(SKILLS_DIR))
            return null;
        const skillNames = fs
            .readdirSync(SKILLS_DIR)
            .filter((name) => fs.statSync(path.join(SKILLS_DIR, name)).isDirectory())
            .sort();
        const sections = [];
        for (const name of skillNames) {
            const skillPath = path.join(SKILLS_DIR, name, 'SKILL.md');
            const content = readOptionalFile(skillPath);
            if (!content)
                continue;
            sections.push(`## /${name}\n${content.slice(0, 2500)}`);
        }
        return sections.length > 0 ? sections.join('\n\n') : null;
    }
    catch (err) {
        log(`Failed to read installed skills: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
}
function buildSystemPrompt(containerInput) {
    const parts = [
        `You are ${containerInput.assistantName || 'Andy'}, the NanoClaw assistant replying inside a chat.`,
        'Be direct and helpful. Once a task is done, summarize concisely; while work is in progress, prioritize finishing (reads/edits/git) over stopping early for brevity.',
        'If the user asks for code or debugging help, focus on actionable technical guidance.',
        'Do not claim to have completed actions you did not actually complete. If a tool failed, say so and quote stderr from the tool results.',
        'Tools only run when you emit a whole line or single-backtick line starting with an allowed command (see below). Prose alone does not run anything.',
        'Executable commands: agent-browser, github, safe git commands, workspace-git-clone, workspace-git-status, workspace-list, workspace-read, workspace-write, workspace-delete, workspace-rename, workspace-mkdir, workspace-copy, workspace-download, touch.',
        'Shared Andy/Bob files live under /workspace/common. Prefer `workspace-git-clone <url>` or `workspace-git-clone <url> <folder_name>` so the clone runs with cwd=/workspace/common (no path mistakes).',
        'Plain `git clone <url>` runs with cwd=/workspace/project (NanoClaw app tree), not common — only use it when you mean the project mount, or pass an explicit destination: `git clone <url> /workspace/common/<dir>`.',
        'For git inside a clone under /workspace/common, use `git -C /workspace/common/<dir> <subcommand> …` (same whitelist as plain git). Plain `git status` without `-C` uses /workspace/project or /workspace/group, not the clone.',
        'For shared clones, `github status /workspace/common/<dir>` and `github push [branch] /workspace/common/<dir>` run git in that repo (path must contain a .git directory). Plain `github status` is only for the project mount.',
        'If there is exactly one git checkout directly under /workspace/common, plain git (except clone) without `-C`, and `github status` / `github push` without a path, run in that checkout when the project mount is not a repo. With several clones, pass explicit paths or use `git -C`.',
        'For chat-specific notes, use /workspace/group.',
        'Multi-step jobs (UI refactors, repo changes, etc.): keep emitting whole-line tool commands each turn until the user\'s outcome is actually done — not after a plan or one or two file peeks. If more files or edits remain, your next reply must include more tools, not only prose.',
        'When you change files in a clone under /workspace/common, finish with git add → git commit → github push (correct repo path) unless the user said not to push. Commits use GIT_AUTHOR_* from the environment (set NANOCLAW_GIT_AUTHOR_NAME / NANOCLAW_GIT_AUTHOR_EMAIL on the host, or defaults apply) — you do not need `git config` for author unless overriding.',
        'Staging: use `git add -A` or explicit paths from `git status` output; bare `git add` with no paths does nothing.',
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
function toMarkdownTitle(messages) {
    const firstUser = messages.find((message) => message.role === 'user')?.content;
    if (!firstUser)
        return 'Conversation';
    return firstUser.replace(/\s+/g, ' ').trim().slice(0, 60) || 'Conversation';
}
function archiveConversation(session, assistantName) {
    const visibleMessages = session.messages.filter((message) => message.role !== 'system');
    if (visibleMessages.length === 0)
        return;
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
        const sender = message.role === 'assistant' ? assistantName || 'Assistant' : 'User';
        lines.push(`**${sender}**: ${message.content}`);
        lines.push('');
    }
    fs.writeFileSync(filePath, lines.join('\n'));
}
function shouldClose() {
    if (!fs.existsSync(IPC_INPUT_CLOSE_SENTINEL))
        return false;
    try {
        fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    }
    catch {
        /* ignore */
    }
    return true;
}
function drainIpcInput() {
    try {
        ensureDir(IPC_INPUT_DIR);
        const files = fs
            .readdirSync(IPC_INPUT_DIR)
            .filter((file) => file.endsWith('.json'))
            .sort();
        const messages = [];
        for (const file of files) {
            const filePath = path.join(IPC_INPUT_DIR, file);
            try {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                fs.unlinkSync(filePath);
                if (data.type === 'message' && data.text) {
                    messages.push(data.text);
                }
            }
            catch (err) {
                log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
                try {
                    fs.unlinkSync(filePath);
                }
                catch {
                    /* ignore */
                }
            }
        }
        return messages;
    }
    catch (err) {
        log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
        return [];
    }
}
function waitForIpcMessage() {
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
function extractResponseText(payload) {
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content === 'string')
        return content.trim();
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
async function queryOpenRouter(session, containerInput) {
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
    let payload;
    try {
        payload = JSON.parse(text);
    }
    catch {
        throw new Error(`OpenRouter returned non-JSON response (${response.status})`);
    }
    if (!response.ok) {
        throw new Error(payload.error?.message?.trim() ||
            `OpenRouter request failed with status ${response.status}`);
    }
    const result = extractResponseText(payload);
    if (!result) {
        throw new Error('OpenRouter returned an empty response');
    }
    log(`OpenRouter reply received (${result.length} chars) for ${containerInput.groupFolder}`);
    return result;
}
async function runScript(script) {
    const scriptPath = '/tmp/task-script.sh';
    fs.writeFileSync(scriptPath, script, { mode: 0o755 });
    return new Promise((resolve) => {
        execFile('bash', [scriptPath], {
            timeout: SCRIPT_TIMEOUT_MS,
            maxBuffer: 1024 * 1024,
            env: process.env,
        }, (error, stdout, stderr) => {
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
                const result = JSON.parse(lastLine);
                if (typeof result.wakeAgent !== 'boolean') {
                    log(`Script output missing wakeAgent boolean: ${lastLine.slice(0, 200)}`);
                    resolve(null);
                    return;
                }
                resolve(result);
            }
            catch {
                log(`Script output is not valid JSON: ${lastLine.slice(0, 200)}`);
                resolve(null);
            }
        });
    });
}
function shellSplit(command) {
    const args = [];
    let current = '';
    let quote = null;
    let escaping = false;
    for (const char of command.trim()) {
        if (escaping) {
            if (char === 'n')
                current += '\n';
            else if (char === 't')
                current += '\t';
            else if (char === 'r')
                current += '\r';
            else
                current += char;
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
            }
            else {
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
    if (current)
        args.push(current);
    return args;
}
function normalizeAgentBrowserArgs(args) {
    if (args[0] !== 'open' || !args[1])
        return args;
    const target = args.slice(1).join(' ').trim();
    if (/^(https?:|about:)/i.test(target))
        return ['open', target];
    return ['open', `https://search.brave.com/search?q=${encodeURIComponent(target)}`];
}
const ALLOWED_GIT_SUBCOMMANDS = new Set([
    'add',
    'branch',
    'checkout',
    'clone',
    'commit',
    'config',
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
]);
/** Only user.name / user.email; optional --local or --global before the key. */
function isSafeGitConfigArgs(parts) {
    const idx = parts.indexOf('config');
    if (idx === -1)
        return false;
    const after = parts.slice(idx + 1);
    let i = 0;
    while (i < after.length && after[i].startsWith('--')) {
        const flag = after[i];
        if (flag === '--local' || flag === '--global') {
            i += 1;
            continue;
        }
        return false;
    }
    if (i >= after.length)
        return false;
    const key = after[i];
    if (key !== 'user.name' && key !== 'user.email')
        return false;
    return after.length >= i + 2 && Boolean(after[i + 1]);
}
function isPathUnderWorkspaceCommon(resolvedPath) {
    const root = path.resolve(COMMON_DIR);
    const p = path.resolve(resolvedPath);
    return p === root || p.startsWith(`${root}${path.sep}`);
}
/** Resolve git -C target: absolute paths normalized; relative paths only under /workspace/common. */
function resolveGitCommonCDirectory(rawPath) {
    if (!rawPath || rawPath === '...')
        return null;
    const candidate = path.isAbsolute(rawPath)
        ? path.resolve(rawPath)
        : path.resolve(COMMON_DIR, rawPath);
    if (!isPathUnderWorkspaceCommon(candidate))
        return null;
    return candidate;
}
/** Directory under /workspace/common that contains a .git entry (repo root). */
function resolveCommonGitWorktree(token) {
    const resolved = resolveGitCommonCDirectory(token);
    if (!resolved)
        return null;
    try {
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory())
            return null;
        const gitEntry = path.join(resolved, '.git');
        if (!fs.existsSync(gitEntry))
            return null;
    }
    catch {
        return null;
    }
    return resolved;
}
function isGitWorktree(dir) {
    try {
        return fs.existsSync(path.join(dir, '.git'));
    }
    catch {
        return false;
    }
}
/** Immediate child directories of /workspace/common that are git checkouts. */
function listGitReposUnderCommon() {
    ensureDir(COMMON_DIR);
    const out = [];
    for (const name of fs.readdirSync(COMMON_DIR)) {
        if (name.startsWith('.'))
            continue;
        const p = path.join(COMMON_DIR, name);
        try {
            if (fs.statSync(p).isDirectory() && isGitWorktree(p)) {
                out.push(p);
            }
        }
        catch {
            /* ignore */
        }
    }
    return out.sort();
}
/** Canonicalize -C so Git does not resolve a relative path against /workspace/project. */
function normalizeGitArgsForCommonC(args) {
    if (args.length < 3 || args[0] !== '-C' || !args[1])
        return args;
    const resolved = resolveGitCommonCDirectory(args[1]);
    if (!resolved)
        return args;
    return ['-C', resolved, ...args.slice(2)];
}
function gitSubcommandForTimeout(args) {
    if (args.length >= 3 && args[0] === '-C' && args[2])
        return args[2];
    return args[0] || '';
}
/**
 * Make common non-interactive git mistakes recoverable so turns can complete.
 * We still keep validation as a safety net after normalization.
 */
function normalizeGitInvocation(argv) {
    const out = [...argv];
    const notes = [];
    const addIdx = out.indexOf('add');
    if (addIdx !== -1) {
        const tail = out.slice(addIdx + 1);
        const hasPathspec = tail.some((t) => t === '-A' ||
            t === '--all' ||
            t === '-u' ||
            t === '--update' ||
            t === '.' ||
            (!t.startsWith('-') && t !== '--'));
        if (!hasPathspec) {
            out.splice(addIdx + 1, tail.length, '-A');
            notes.push('auto-corrected `git add` to `git add -A`.');
        }
    }
    const commitIdx = out.indexOf('commit');
    if (commitIdx !== -1) {
        const tail = out.slice(commitIdx + 1);
        const joined = ` ${tail.join(' ')} `;
        const hasMessage = /\s-m(\s|=)/.test(joined) ||
            /\s-F(\s|=)/.test(joined) ||
            /--message=/.test(joined) ||
            /--file=/.test(joined) ||
            /-m[^\s=]/.test(tail.join(' ')) ||
            /\s-am(\s|$)/.test(joined) ||
            /--no-edit\b/.test(joined);
        if (!hasMessage) {
            out.push('-m', 'chore: apply requested updates');
            notes.push('auto-added a default commit message for non-interactive git.');
        }
    }
    return { argv: out, notes };
}
/** Block bare `git add` / flags-only add (no -A / paths). */
function validateGitAddInvocation(argv) {
    const idx = argv.indexOf('add');
    if (idx === -1)
        return null;
    const tail = argv.slice(idx + 1);
    if (tail.length === 0) {
        return 'git add: no pathspec. Use `git add -A` or `git -C /workspace/common/<repo> add -A`, or list explicit files.';
    }
    const hasPathspec = tail.some((t) => t === '-A' ||
        t === '--all' ||
        t === '-u' ||
        t === '--update' ||
        t === '.' ||
        (!t.startsWith('-') && t !== '--'));
    if (hasPathspec)
        return null;
    return 'git add: no pathspec after flags. Use `git add -A` or name specific files.';
}
/** Block `git commit` without -m / -F / --no-edit (no editor in container). */
function validateGitCommitInvocation(argv) {
    const idx = argv.indexOf('commit');
    if (idx === -1)
        return null;
    const tail = argv.slice(idx + 1);
    const joined = ` ${tail.join(' ')} `;
    if (/\s-m(\s|=)/.test(joined) || /\s-F(\s|=)/.test(joined))
        return null;
    if (/--message=/.test(joined) || /--file=/.test(joined))
        return null;
    if (/-m[^\s=]/.test(tail.join(' ')))
        return null;
    if (/\s-am(\s|$)/.test(joined))
        return null;
    if (/--no-edit\b/.test(joined))
        return null;
    return ('git commit: no editor in this environment — use `git commit -m "your message"` ' +
        '(or `git -C /workspace/common/<repo> commit -m "..."`).');
}
function isAllowedGitCommand(args) {
    if (args.length >= 3 && args[0] === '-C') {
        const resolved = resolveGitCommonCDirectory(args[1] || '');
        if (!resolved)
            return false;
        const sub = args[2];
        if (!sub)
            return false;
        if (sub === 'config')
            return isSafeGitConfigArgs(args);
        return ALLOWED_GIT_SUBCOMMANDS.has(sub);
    }
    const subcommand = args[0];
    if (!subcommand)
        return false;
    if (subcommand === 'config')
        return isSafeGitConfigArgs(args);
    return ALLOWED_GIT_SUBCOMMANDS.has(subcommand);
}
function isToolCommand(command) {
    return /^(agent-browser|git|github|touch|workspace-list|workspace-read|workspace-write|workspace-delete|workspace-rename|workspace-mkdir|workspace-copy|workspace-download|workspace-git-clone|workspace-git-status)\b/.test(command.trim());
}
function extractToolCommands(reply) {
    const commands = [];
    const seen = new Set();
    const isRunnable = (command) => {
        const [executable, ...args] = shellSplit(command);
        if (!executable)
            return false;
        if (executable === 'workspace-write' || executable === 'workspace-copy' || executable === 'workspace-download') {
            return args.length >= 2 && args.slice(1).join(' ').trim() !== '...';
        }
        if (executable === 'workspace-read' || executable === 'touch' || executable === 'workspace-delete' || executable === 'workspace-mkdir') {
            return args.length >= 1 && args[0] !== '...';
        }
        if (executable === 'workspace-rename') {
            return args.length >= 2;
        }
        if (executable === 'git')
            return isAllowedGitCommand(args);
        if (executable === 'github')
            return args.length >= 1;
        if (executable === 'workspace-git-clone') {
            return Boolean(args[0] && args[0] !== '...');
        }
        if (executable === 'workspace-git-status')
            return true;
        return executable === 'agent-browser' || executable === 'workspace-list';
    };
    const add = (raw) => {
        const command = raw.trim().replace(/[.;]+$/, '');
        if (!isToolCommand(command))
            return;
        if (!isRunnable(command))
            return;
        if (seen.has(command))
            return;
        seen.add(command);
        commands.push(command);
    };
    for (const match of reply.matchAll(/`((?:agent-browser|git|github|touch|workspace-list|workspace-read|workspace-write|workspace-delete|workspace-rename|workspace-mkdir|workspace-copy|workspace-download|workspace-git-clone|workspace-git-status)(?:\s+[^`]+)?)`/g)) {
        add(match[1] || '');
    }
    for (const line of reply.split('\n')) {
        const trimmed = line.trim().replace(/^[$>]\s*/, '');
        if (isToolCommand(trimmed))
            add(trimmed);
    }
    return commands.slice(0, MAX_TOOL_COMMANDS_PER_TURN);
}
function commandCwd() {
    return fs.existsSync(PROJECT_DIR) ? PROJECT_DIR : GROUP_DIR;
}
/**
 * Default exec cwd for git/github is project or group mount — usually not the clone under
 * /workspace/common. When that cwd is not a git repo, use the only checkout under common if unambiguous.
 */
function resolveFallbackGitWorktreeCwd() {
    const cwd = commandCwd();
    if (isGitWorktree(cwd))
        return { cwd };
    const repos = listGitReposUnderCommon();
    if (repos.length === 1)
        return { cwd: repos[0] };
    if (repos.length > 1) {
        return {
            cwd,
            blocked: `Git would run in ${cwd}, which is not a git repository. Multiple clones under /workspace/common — pick one:\n` +
                `${repos.map((p) => `- github status ${p}`).join('\n')}\n` +
                `- or: workspace-git-status <folder>\n` +
                `- or: git -C /workspace/common/<folder> <command>…`,
        };
    }
    return {
        cwd,
        blocked: `Git would run in ${cwd}, which is not a git repository, and /workspace/common has no git checkout. ` +
            `Clone with workspace-git-clone, then use github status /workspace/common/<dir> or workspace-git-status <dir>.`,
    };
}
function gitEnv() {
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    const authorName = process.env.NANOCLAW_GIT_AUTHOR_NAME?.trim() ||
        process.env.GIT_AUTHOR_NAME?.trim() ||
        'NanoClaw Agent';
    const authorEmail = process.env.NANOCLAW_GIT_AUTHOR_EMAIL?.trim() ||
        process.env.GIT_AUTHOR_EMAIL?.trim() ||
        'nanoclaw@localhost';
    const env = {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_AUTHOR_NAME: authorName,
        GIT_COMMITTER_NAME: authorName,
        GIT_AUTHOR_EMAIL: authorEmail,
        GIT_COMMITTER_EMAIL: authorEmail,
        GIT_EDITOR: ':',
        EDITOR: ':',
        VISUAL: ':',
    };
    if (!token)
        return env;
    const askPassPath = '/tmp/nanoclaw-git-askpass.sh';
    fs.writeFileSync(askPassPath, '#!/bin/sh\ncase "$1" in\n*Username*) printf "%s\\n" "x-access-token" ;;\n*) printf "%s\\n" "$GITHUB_TOKEN" ;;\nesac\n', { mode: 0o700 });
    env.GIT_ASKPASS = askPassPath;
    env.GITHUB_TOKEN = token;
    env.GH_TOKEN = token;
    return env;
}
async function execCommand(executable, args, options) {
    return new Promise((resolve) => {
        execFile(executable, args, {
            cwd: options?.cwd,
            env: options?.env || process.env,
            timeout: options?.timeoutMs || TOOL_TIMEOUT_MS,
            maxBuffer: 1024 * 1024,
        }, (error, stdout, stderr) => {
            const output = [
                stdout.trim() ? `stdout:\n${stdout.trim()}` : '',
                stderr.trim() ? `stderr:\n${stderr.trim()}` : '',
                error ? `error:\n${error.message}` : '',
            ]
                .filter(Boolean)
                .join('\n\n');
            resolve(output || 'Command completed with no output.');
        });
    });
}
async function buildGitOutcomeSnapshot(cwd) {
    const env = gitEnv();
    const [status, branch, head, aheadBehind] = await Promise.all([
        execCommand('git', ['status', '--short', '--branch'], { cwd, env }),
        execCommand('git', ['branch', '--show-current'], { cwd, env }),
        execCommand('git', ['log', '-1', '--oneline'], { cwd, env }),
        execCommand('git', ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], { cwd, env }),
    ]);
    return [
        `[Git outcome snapshot cwd=${cwd}]`,
        `status:\n${status}`,
        `branch:\n${branch}`,
        `head:\n${head}`,
        `ahead_behind_vs_upstream:\n${aheadBehind}`,
    ].join('\n\n');
}
function shouldAttachGitOutcomeSnapshot(subcommand) {
    return (subcommand === 'add' ||
        subcommand === 'commit' ||
        subcommand === 'push' ||
        subcommand === 'status');
}
async function runGithubPseudoCommand(args) {
    const action = args[0] || 'status';
    if (action === 'status') {
        let cwd = commandCwd();
        if (args.length >= 2) {
            const worktree = resolveCommonGitWorktree(args[1] || '');
            if (!worktree) {
                return (`github status: "${args[1]}" is not a git repository under /workspace/common ` +
                    `(need a clone with .git, e.g. /workspace/common/zettelkasten-weaver-extension). ` +
                    `For the NanoClaw app tree use \`github status\` with no path, or \`git -C /workspace/common/<dir> status\`.`);
            }
            cwd = worktree;
        }
        else {
            const fb = resolveFallbackGitWorktreeCwd();
            if (fb.blocked)
                return fb.blocked;
            cwd = fb.cwd;
        }
        const [status, remote, branch] = await Promise.all([
            execCommand('git', ['status', '--short', '--branch'], { cwd, env: gitEnv() }),
            execCommand('git', ['remote', '-v'], { cwd, env: gitEnv() }),
            execCommand('git', ['branch', '--show-current'], { cwd, env: gitEnv() }),
        ]);
        return [`git status (cwd ${cwd}):\n${status}`, `git remote:\n${remote}`, `branch:\n${branch}`].join('\n\n');
    }
    if (action === 'push') {
        const rest = args.slice(1);
        const pushCwdWhenImplicit = () => {
            if (isGitWorktree(commandCwd()))
                return { cwd: commandCwd() };
            return resolveFallbackGitWorktreeCwd();
        };
        if (rest.length === 0) {
            const r = pushCwdWhenImplicit();
            if (r.blocked)
                return r.blocked;
            const output = await execCommand('git', ['push'], {
                cwd: r.cwd,
                env: gitEnv(),
                timeoutMs: 120_000,
            });
            const snapshot = await buildGitOutcomeSnapshot(r.cwd);
            return `${output}\n\n${snapshot}`;
        }
        const last = rest[rest.length - 1] || '';
        const worktree = resolveCommonGitWorktree(last);
        if (worktree) {
            const branchParts = rest.slice(0, -1);
            const branchSpec = branchParts.join(' ').trim();
            const pushArgs = branchSpec ? ['push', 'origin', branchSpec] : ['push'];
            const output = await execCommand('git', pushArgs, {
                cwd: worktree,
                env: gitEnv(),
                timeoutMs: 120_000,
            });
            const snapshot = await buildGitOutcomeSnapshot(worktree);
            return `${output}\n\n${snapshot}`;
        }
        const branch = rest.join(' ');
        const pushArgs = branch ? ['push', 'origin', branch] : ['push'];
        const r = pushCwdWhenImplicit();
        if (r.blocked)
            return r.blocked;
        const output = await execCommand('git', pushArgs, {
            cwd: r.cwd,
            env: gitEnv(),
            timeoutMs: 120_000,
        });
        const snapshot = await buildGitOutcomeSnapshot(r.cwd);
        return `${output}\n\n${snapshot}`;
    }
    if (action === 'whoami') {
        const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
        if (!token)
            return 'No GITHUB_TOKEN/GH_TOKEN is available.';
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
    return `Unsupported github command: ${['github', ...args].join(' ')}. Supported: github status [path-in-common], github push [branch] [path-in-common], github whoami.`;
}
function resolveWorkspacePath(inputPath, defaultBase = COMMON_DIR) {
    const requested = inputPath || '.';
    const base = requested.startsWith('/workspace/group')
        ? GROUP_DIR
        : requested.startsWith('/workspace/common')
            ? COMMON_DIR
            : defaultBase;
    const fullPath = path.resolve(base, requested.startsWith('/workspace/group')
        ? path.relative(GROUP_DIR, requested)
        : requested.startsWith('/workspace/common')
            ? path.relative(COMMON_DIR, requested)
            : requested);
    const rel = path.relative(base, fullPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`Path escapes workspace: ${inputPath}`);
    }
    return fullPath;
}
async function runWorkspaceCommand(command, args) {
    try {
        if (command === 'touch') {
            const target = args[0];
            if (!target)
                return 'Usage: touch <path>';
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
            if (!target)
                return 'Usage: workspace-write <path> <content>';
            const filePath = resolveWorkspacePath(target, COMMON_DIR);
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, content.endsWith('\n') ? content : `${content}\n`);
            return `Wrote ${Buffer.byteLength(content)} bytes to ${filePath}`;
        }
        if (command === 'workspace-delete') {
            const target = args[0];
            if (!target)
                return 'Usage: workspace-delete <path>';
            const filePath = resolveWorkspacePath(target, COMMON_DIR);
            if (!fs.existsSync(filePath))
                return `File not found: ${filePath}`;
            fs.unlinkSync(filePath);
            return `Deleted ${filePath}`;
        }
        if (command === 'workspace-rename') {
            const src = args[0];
            const dest = args[1];
            if (!src || !dest)
                return 'Usage: workspace-rename <old_path> <new_path>';
            const srcPath = resolveWorkspacePath(src, COMMON_DIR);
            const destPath = resolveWorkspacePath(dest, COMMON_DIR);
            if (!fs.existsSync(srcPath))
                return `File not found: ${srcPath}`;
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            fs.renameSync(srcPath, destPath);
            return `Renamed ${srcPath} to ${destPath}`;
        }
        if (command === 'workspace-mkdir') {
            const target = args[0];
            if (!target)
                return 'Usage: workspace-mkdir <path>';
            const dirPath = resolveWorkspacePath(target, COMMON_DIR);
            fs.mkdirSync(dirPath, { recursive: true });
            return `Created directory ${dirPath}`;
        }
        if (command === 'workspace-copy') {
            const src = args[0];
            const dest = args[1];
            if (!src || !dest)
                return 'Usage: workspace-copy <src_path> <dest_path>';
            const srcPath = resolveWorkspacePath(src, COMMON_DIR);
            const destPath = resolveWorkspacePath(dest, COMMON_DIR);
            if (!fs.existsSync(srcPath))
                return `File or directory not found: ${srcPath}`;
            fs.cpSync(srcPath, destPath, { recursive: true });
            return `Copied ${srcPath} to ${destPath}`;
        }
        if (command === 'workspace-download') {
            const url = args[0];
            const target = args[1];
            if (!url || !target)
                return 'Usage: workspace-download <url> <filename>';
            const destPath = resolveWorkspacePath(target, COMMON_DIR);
            try {
                const response = await fetch(url);
                if (!response.ok)
                    return `Download failed: HTTP ${response.status} ${response.statusText}`;
                const buffer = await response.arrayBuffer();
                fs.mkdirSync(path.dirname(destPath), { recursive: true });
                fs.writeFileSync(destPath, Buffer.from(buffer));
                return `Downloaded ${buffer.byteLength} bytes from ${url} to ${destPath}`;
            }
            catch (err) {
                return `Failed to download ${url}: ${err instanceof Error ? err.message : String(err)}`;
            }
        }
    }
    catch (err) {
        return `Workspace command failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    return `Unsupported workspace command: ${command}`;
}
async function runWorkspaceGitClone(args) {
    const url = args[0];
    if (!url)
        return 'Usage: workspace-git-clone <git_repo_url> [directory_name]';
    ensureDir(COMMON_DIR);
    const cloneArgs = ['clone', url];
    if (args[1] && args[1] !== '...') {
        cloneArgs.push(args[1]);
    }
    return execCommand('git', cloneArgs, {
        cwd: COMMON_DIR,
        env: gitEnv(),
        timeoutMs: 120_000,
    });
}
async function runWorkspaceGitStatus(args) {
    const name = args[0];
    if (!name || name === '...') {
        const repos = listGitReposUnderCommon();
        if (repos.length === 0) {
            return 'No git repositories found directly under /workspace/common. Usage: workspace-git-status <folder>';
        }
        if (repos.length === 1) {
            return execCommand('git', ['status', '--short', '--branch'], {
                cwd: repos[0],
                env: gitEnv(),
            });
        }
        return (`Multiple git repos under /workspace/common; specify folder:\n${repos.map((p) => `- workspace-git-status ${path.basename(p)}`).join('\n')}`);
    }
    const worktree = resolveCommonGitWorktree(name);
    if (!worktree || !isGitWorktree(worktree)) {
        return `Not a git checkout under /workspace/common: ${name}`;
    }
    return execCommand('git', ['status', '--short', '--branch'], { cwd: worktree, env: gitEnv() });
}
async function runToolCommand(command) {
    const parts = shellSplit(command);
    const executable = parts[0];
    const args = parts.slice(1);
    if (executable === 'agent-browser') {
        return execCommand('agent-browser', normalizeAgentBrowserArgs(args));
    }
    if (executable === 'workspace-git-clone') {
        return runWorkspaceGitClone(args);
    }
    if (executable === 'workspace-git-status') {
        return runWorkspaceGitStatus(args);
    }
    if (executable === 'git') {
        if (!isAllowedGitCommand(args)) {
            return `Skipped unsupported git command: ${command}`;
        }
        const rawExecArgs = args[0] === '-C' ? normalizeGitArgsForCommonC(args) : args;
        const normalized = normalizeGitInvocation(rawExecArgs);
        const execArgs = normalized.argv;
        const subForTimeout = gitSubcommandForTimeout(execArgs);
        const timeoutMs = subForTimeout === 'push' || subForTimeout === 'pull' || subForTimeout === 'fetch' || subForTimeout === 'clone'
            ? 120_000
            : TOOL_TIMEOUT_MS;
        let execCwd = commandCwd();
        if (args[0] !== '-C' && execArgs[0] !== 'clone') {
            const resolved = resolveFallbackGitWorktreeCwd();
            if (resolved.blocked)
                return resolved.blocked;
            execCwd = resolved.cwd;
        }
        const addHint = validateGitAddInvocation(execArgs);
        if (addHint)
            return addHint;
        const commitHint = validateGitCommitInvocation(execArgs);
        if (commitHint)
            return commitHint;
        const output = await execCommand('git', execArgs, {
            cwd: execCwd,
            env: gitEnv(),
            timeoutMs,
        });
        const parts = [];
        if (normalized.notes.length > 0) {
            parts.push(normalized.notes.map((n) => `note: ${n}`).join('\n'));
        }
        parts.push(output);
        if (shouldAttachGitOutcomeSnapshot(subForTimeout)) {
            const snapshot = await buildGitOutcomeSnapshot(execCwd);
            parts.push(snapshot);
        }
        return parts.join('\n\n');
    }
    if (executable === 'github') {
        return runGithubPseudoCommand(args);
    }
    if (executable === 'touch' ||
        executable === 'workspace-list' ||
        executable === 'workspace-read' ||
        executable === 'workspace-write' ||
        executable === 'workspace-delete' ||
        executable === 'workspace-rename' ||
        executable === 'workspace-mkdir' ||
        executable === 'workspace-copy' ||
        executable === 'workspace-download') {
        return runWorkspaceCommand(executable, args);
    }
    return `Skipped unsupported command: ${command}`;
}
async function runToolCommands(commands) {
    const results = [];
    for (const command of commands) {
        log(`Running tool command: ${command}`);
        const output = await runToolCommand(command);
        results.push(`$ ${command}\n${output}`);
    }
    return results.join('\n\n---\n\n');
}
async function runTurn(prompt, session, containerInput) {
    session.messages.push({ role: 'user', content: prompt });
    let reply = await queryOpenRouter(session, containerInput);
    let toolRounds = 0;
    while (true) {
        const commands = extractToolCommands(reply);
        if (commands.length === 0) {
            session.messages.push({ role: 'assistant', content: reply });
            break;
        }
        session.messages.push({ role: 'assistant', content: reply });
        const toolResults = await runToolCommands(commands);
        toolRounds += 1;
        const baseFollowup = `[Tool results from executed commands]\n\n${toolResults}\n\n` +
            '**Continue or finish:** If the user request is not fully satisfied yet (more files to read, CSS/JS/HTML not yet changed, git work incomplete, tests not run, etc.), your **next reply must include more executable tool lines** on their own lines or in `backticks` — do not end with only a plan, bullet roadmap, or "I will next…" without tools.\n' +
            'When the request **is** fully satisfied, answer in plain language **without** further tool lines.\n' +
            'If any command failed, your user-facing reply MUST include a "Tool failures" section with: exact command, stderr/error excerpt, and what you will run next to fix it. Do not claim success unless tool output confirms it.\n' +
            'When tool output includes a `[Git outcome snapshot ...]` block, treat it as the source of truth for commit/push status. Do not contradict it.\n' +
            'If that snapshot shows a clean tree and no ahead commits, report "no new changes to commit/push" (not a commit failure).';
        if (toolRounds >= MAX_TOOL_ROUNDS) {
            session.messages.push({
                role: 'user',
                content: `${baseFollowup}\n\n` +
                    '[System: tool round limit reached. Summarize in plain language what succeeded or failed and what is **still unfinished** (if anything). Do not emit further git, workspace-git-clone, workspace-git-status, or workspace-* command lines.]',
            });
            reply = await queryOpenRouter(session, containerInput);
            session.messages.push({ role: 'assistant', content: reply });
            break;
        }
        session.messages.push({ role: 'user', content: baseFollowup });
        reply = await queryOpenRouter(session, containerInput);
    }
    saveSession(session);
    return reply;
}
async function main() {
    let containerInput;
    try {
        const stdinData = await readStdin();
        containerInput = JSON.parse(stdinData);
        try {
            fs.unlinkSync('/tmp/input.json');
        }
        catch {
            /* ignore */
        }
        log(`Received input for group: ${containerInput.groupFolder}`);
    }
    catch (err) {
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
    }
    catch {
        /* ignore */
    }
    let session = loadSession(containerInput.sessionId) || {
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
    }
    else {
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
    }
    catch (err) {
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
