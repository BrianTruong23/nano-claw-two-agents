---
name: github-ops
description: Manage GitHub PRs, issues, releases, and workflows using the gh CLI. Use when the user asks to create a pull request, file an issue, check CI status, manage releases, or perform GitHub platform operations beyond basic git.
---

# GitHub Operations (gh CLI)

Use `gh` for GitHub platform tasks beyond basic git add/commit/push (handled by the `github` skill).

## Authentication

`gh` uses the `GITHUB_TOKEN` or `GH_TOKEN` env var. Verify with:

```bash
gh auth status
```

## Pull Requests

```bash
gh pr create --title "Title" --body "Description" --base main
gh pr list
gh pr view 42
gh pr merge 42 --merge
gh pr checks 42
gh pr review 42 --approve
gh pr diff 42
```

Run from inside the repo directory.

## Issues

```bash
gh issue create --title "Bug: ..." --body "Steps to reproduce..." --label bug
gh issue list --state open
gh issue view 15
gh issue close 15 --reason completed
gh issue edit 15 --add-label priority
gh issue comment 15 --body "Fixed in PR #42"
```

## Releases

```bash
gh release create v1.0.0 --title "v1.0.0" --notes "Release notes"
gh release list
gh release view v1.0.0
gh release upload v1.0.0 ./dist/artifact.tar.gz
```

## Repository Info

```bash
gh repo view --json name,description,defaultBranchRef
gh api repos/{owner}/{repo}/contributors --jq '.[].login'
gh api repos/{owner}/{repo}/actions/runs --jq '.workflow_runs[:5] | .[].conclusion'
```

## Workflow / CI

```bash
gh run list --limit 5
gh run view <run-id>
gh run watch <run-id>
gh workflow list
gh workflow run <workflow>.yml
```

## Common Patterns

- **Create PR from current branch:** `gh pr create --fill` (auto-fills from commits)
- **Check CI before merge:** `gh pr checks <num>` then `gh pr merge <num> --merge`
- **Link issue to PR:** include `Fixes #N` in PR body
- **Repo must be a GitHub remote:** `gh` reads origin from git config

## Pitfalls

- Run `gh` from inside the repo, not from `/workspace/group`.
- For repos under `/workspace/common/<dir>`, cd into it first.
- `gh pr create` requires at least one commit ahead of base.
- `gh release create` needs a tag; create with `git tag v1.0.0` first if needed.
