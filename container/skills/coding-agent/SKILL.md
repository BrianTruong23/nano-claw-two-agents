---
name: coding-agent
description: Execute bash scripts, javascript, and python scripts natively inside a node sandbox environment directly via the agent's message loop terminal execution context.
---

# Instruction

The host application natively exports a shell coding-agent binding to the **Codex** CLI (`codex` on `PATH`).

## Interactive Codex on the host (terminal)

For a **normal interactive Codex session** (REPL / TUI), the user runs the **`codex`** command **in their own terminal** on the machine where NanoClaw is installed (not inside the agent container). Typical flow:

1. Open Terminal (or iTerm, etc.).
2. `cd` to the project they want to work in.
3. Run **`codex`** and follow the Codex UI to start a coding session.

That path is **separate** from chat: NanoClaw does not spawn an interactive terminal for the user; it only invokes **`codex exec …`** in the background when chat triggers below fire.

Tell users who ask for “open Codex” or “spawn a Codex session in the terminal” to use **`codex`** locally; for work driven **through this chat**, use the chat forms below.

## Codex via this chat (host router)

Ask the user-facing router to run Codex by using one of these forms (matched by the host; include a real task after the trigger):

```text
/codex <coding task>
use codex to <coding task>
use codex for <coding task>
spawn codex to <coding task>
spawn codex for <coding task>
have codex fix <coding task>
ask codex to <coding task>
codex: <coding task>
codex, <coding task>
use the coding agent to <coding task>
use the code agent to <coding task>
spawn the coding agent to <coding task>
coding agent: <coding task>
code agent: <coding task>
```

Alternatively, to trigger the separate Claude CLI agent for independent execution, use:

```text
/claude <coding task>
use claude to <coding task>
ask claude to <coding task>
claude: <coding task>
```

Output: It returns the terminal output straight back to the user chat.
