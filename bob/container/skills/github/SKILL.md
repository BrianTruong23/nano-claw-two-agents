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
github whoami
workspace-git-clone <repository_url>
workspace-git-clone <repository_url> <folder_name>
git clone <repository_url> /workspace/common/<folder_name>
git clone <repository_url>
git status --short --branch
git remote -v
git diff
git log --oneline -5
git add <files>
git commit -m "message"
git checkout <branch>
git stash
git merge <branch>
git rebase <branch>
git revert <commit_hash>
github push
github push <branch>
```

## Cloning into the shared Andy/Bob folder (`/workspace/common`)

- **Preferred:** emit a single line the runner will execute, e.g.  
  `workspace-git-clone https://github.com/org/repo.git`  
  (clone is created **inside** `/workspace/common` with default directory name from the repo).
- **Optional folder name:** `workspace-git-clone https://github.com/org/repo.git my-folder`
- **Alternative:** `git clone <url> /workspace/common/<folder>` — plain `git clone <url>` alone uses **`/workspace/project`** as cwd, **not** common.

After cloning, verify with: `workspace-list /workspace/common` (or list the target path).

## Workflow

1. Run `github status` before changing Git state.
2. If the user asks to push existing committed work, run `github push`.
3. If the user asks to commit and push, inspect `git status --short --branch`, then commit only relevant files, then push.
4. Keep the user informed if the workspace is not a Git repository, has no GitHub token, or the project mount is read-only.

## Safety

- Do not run destructive commands such as `git reset`, `git clean`, `git rm`, or force pushes.
- Do not print tokens.
- If code edits are required, use the coding agent flow instead of trying to hand-edit large changes from chat.
