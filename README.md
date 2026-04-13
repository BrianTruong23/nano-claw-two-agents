# NanoClaw Multi-Agent Orchestration

Welcome to the NanoClaw Multi-Agent Orchestration repository. This repository hosts a tailored, containerized framework designed to natively deploy, coordinate, and scale distinct autonomous AI agents (in this deployment: **Andy** and **Bob**) that can easily collaborate on complex workflows.

It aims to seamlessly bridge the gap between distinct agent runtimes, allowing for isolated task execution alongside synchronous, shared file manipulation in a secured local sandbox environment.

## 🚀 Key Features

* **Multi-Agent Collaboration:** Integrates multiple, fully-independent agent identities that can interact with you—and each other—dynamically in a shared setting. 
* **Shared Workspaces:** Native integration with volume-mounted sandbox directories. Both agents can reliably read, write, manipulate, and download files simultaneously via the `/workspace/common` node without corrupting their independent conversation contexts. 
* **Containerized Security:** The engine securely boots ephemeral container shells per request. Agents safely operate inside restricted bounds while natively leveraging expanded tooling like headless web scraping (powered by Brave Search), deep OS file manipulation infrastructure, and advanced Git workflow orchestration (`clone`, `checkout`, `stash`, `merge`).
* **Twin NanoClaw roots:** `andy/` and `bob/` each hold a full NanoClaw tree (separate processes, SQLite stores, and `.env`). You can still sync either side from upstream NanoClaw using git subtree or a manual merge workflow when you want updates.

## Branch policy (`main` vs `vm_machine`)

* **`main`** carries **all product features**: agent behavior, research / verify / collaborate routing (`research-mode.ts` and related), collaboration between Andy and Bob, channel changes, and anything you want every developer to run on a Mac or Linux workstation.
* **`vm_machine`** is **only for Linux server / VM deployment**: first-boot conveniences (for example `start.sh` running `npm ci` when `node_modules` is missing or native modules fail to load), small ops-only tweaks, and notes or scripts that exist purely because the app runs headless on a VM. **Do not land new product features only on `vm_machine`.** Merge `main` into `vm_machine` regularly; avoid merging `vm_machine` into `main` except to bring over intentional deploy-helper changes.

## 📂 Repository Structure

* `andy/` — NanoClaw instance for the "Andy" agent (`npm run build` / `node dist/index.js` from this directory).
* `bob/` — NanoClaw instance for "Bob", same layout as `andy/`.
* `common/` — Repo-local shared directory (`nano-claw-agents/common/`) bind-mounted as `/workspace/common` in both agent containers (Andy/Bob collaboration). Telegram-triggered **host** runs for `/codex` and `/claude` also use `common/host-coding-work/` as their working directory so you only maintain one top-level mutable tree. (Paths are resolved from `andy/` / `bob/` as one level up, not under `Documents/common`.)
* `start.sh` — Orchestrates agents and the bot bridge. On each **stop** (or before a fresh **start** after killing stale PIDs), logs in `logs/*.log` that exceed **64KiB** are trimmed by removing the **oldest ~50%** of bytes (newest half kept). Use `./start.sh logs-clean` for a **full** truncate when you want empty logs. Override the threshold with `MIN_LOG_TRIM_BYTES`.

## 🛠 Active Tool Capabilities

Out-of-the-box, both agents are equipped with advanced node execution layers capable of routing:
1. **Workspace File I/O**: `workspace-mkdir`, `workspace-copy`, `workspace-download`, `workspace-rename`, `workspace-delete`
2. **Web Browser Automation**: Headless DOM exploration, payload extraction, snapshot taking, and fully-integrated fallback search processing.
3. **GitHub State Management**: Vast, non-destructive native repository interactions including cloning upstream repos, fetching upstream differences, merging, and natively pushing compiled commits.

## 💡 Quick Start

1. To initially provision your sandbox, duplicate your environment keys globally:
   - Prepare your `.env_andy` and copy it to `andy/.env`.
   - Prepare your `.env_bob` and copy it to `bob/.env`.
2. Ensure Docker or Podman is locally available to host the execution sandboxes.
3. Launch the environment cleanly via `./start.sh`.
4. Drop your instructions directly into the designated chat bridge and let Andy and Bob take over!

### Git commits from containers (author + push)

Agent containers do not read your laptop’s `git config --global`. To avoid **“Author identity unknown”** on `git commit`, set in **both** `andy/.env` and `bob/.env` (then restart `./start.sh`):

- `NANOCLAW_GIT_AUTHOR_NAME=Your Name`
- `NANOCLAW_GIT_AUTHOR_EMAIL=you@example.com` (GitHub’s **noreply** address from *Settings → Emails* is fine)

These are passed into the container with `GITHUB_TOKEN` / `GH_TOKEN`. If omitted, commits use built-in defaults so commits still run.

**GitHub.com account:** sign up at [https://github.com/signup](https://github.com/signup). **API access for pushes:** create a Personal Access Token with `repo` scope and set `GITHUB_TOKEN` (or `GH_TOKEN`) in each agent `.env`.

Routing hints for verify groups live in `andy/src/research-mode.ts` and `bob/src/research-mode.ts` (primary: commit+push when done; secondary: short verify + @ handoff on errors). The **`github`** skill under `andy/container/skills/github/` and `bob/container/skills/github/` is copied into each group’s container skills on startup.
