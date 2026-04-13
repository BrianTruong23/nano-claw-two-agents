---
name: github
description: Inspect Git/GitHub state and push committed work to the repository. Use when the user asks about GitHub, remotes, branches, commits, or pushing changes.
allowed-tools: Bash(git:*), Bash(github:*)
---

# GitHub and Git

Use this skill when the user asks to check repository state, inspect remotes, commit work, or push to GitHub.

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
