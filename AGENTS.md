# Agent instructions: publishing this monorepo

**Coding agents:** read this file when the user asks to sync, publish, or push **Andy**, **Bob**, and the **orchestration repo** after changes.

## Layout

| Path | Role |
|------|------|
| `andy/` | Full NanoClaw tree for Andy (subtree prefix `andy`) |
| `bob/` | Full NanoClaw tree for Bob (subtree prefix `bob`) |
| Repo root (`start.sh`, `bot-bridge.sh`, `README.md`, `common/`) | Multi-agent orchestration — **not** inside either subtree |

Subtree branches contain **only** the corresponding folder’s files at the branch root (exportable as a standalone NanoClaw clone).

## Remotes (expected)

- **`origin`** → `https://github.com/BrianTruong23/nano-claw-two-agents.git` (big / orchestration repo)
- **`nanoclaw`** → `https://github.com/BrianTruong23/nanoclaw.git` (fork used for `andy` and `bob` branches)

If `nanoclaw` is missing, add it:

```bash
git remote add nanoclaw https://github.com/BrianTruong23/nanoclaw.git
```

## Do not commit

Never stage or commit local runtime state unless the user explicitly asks:

- `andy/data/`, `bob/data/`, `andy/store/`, `bob/store/`, `*.db`, `logs/`, `.agents.pid`, `.env*` (secrets)

Commit only intentional source, scripts, and docs.

## Log rotation (repo root)

Orchestration logs live under `logs/*.log`.

- **Automatic (half-trim):** `./start.sh stop` and the stale-cleanup path inside `./start.sh` drop the **oldest ~50%** of each log file **by bytes** (files smaller than `MIN_LOG_TRIM_BYTES`, default `65536`, are left unchanged).
- **Full clear:** `./start.sh logs-clean` (stop agents first, or use `--force`).

```bash
./start.sh stop   # trims large logs then exits
./start.sh        # also trims after killing stale processes, then starts agents
```

## Conversation archive cleanup

Conversation archives live under `andy/groups/*/conversations/*.md` and `bob/groups/*/conversations/*.md`.

The repo-root `start.sh` will delete archive `.md` files older than **5 days** (by file mtime):
- once on `./start.sh stop`
- once on startup after stale-kill
- and then daily inside the background trimmer loop

Configure with:
- `CONVERSATION_RETENTION_DAYS` (default `5`)
- `CONVERSATION_CLEAN_INTERVAL_SECONDS` (default `86400`)

## After code changes — run these automatically

Run from the **repository root** (`nano-claw-agents`). Ensure meaningful changes are **committed on `main`** before splitting (subtree split uses commit history, not unstaged files).

### 1. Push orchestration + full tree (`main`)

```bash
git checkout main
git pull origin main
git push origin main
```

### 2. Rebuild split branches (`andy` / `bob`)

These commands **replace** local branches `andy` and `bob` with fresh splits from the current `main`:

```bash
git subtree split --prefix=andy -b andy
git subtree split --prefix=bob -b bob
```

### 3. Push `andy` and `bob` to both remotes

```bash
git push nanoclaw andy:andy
git push nanoclaw bob:bob
git push origin andy:andy
git push origin bob:bob
```

### One-shot sequence (copy-paste)

```bash
cd "$(git rev-parse --show-toplevel)"
git checkout main && git pull origin main
git push origin main
git subtree split --prefix=andy -b andy
git subtree split --prefix=bob -b bob
git remote get-url nanoclaw >/dev/null 2>&1 || git remote add nanoclaw https://github.com/BrianTruong23/nanoclaw.git
git push nanoclaw andy:andy
git push nanoclaw bob:bob
git push origin andy:andy
git push origin bob:bob
```

Requires **network**, **git push** credentials (e.g. `gh auth login` or SSH remotes), and permissions to update those branches.

## If remotes or repo names differ

Adjust `nanoclaw` URL or push targets when the user names different GitHub repos for Andy vs Bob; the **pattern** stays: `git subtree split --prefix=<folder> -b <branch>` then `git push <remote> <branch>:<branch>`.

## Quick reference URLs

- Big repo: `https://github.com/BrianTruong23/nano-claw-two-agents`
- Nanoclaw fork (branches `andy`, `bob`): `https://github.com/BrianTruong23/nanoclaw`

## Git clone into `/workspace/common`

See [`docs/git-clone-into-common.md`](docs/git-clone-into-common.md) for agent-runner behavior (`workspace-git-clone`), rebuild steps, and a brainstorm of further reliability options.

## Codex (terminal vs chat)

- **Terminal (user):** run the **`codex`** CLI on the host for an interactive session (`cd` to the repo first). Documented for the in-container model in `andy/container/skills/coding-agent/SKILL.md` (same under `bob/`).
- **Chat:** `/codex <task>` and natural-language variants are handled by the host (`andy/src/index.ts` / `bob/src/index.ts`, `extractCodexPrompt`); the container skill lists the phrases users can type.
