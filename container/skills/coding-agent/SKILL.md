---
name: coding-agent
description: Execute bash scripts, javascript, and python scripts natively inside a node sandbox environment directly via the agent's message loop terminal execution context.
---

# Instruction

The host application natively exports a shell coding-agent binding directly connected to Anthropic's Codex environment internally.

Ask the user-facing router to run Codex by using one of these forms:

```text
/codex <coding task>
use codex to <coding task>
use the coding agent to <coding task>
coding agent: <coding task>
```

Alternatively, to trigger the separate Claude CLI agent for independent execution, use:

```text
/claude <coding task>
use claude to <coding task>
ask claude to <coding task>
claude: <coding task>
```

Output: It returns the terminal output straight back to the user chat.
