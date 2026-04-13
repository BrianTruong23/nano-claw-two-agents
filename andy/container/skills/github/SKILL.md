---
name: github
description: Inspect Git/GitHub state and push committed work to the repository. Use when the user asks about GitHub, remotes, branches, commits, or pushing changes.
allowed-tools: Bash(git:*), Bash(github:*)
---

# GitHub and Git

Use this skill when the user asks to check repository state, inspect remotes, commit work, or push to GitHub.

## Andy / primary: finish with commit + push

When you have made **real file changes** in a repo under `/workspace/common` (and the user did **not** say “do not push”), treat the job as incomplete until you:

1. `git status` (or `github status …`) — confirm what changed  
2. `git add -A` or explicit paths (e.g. `git -C /workspace/common/<repo> add -A`) — **never** run bare `git add` with no pathspec  
3. `git commit -m "clear message"` (author is set via container env; optional: `git -C … config user.name "…"` only if you must override — `git config` for other keys is not allowed)  
4. `github push` or `github push /workspace/common/<repo>` / `github push <branch> /workspace/common/<repo>`  

If you only inspected files and changed nothing, you do not need to commit or push.

## Bob / verify: short check + hand off failures

After the **primary** assistant’s last message: if everything looks correct, **≤2 short sentences**. If something failed (git stderr, wrong branch, missing push, broken claim), **lead with what is wrong** and tag the primary (e.g. `@Andy`) when your group uses that pattern so they can fix it on the next turn.

## Commit author (fixes “Author identity unknown” in the container)

Git inside the agent container does **not** use your Mac’s `git config --global`. Commits get author fields from environment variables passed into the container:

- **`NANOCLAW_GIT_AUTHOR_NAME`** — your real name or bot label  
- **`NANOCLAW_GIT_AUTHOR_EMAIL`** — an email GitHub accepts on commits (often your GitHub noreply address)

Add both to **`andy/.env`** and **`bob/.env`** (same values are fine). Restart `./start.sh` after editing. If unset, commits use defaults `NanoClaw Agent` / `nanoclaw@localhost` (good enough to avoid the error; use real values for GitHub-contributed graphs).

## GitHub account vs Git token

- **Sign up / account:** create a free account at [https://github.com/signup](https://github.com/signup).  
- **Push access:** create a **Personal Access Token** (classic or fine-grained) with `repo` scope, and set **`GITHUB_TOKEN`** or **`GH_TOKEN`** in each agent `.env` (already used by `github push` / `git` HTTPS).  
- **Commit email** on GitHub: Settings → Emails — you can use the **`…@users.noreply.github.com`** address as `NANOCLAW_GIT_AUTHOR_EMAIL` if you want to hide your private email.

## Commands You Can Run

```bash
github status
github status /workspace/common/<repo_dir>
github whoami
workspace-git-clone <repository_url>
workspace-git-clone <repository_url> <folder_name>
workspace-git-status
workspace-git-status <folder_under_common>
git clone <repository_url> /workspace/common/<folder_name>
git clone <repository_url>
git -C /workspace/common/<repo_dir> status
git -C /workspace/common/<repo_dir> log --oneline -5
git status --short --branch
git remote -v
git diff
git log --oneline -5
git add <files>
git add -A
git -C /workspace/common/<repo_dir> config user.name "Your Name"
git -C /workspace/common/<repo_dir> config user.email "you@example.com"
git commit -m "message"
git checkout <branch>
git stash
git merge <branch>
git rebase <branch>
git revert <commit_hash>
github push
github push <branch>
github push /workspace/common/<repo_dir>
github push <branch> /workspace/common/<repo_dir>
```

## Cloning into the shared Andy/Bob folder (`/workspace/common`)

- **Preferred:** emit a single line the runner will execute, e.g.  
  `workspace-git-clone https://github.com/org/repo.git`  
  (clone is created **inside** `/workspace/common` with default directory name from the repo).
- **Optional folder name:** `workspace-git-clone https://github.com/org/repo.git my-folder`
- **Alternative:** `git clone <url> /workspace/common/<folder>` — plain `git clone <url>` alone uses **`/workspace/project`** as cwd, **not** common.

After cloning, verify with: `workspace-list /workspace/common` (or list the target path).

**Git commands on a shared clone:** the runner’s default cwd for `git` is `/workspace/project` or `/workspace/group`, not your clone. Use `workspace-git-status <folder>` for a clear status in `/workspace/common/<folder>`, or `workspace-git-status` with no args when there is only one repo there. For anything in `/workspace/common`, you can also use `git -C /workspace/common/<folder> status` (relative `-C` resolves under `/workspace/common` only). With a single clone under common, plain `git status` is redirected to that clone automatically.

## Workflow

1. Run `github status` before changing Git state on the **project** mount. For a clone under `/workspace/common`, run `github status /workspace/common/<dir>` (or `git -C /workspace/common/<dir> status`). To push that clone: `github push /workspace/common/<dir>` or `github push <branch> /workspace/common/<dir>`.
2. If the user asks to push existing committed work on the **project** mount, run `github push`. For a `/workspace/common` clone, use `github push /workspace/common/<dir>` or `github push <branch> /workspace/common/<dir>`.
3. If the user asks to commit and push, inspect status in the correct repo (`github status …` or `git -C /workspace/common/<dir> status --short --branch`), then `git -C …` add/commit, then `github push …` with the same path rules.
4. Keep the user informed if the workspace is not a Git repository, has no GitHub token, or the project mount is read-only.

## Common mistakes (container)

- **`git add`** with no arguments does nothing useful — use **`git add -A`** (or explicit paths).  
- **`git commit`** without **`-m "…"`** cannot open an editor — always use **`-m`**. Example:  
  `git -C /workspace/common/<repo> add -A` then  
  `git -C /workspace/common/<repo> commit -m "Improve popup UI"` then  
  `github push /workspace/common/<repo>`.

## Safety

- Do not run destructive commands such as `git reset`, `git clean`, `git rm`, or force pushes.
- Do not print tokens.
- If code edits are required, use the coding agent flow instead of trying to hand-edit large changes from chat.
