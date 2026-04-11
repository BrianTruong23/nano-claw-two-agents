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
