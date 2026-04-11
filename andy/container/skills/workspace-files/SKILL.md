---
name: workspace-files
description: Create, read, and list text files in the bot workspace. Use when the user asks to save notes, create txt/md files, or share files between Andy and Bob.
allowed-tools: Bash(workspace-list:*), Bash(workspace-read:*), Bash(workspace-write:*), Bash(workspace-delete:*), Bash(workspace-rename:*), Bash(workspace-mkdir:*), Bash(workspace-copy:*), Bash(workspace-download:*)
---

# Workspace Files

Use this skill when the user asks to create, save, read, list, rename, delete, copy, or download files/directories.

## Shared Common Space

Files that should be visible to both Andy and Bob must go in:

```text
/workspace/common
```

This maps to the host folder (sibling of `andy/` and `bob/` in this repo):

```text
<repository-root>/common
```

To **clone a Git repo into shared space**, use a line the agent-runner will execute (not prose only):

```text
workspace-git-clone https://github.com/org/repo.git
```

Optional target directory name: `workspace-git-clone <url> my-dir`. Do not rely on bare `git clone <url>` for common — that defaults to the project mount cwd.

## Chat-Specific Space

Files only relevant to the current chat can go in:

```text
/workspace/group
```

## Commands

```bash
workspace-list
workspace-list /workspace/common
workspace-read notes.txt
workspace-read /workspace/common/notes.txt
workspace-write notes.txt "text to save"
workspace-write /workspace/common/notes.txt "text to save"
workspace-rename notes.txt old_notes.txt
workspace-delete old_notes.txt
workspace-mkdir new_folder
workspace-copy notes.txt new_folder/notes_copy.txt
workspace-download https://example.com/file.pdf file.pdf
```

Default relative paths use `/workspace/common`, so `workspace-write notes.txt "hello"` writes a shared file.

## Rules

- Use `/workspace/common` when the user wants both bots to know about or reuse the file.
- Use `/workspace/group` only for chat-specific notes.
- Do not write secrets or tokens to files.
- When the user says to create a file "with what/how/why..." something should be done, treat that as a request to generate useful content answering the question. Do not write the prompt phrase literally unless the user clearly quotes exact text to save.
- For `.txt` and `.md` files with multiple sentences, steps, bullets, or sections, use real line breaks. For requests like "5 sentences", put each sentence on its own line unless the user explicitly asks for one paragraph.
- After creating or updating a file, confirm what was written in plain language. Do not claim "detailed" content was saved unless the command result wrote enough bytes for that content.
- Before correcting another bot about a shared file, verify the file with `workspace-read` or `workspace-list` instead of guessing from older failures.
- If the user already asked you to create or update a file and the action is safe, do it. Do not ask whether to proceed unless required information is missing.
