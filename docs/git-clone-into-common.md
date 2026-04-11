# Git clones into `/workspace/common` (Andy/Bob)

Coding agents and humans: read this when debugging **missing clones**, **wrong directory**, or **claims of success without disk proof**.

## What we implemented in the container agent-runner

1. **`workspace-git-clone <url> [dir]`** — runs `git clone` with **`cwd=/workspace/common`**, so the default clone directory is always under shared space (unless you pass a custom `dir`).
2. **Clearer system prompt** — explains that **prose does not run tools**, that plain `git clone <url>` uses **`/workspace/project`**, and that failures must be acknowledged with stderr.
3. **`runTurn` loop** — no longer drops the **last** round of tool commands: every parsed command runs until the model stops emitting tools or **8** tool rounds complete, then a forced wrap-up message prevents infinite tool spam.
4. **Skills** (`container/skills/github/SKILL.md`, `workspace-files/SKILL.md`) — document `workspace-git-clone` and verification via `workspace-list`.

Rebuild the agent image after changing `container/agent-runner`: `./container/build.sh` from `andy/` or `bob/`.

---

## Brainstorm: more ways to make clones reliable

| Idea | Pros | Cons / notes |
|------|------|----------------|
| **`workspace-git-clone` (done)** | One line, correct cwd; easy to parse | Only covers `git clone`; not `git pull` into existing repo |
| **Require post-clone verification in prompt** | Model runs `workspace-list /workspace/common` | Still optional unless enforced in code |
| **Code: auto-run `workspace-list` after `workspace-git-clone` success** | User sees listing in tool results | Extra noise; need heuristics for “success” |
| **Pass `GITHUB_TOKEN` / `GH_TOKEN` into container** | Private repos + HTTPS GitHub | Already via `gitEnv()` when env set; host must inject token |
| **Shallow clone** | Faster, less disk: `git clone --depth 1` | Could add `workspace-git-clone-shallow` or flag parsing |
| **`git clone` URL rewrite to sparse checkout** | Huge repos | Complex; rare for Zettelkasten-sized trees |
| **Fallback: `workspace-download` of GitHub zip** | Works when `git` blocked | Loses `.git`; different semantics |
| **Host-side clone + bind-mount** | Full control outside container | Breaks “everything in container” model |
| **Dedicated small script `/usr/local/bin/clone-common`** | Stable CLI surface | Another layer to maintain; duplicate of `workspace-git-clone` |
| **Stricter tool grammar (JSON tool calls)** | No regex fragility | Larger change; move away from “line in reply” pattern |
| **Lower temperature only for tool-followup** | Slightly less creative drift | Marginal; still not a guarantee |
| **Log tool stdout to host file** | Auditable | Privacy/size; needs log rotation |
| **CI test: run container with dummy `git clone`** | Regression safety | Requires network in CI |

### Operational checklist (Telegram / production)

- Container image includes **`git`** (Dockerfile already installs it).
- **Network**: Docker must allow outbound HTTPS to `github.com`.
- **Public repo**: no token required; **private**: set `GITHUB_TOKEN` or `GH_TOKEN` for the agent environment so `gitEnv()` can wire `GIT_ASKPASS`.
- **Disk**: `common/` on host must be writable by the container user (uid mapping in `container-runner.ts`).
- **User instruction**: ask for a **single executable line**, e.g. `` `workspace-git-clone https://...` `` in backticks so `extractToolCommands` picks it up.

---

## Related code (monorepo)

- `andy/container/agent-runner/src/index.ts` (mirrored under `bob/container/agent-runner/`)
- `extractToolCommands`, `runTurn`, `runWorkspaceGitClone`, `buildSystemPrompt`
