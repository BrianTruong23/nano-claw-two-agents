#!/usr/bin/env node
/**
 * Minimal combined dashboard for nano-claw-agents.
 * Read-only: aggregates per-agent runtime-status.json into one compact UI.
 */
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import url from 'url';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const HOST = process.env.NANOCLAW_MULTI_DASHBOARD_HOST || '127.0.0.1';
const PORT = Number.parseInt(process.env.NANOCLAW_MULTI_DASHBOARD_PORT || '4790', 10);

const ANDY_RUNTIME = path.join(REPO_ROOT, 'andy', 'data', 'dashboard', 'runtime-status.json');
const BOB_RUNTIME = path.join(REPO_ROOT, 'bob', 'data', 'dashboard', 'runtime-status.json');
const ANDY_EVENTS = path.join(REPO_ROOT, 'andy', 'data', 'dashboard', 'events.jsonl');
const BOB_EVENTS = path.join(REPO_ROOT, 'bob', 'data', 'dashboard', 'events.jsonl');

function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function fileAgeMs(filePath) {
  try {
    const st = fs.statSync(filePath);
    return Date.now() - st.mtimeMs;
  } catch {
    return null;
  }
}

function readAllowlistSummary() {
  const base = path.join(os.homedir(), '.config', 'nanoclaw');
  const mount = readJson(path.join(base, 'mount-allowlist.json'));
  const sender = readJson(path.join(base, 'sender-allowlist.json'));
  const mountCount =
    mount && typeof mount === 'object'
      ? Array.isArray(mount)
        ? mount.length
        : Object.keys(mount).length
      : 0;
  const senderCount =
    sender && typeof sender === 'object'
      ? Array.isArray(sender)
        ? sender.length
        : Object.keys(sender).length
      : 0;
  return {
    mountAllowlistPath: path.join(base, 'mount-allowlist.json'),
    senderAllowlistPath: path.join(base, 'sender-allowlist.json'),
    mountCount,
    senderCount,
  };
}

function readTailJsonl(filePath, maxLines = 12) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const lines = fs
      .readFileSync(filePath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .slice(-maxLines);
    return lines.map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function agentHealth(runtime, ageMs) {
  if (!runtime) return { ok: false, reason: 'no runtime-status.json' };
  if (runtime.status !== 'running')
    return { ok: false, reason: `status=${runtime.status}` };
  if (ageMs == null) return { ok: false, reason: 'unknown heartbeat age' };
  if (ageMs > 15000) return { ok: false, reason: `heartbeat stale (${Math.round(ageMs / 1000)}s)` };
  const channels = Array.isArray(runtime.channels) ? runtime.channels : [];
  if (channels.length > 0 && channels.every((c) => c && c.connected === false)) {
    return { ok: false, reason: 'no connected channels' };
  }
  return { ok: true, reason: 'healthy' };
}

function computeBacklog(runtime) {
  const q = runtime?.queue || {};
  const groups = q.groups || {};
  let pendingMessages = 0;
  let pendingTasks = 0;
  let activeGroups = 0;
  let retrying = 0;
  for (const v of Object.values(groups)) {
    if (!v) continue;
    if (v.active) activeGroups += 1;
    if (v.pendingMessages) pendingMessages += 1;
    pendingTasks += Number(v.pendingTaskCount || 0);
    if ((v.retryCount || 0) > 0) retrying += 1;
  }
  return {
    activeCount: q.activeCount ?? activeGroups,
    waitingGroups: Array.isArray(q.waitingGroups) ? q.waitingGroups.length : 0,
    pendingMessagesGroups: pendingMessages,
    pendingTaskCount: pendingTasks,
    retryingGroups: retrying,
  };
}

function computeNextAction(runtime) {
  if (!runtime) return 'Start agent to populate runtime status';
  const q = runtime.queue || {};
  const groups = q.groups || {};
  const active = Object.entries(groups).find(([, v]) => v && v.active);
  if (active) {
    const [jid, v] = active;
    if (v.isTaskContainer && v.runningTaskId) return `Running task ${v.runningTaskId} (${jid})`;
    if (v.containerName) return `Running container ${v.containerName} (${jid})`;
    return `Working (${jid})`;
  }
  const hasPendingMsg = Object.values(groups).some((v) => v && v.pendingMessages);
  if (hasPendingMsg) return 'Pending messages: will process next poll';
  const hasPendingTasks = Object.values(groups).some((v) => v && (v.pendingTaskCount || 0) > 0);
  if (hasPendingTasks) return 'Pending tasks: will schedule/run next';
  const waiting = Array.isArray(q.waitingGroups) ? q.waitingGroups.length : 0;
  if (waiting > 0) return `Waiting groups queued (${waiting})`;
  return 'Idle';
}

function snapshot() {
  const allowlists = readAllowlistSummary();
  const andy = readJson(ANDY_RUNTIME);
  const bob = readJson(BOB_RUNTIME);
  const andyAge = fileAgeMs(ANDY_RUNTIME);
  const bobAge = fileAgeMs(BOB_RUNTIME);
  const andyEvents = readTailJsonl(ANDY_EVENTS, 12);
  const bobEvents = readTailJsonl(BOB_EVENTS, 12);
  return {
    at: new Date().toISOString(),
    repoRoot: REPO_ROOT,
    allowlists,
    agents: {
      andy: {
        runtimePath: ANDY_RUNTIME,
        runtimeAgeMs: andyAge,
        runtime: andy,
        health: agentHealth(andy, andyAge),
        backlog: computeBacklog(andy),
        nextAction: computeNextAction(andy),
        recentEvents: andyEvents,
      },
      bob: {
        runtimePath: BOB_RUNTIME,
        runtimeAgeMs: bobAge,
        runtime: bob,
        health: agentHealth(bob, bobAge),
        backlog: computeBacklog(bob),
        nextAction: computeNextAction(bob),
        recentEvents: bobEvents,
      },
    },
  };
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

const page = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>NanoClaw — Mission Control</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Serif+Display&display=swap" rel="stylesheet">
    <style>
      :root {
        /* Warm base */
        --bg-primary: #FAF8F5;
        --bg-secondary: #F0EDE8;
        --bg-card: #FFFFFF;
        --bg-elevated: #FFFFFF;

        /* Text */
        --text-primary: #1A1714;
        --text-secondary: #6B6560;
        --text-tertiary: #9C9690;

        /* Accent — warm terracotta */
        --accent-primary: #C4704B;
        --accent-primary-hover: #B3603B;
        --accent-subtle: #FDF0EB;

        /* Agent colors */
        --agent-alpha: #4A7C6F;       /* sage green */
        --agent-alpha-subtle: #EDF5F2;
        --agent-beta: #7C6A4A;        /* warm bronze */
        --agent-beta-subtle: #F5F0E8;

        /* Priority colors */
        --priority-critical: #D94F4F;
        --priority-high: #E08B4A;
        --priority-medium: #D4B94A;
        --priority-low: #8BB896;

        /* Status */
        --status-idle: #9C9690;
        --status-working: #4A7C6F;
        --status-blocked: #D94F4F;
        --status-done: #6B8F5E;

        /* Borders & shadows */
        --border-light: #E8E4DF;
        --border-medium: #D5D0CA;
        --shadow-sm: 0 1px 3px rgba(26, 23, 20, 0.06);
        --shadow-md: 0 4px 12px rgba(26, 23, 20, 0.08);
        --shadow-lg: 0 8px 24px rgba(26, 23, 20, 0.12);

        /* Radius */
        --radius-sm: 6px;
        --radius-md: 10px;
        --radius-lg: 16px;
      }

      html, body { height: 100%; }
      body {
        margin: 0;
        background: var(--bg-primary);
        color: var(--text-primary);
        font-family: "DM Sans", system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
        font-size: 14px;
        line-height: 1.45;
      }

      .container { max-width: 1400px; margin: 0 auto; padding: 16px; }

      .header {
        position: sticky;
        top: 0;
        z-index: 20;
        background: color-mix(in srgb, var(--bg-primary) 92%, white 8%);
        border-bottom: 1px solid var(--border-light);
        backdrop-filter: blur(8px);
      }

      .header-inner {
        height: 56px;
        display: grid;
        grid-template-columns: 1fr auto 1fr;
        align-items: center;
        gap: 16px;
      }

      .brand {
        display: flex;
        align-items: baseline;
        gap: 10px;
      }
      .brand .title {
        font-family: "DM Serif Display", Georgia, serif;
        font-size: 28px;
        letter-spacing: 0.2px;
      }
      .brand .subtitle {
        font-size: 13px;
        color: var(--text-secondary);
      }

      .center-toggle {
        display: inline-flex;
        gap: 6px;
        padding: 6px;
        border: 1px solid var(--border-light);
        border-radius: 999px;
        background: var(--bg-card);
        box-shadow: var(--shadow-sm);
      }
      .toggle {
        font-size: 13px;
        padding: 6px 10px;
        border-radius: 999px;
        color: var(--text-secondary);
        border: 0;
        background: transparent;
        cursor: pointer;
        transition: all 0.2s cubic-bezier(0.4,0,0.2,1);
      }
      .toggle.active {
        color: var(--text-primary);
        background: var(--accent-subtle);
        box-shadow: var(--shadow-sm);
      }

      .header-right {
        display: flex;
        justify-content: flex-end;
        align-items: center;
        gap: 12px;
      }

      .btn {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        height: 36px;
        padding: 0 12px;
        border-radius: var(--radius-md);
        border: 1px solid var(--border-light);
        background: var(--bg-card);
        box-shadow: var(--shadow-sm);
        cursor: pointer;
        font-weight: 600;
        transition: all 0.2s cubic-bezier(0.4,0,0.2,1);
        user-select: none;
      }
      .btn.primary {
        background: var(--accent-primary);
        border-color: color-mix(in srgb, var(--accent-primary) 75%, black 25%);
        color: white;
      }
      .btn.primary:hover { background: var(--accent-primary-hover); }
      .btn:active { transform: scale(0.97); }

      .pill {
        font-size: 11px;
        padding: 4px 10px;
        border-radius: 999px;
        border: 1px solid var(--border-light);
        background: var(--bg-card);
        color: var(--text-secondary);
        box-shadow: var(--shadow-sm);
      }

      .section-title {
        font-size: 20px;
        font-family: "DM Serif Display", Georgia, serif;
        margin: 24px 0 12px;
      }

      .card {
        background: var(--bg-card);
        border: 1px solid var(--border-light);
        border-radius: var(--radius-md);
        padding: 16px;
        box-shadow: var(--shadow-sm);
      }

      .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      @media (max-width: 980px) { .grid-2 { grid-template-columns: 1fr; } }

      .kv { display:grid; grid-template-columns: 160px 1fr; gap: 6px 10px; }
      .k { font-size: 11px; color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.08em; }
      .v { color: var(--text-primary); }
      .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }

      .agent-header {
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap: 12px;
        margin-bottom: 12px;
      }
      .agent-name { display:flex; align-items:center; gap: 10px; }
      .badge {
        display:inline-flex;
        align-items:center;
        gap: 6px;
        font-size: 11px;
        padding: 4px 10px;
        border-radius: 999px;
        border: 1px solid var(--border-light);
        background: var(--bg-secondary);
        color: var(--text-secondary);
      }
      .dot { width: 8px; height: 8px; border-radius: 999px; background: var(--status-idle); }
      .pulse { animation: pulse 1.2s ease-in-out 1; }
      @keyframes pulse {
        0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent-primary) 45%, transparent 55%); }
        100% { box-shadow: 0 0 0 12px transparent; }
      }

      .kanban {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 12px;
      }
      @media (max-width: 1200px) { .kanban { grid-template-columns: repeat(2, 1fr); } }
      @media (max-width: 720px) { .kanban { grid-template-columns: 1fr; } }

      .col {
        background: var(--bg-secondary);
        border: 1px solid var(--border-light);
        border-radius: var(--radius-lg);
        padding: 12px;
      }
      .col-title {
        display:flex;
        align-items:baseline;
        justify-content:space-between;
        gap: 8px;
        margin-bottom: 10px;
      }
      .col-title .t { font-weight: 700; font-size: 16px; }
      .col-title .c { font-size: 11px; color: var(--text-tertiary); }

      .cards { display:flex; flex-direction:column; gap: 12px; min-height: 92px; }
      .empty {
        border: 1px dashed var(--border-medium);
        border-radius: var(--radius-md);
        padding: 12px;
        color: var(--text-tertiary);
        font-size: 13px;
        background: color-mix(in srgb, var(--bg-secondary) 72%, white 28%);
      }

      .task {
        background: var(--bg-card);
        border: 1px solid var(--border-light);
        border-radius: var(--radius-md);
        padding: 16px;
        box-shadow: var(--shadow-sm);
        transition: all 0.2s cubic-bezier(0.4,0,0.2,1);
        transform-origin: center;
        opacity: 0;
        animation: cardIn 280ms cubic-bezier(0.4,0,0.2,1) forwards;
      }
      @keyframes cardIn {
        from { opacity: 0; transform: translateY(-6px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      .task:hover { box-shadow: var(--shadow-md); transform: scale(1.01); }

      .task.pri-critical { border-left: 3px solid var(--priority-critical); }
      .task.pri-high { border-left: 3px solid var(--priority-high); }
      .task.pri-medium { border-left: 3px solid var(--priority-medium); }
      .task.pri-low { border-left: 3px solid var(--priority-low); }

      .task-top { display:flex; align-items:center; justify-content:space-between; gap: 10px; }
      .task-title { font-weight: 600; font-size: 14px; }
      .agent-pill { font-size: 11px; padding: 3px 8px; border-radius: 999px; border: 1px solid var(--border-light); }
      .agent-andy { background: var(--agent-alpha-subtle); color: var(--agent-alpha); }
      .agent-bob { background: var(--agent-beta-subtle); color: var(--agent-beta); }

      .meta { margin-top: 8px; display:flex; align-items:center; gap: 10px; flex-wrap: wrap; color: var(--text-secondary); font-size: 13px; }
      .pri { display:flex; align-items:center; gap: 6px; }
      .pri .p { width: 8px; height: 8px; border-radius: 999px; background: var(--priority-low); }
      .pri.critical .p { background: var(--priority-critical); }
      .pri.high .p { background: var(--priority-high); }
      .pri.medium .p { background: var(--priority-medium); }
      .pri.low .p { background: var(--priority-low); }

      .effort { display:inline-flex; gap: 4px; }
      .sq { width: 10px; height: 10px; border-radius: 2px; border: 1px solid var(--border-medium); background: transparent; }
      .sq.f { background: color-mix(in srgb, var(--accent-primary) 28%, white 72%); border-color: color-mix(in srgb, var(--accent-primary) 35%, var(--border-medium) 65%); }

      .events { margin-top: 16px; }
      .event { display:flex; gap: 8px; padding: 6px 0; border-top: 1px solid var(--border-light); }
      .event:first-child { border-top: 0; }
      .event .t { width: 84px; color: var(--text-tertiary); font-size: 11px; }
      .event .m { flex: 1; }
      .lvl { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border-light); background: var(--bg-secondary); color: var(--text-secondary); margin-right: 6px; }

      details > summary { cursor: pointer; color: var(--text-secondary); font-size: 13px; }
      pre { margin: 8px 0 0; padding: 12px; border-radius: var(--radius-md); border: 1px solid var(--border-light); background: var(--bg-secondary); overflow:auto; }
    </style>
  </head>
  <body>
    <div class="header">
      <div class="container">
        <div class="header-inner">
          <div class="brand">
            <div class="title">Mission Control</div>
            <div class="subtitle">Warm Precision · two-agent trust dashboard</div>
          </div>
          <div style="display:flex; justify-content:center">
            <div class="center-toggle" aria-label="View toggle">
              <button class="toggle active" id="view_kanban" type="button">Kanban</button>
              <button class="toggle" id="view_raw" type="button">Raw</button>
            </div>
          </div>
          <div class="header-right">
            <div class="pill" id="updated">loading…</div>
            <button class="btn primary" id="new_task" type="button" title="Coming soon (read-only)">New Task</button>
          </div>
        </div>
      </div>
    </div>

    <div class="container">
      <div class="section-title">Permissions</div>
      <div class="card">
        <div class="kv" id="allowlists"></div>
        <div style="margin-top:10px; color: var(--text-secondary); font-size: 13px">
          Edit allowlists on the host, then restart agents to apply mount/sender decisions.
        </div>
      </div>

      <div class="section-title">Agents</div>
      <div class="grid-2">
        <div class="card" id="card_andy">
          <div class="agent-header">
            <div class="agent-name">
              <div class="badge"><span class="dot" id="andy_dot"></span> Andy</div>
              <div class="badge agent-andy">A</div>
            </div>
            <div class="pill" id="andy_status">…</div>
          </div>
          <div id="andy_body"></div>
          <details style="margin-top:14px">
            <summary>Raw runtime JSON</summary>
            <pre id="andy_raw"></pre>
          </details>
        </div>
        <div class="card" id="card_bob">
          <div class="agent-header">
            <div class="agent-name">
              <div class="badge"><span class="dot" id="bob_dot"></span> Bob</div>
              <div class="badge agent-bob">B</div>
            </div>
            <div class="pill" id="bob_status">…</div>
          </div>
          <div id="bob_body"></div>
          <details style="margin-top:14px">
            <summary>Raw runtime JSON</summary>
            <pre id="bob_raw"></pre>
          </details>
        </div>
      </div>
    </div>

    <script>
      const el = (id) => document.getElementById(id);
      const esc = (s) => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
      const fmtMs = (ms) => {
        if (ms == null) return "n/a";
        const s = Math.round(ms / 1000);
        if (s < 60) return s + "s";
        const m = Math.floor(s / 60);
        const r = s % 60;
        return m + "m " + r + "s";
      };

      function setToggle(active) {
        el("view_kanban").classList.toggle("active", active === "kanban");
        el("view_raw").classList.toggle("active", active === "raw");
        document.body.dataset.view = active;
      }

      el("view_kanban").addEventListener("click", () => setToggle("kanban"));
      el("view_raw").addEventListener("click", () => setToggle("raw"));
      setToggle("kanban");

      const kv = (k, v) => '<div class="k">' + esc(k) + '</div><div class="v">' + v + '</div>';
      const effort = (n) => {
        const s = (i) => '<span class="sq ' + (i < n ? "f" : "") + '"></span>';
        return '<span class="effort" title="effort">' + s(0) + s(1) + s(2) + '</span>';
      };
      const priLabel = (p) => {
        const cls = p;
        const label = p === "critical" ? "Critical" : p === "high" ? "High" : p === "medium" ? "Medium" : "Low";
        return '<span class="pri ' + cls + '"><span class="p"></span><span>' + label + '</span></span>';
      };

      function classifyGroupCard(v) {
        // Priority heuristic
        const retry = (v.retryCount || 0) > 0;
        const active = !!v.active;
        const pendingMsg = !!v.pendingMessages;
        const tasks = Number(v.pendingTaskCount || 0);
        if (retry) return { pri: "critical", effort: 3 };
        if (active) return { pri: "high", effort: 3 };
        if (tasks > 0 || pendingMsg) return { pri: "medium", effort: 2 };
        return { pri: "low", effort: 1 };
      }

      function statusDot(dotEl, rt, ageMs, health) {
        let color = "var(--status-idle)";
        if (!rt) color = "var(--status-blocked)";
        else if (health && health.ok) color = "var(--status-working)";
        else color = "var(--status-blocked)";
        dotEl.style.background = color;
        dotEl.classList.add("pulse");
        setTimeout(() => dotEl.classList.remove("pulse"), 250);
      }

      function renderAgent(agentKey, agent, statusId, dotId, bodyId, rawId) {
        const rt = agent.runtime;
        const age = agent.runtimeAgeMs;
        const health = agent.health;
        const status = el(statusId);
        const dot = el(dotId);
        const body = el(bodyId);
        const raw = el(rawId);

        status.textContent = rt
          ? (rt.status + (age != null ? (" · heartbeat " + fmtMs(age) + " ago") : "") + (health ? (" · " + health.reason) : ""))
          : "no runtime-status.json";
        statusDot(dot, rt, age, health);

        if (!rt) {
          body.innerHTML = '<div class="empty">Agent with no tasks — standing by.</div>';
          raw.textContent = "";
          return;
        }

        const q = rt.queue || {};
        const groups = q.groups || {};

        const cols = [
          { key: "working", title: "Working", tint: "var(--agent-alpha-subtle)" },
          { key: "blocked", title: "Blocked", tint: "var(--accent-subtle)" },
          { key: "idle", title: "Idle", tint: "var(--bg-secondary)" },
          { key: "done", title: "Done", tint: "var(--bg-secondary)" },
        ];

        const bucket = { working: [], blocked: [], idle: [], done: [] };
        for (const [jid, v] of Object.entries(groups)) {
          if (!v) continue;
          const c = classifyGroupCard(v);
          const isBlocked = (v.retryCount || 0) > 0;
          const isWorking = !!v.active || !!v.containerName || !!v.runningTaskId;
          const isIdle = !isWorking && !isBlocked && !v.pendingMessages && !(Number(v.pendingTaskCount || 0) > 0);
          const isDone = false;

          const colKey = isBlocked ? "blocked" : isWorking ? "working" : isDone ? "done" : isIdle ? "idle" : "working";
          bucket[colKey].push({ jid, v, c });
        }

        const agentPill = agentKey === "andy" ? "agent-pill agent-andy" : "agent-pill agent-bob";
        const agentInit = agentKey === "andy" ? "A" : "B";

        const backlog = agent.backlog || {};
        const summary =
          '<div class="kv" style="margin-bottom:14px">' +
            kv("pid", esc(rt.pid)) +
            kv("default trigger", '<span class="mono">' + esc(rt.defaultTrigger || "") + '</span>') +
            kv("channels", esc((rt.channels || []).map(c => c.name + (c.connected ? "✓" : "×")).join(", ") || "none")) +
            kv("health", '<span class="mono">' + esc(health?.reason || "n/a") + '</span>') +
            kv("next action", '<span class="mono">' + esc(agent.nextAction || "n/a") + '</span>') +
            kv("backlog", '<span class="mono">pendingMsgs(groups)=' + esc(backlog.pendingMessagesGroups ?? 0) + ', pendingTasks=' + esc(backlog.pendingTaskCount ?? 0) + '</span>') +
          '</div>';

        const kanban =
          '<div class="kanban">' +
          cols.map((col) => {
            const cards = bucket[col.key];
            const inner = cards.length
              ? cards.map((item, idx) => {
                  const v = item.v;
                  const title = v.groupFolder ? v.groupFolder : item.jid;
                  const metaBits = [];
                  if (v.pendingMessages) metaBits.push("pending messages");
                  const tcount = Number(v.pendingTaskCount || 0);
                  if (tcount > 0) metaBits.push(tcount + " task(s)");
                  if ((v.retryCount || 0) > 0) metaBits.push("retry ×" + v.retryCount);
                  if (v.runningTaskId) metaBits.push("task " + v.runningTaskId);
                  if (v.containerName) metaBits.push("container " + v.containerName);
                  const pri = item.c.pri;
                  const priCls = "pri-" + pri;
                  return (
                    '<div class="task ' + priCls + '" style="animation-delay:' + (idx * 40) + 'ms">' +
                      '<div class="task-top">' +
                        '<div class="task-title">' + esc(title) + '</div>' +
                        '<span class="' + agentPill + '">' + agentInit + '</span>' +
                      '</div>' +
                      '<div class="meta">' +
                        priLabel(pri) +
                        effort(item.c.effort) +
                        '<span class="mono muted">' + esc(metaBits.join(" · ") || "—") + '</span>' +
                      '</div>' +
                    '</div>'
                  );
                }).join("")
              : '<div class="empty">No tasks — standing by.</div>';

            const count = cards.length;
            return (
              '<div class="col" style="background:' + col.tint + '">' +
                '<div class="col-title"><div class="t">' + col.title + '</div><div class="c">' + count + '</div></div>' +
                '<div class="cards">' + inner + '</div>' +
              '</div>'
            );
          }).join("") +
          '</div>';

        const events = Array.isArray(agent.recentEvents) ? agent.recentEvents.slice(-6).reverse() : [];
        const eventsHtml =
          '<div class="events">' +
            '<div class="section-title" style="font-size:20px; margin: 16px 0 8px">Recent events</div>' +
            (events.length
              ? events.map((e) => {
                  const t = (e.at || "").slice(11,19);
                  const lvl = (e.level || "").toUpperCase();
                  const msg = e.msg || "";
                  const group = e.data && e.data.group ? (" · " + e.data.group) : "";
                  return '<div class="event"><div class="t">' + esc(t) + '</div><div class="m"><span class="lvl">' + esc(lvl) + '</span>' + esc(msg) + '<span style="color:var(--text-tertiary)">' + esc(group) + '</span></div></div>';
                }).join("")
              : '<div class="empty">No events yet.</div>') +
          '</div>';

        body.innerHTML = summary + kanban + eventsHtml;
        raw.textContent = JSON.stringify(rt, null, 2);
      }

      function renderAllowlists(a) {
        el("allowlists").innerHTML =
          kv("mount allowlist", '<span class="mono">' + esc(a.mountAllowlistPath) + '</span> (' + esc(a.mountCount) + ' entries)') +
          kv("sender allowlist", '<span class="mono">' + esc(a.senderAllowlistPath) + '</span> (' + esc(a.senderCount) + ' entries)');
      }

      async function tick() {
        const res = await fetch("/api/snapshot");
        const data = await res.json();
        el("updated").textContent = "updated " + new Date(data.at).toLocaleTimeString();
        renderAllowlists(data.allowlists);
        renderAgent("andy", data.agents.andy, "andy_status", "andy_dot", "andy_body", "andy_raw");
        renderAgent("bob", data.agents.bob, "bob_status", "bob_dot", "bob_body", "bob_raw");
      }

      tick().catch(() => {});
      setInterval(() => tick().catch(() => {}), 2000);

      el("new_task").addEventListener("click", () => alert("Read-only dashboard for now. Next: permission editor + task creator."));
    </script>
  </body>
</html>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (u.pathname === '/api/snapshot') {
    return sendJson(res, 200, snapshot());
  }
  if (u.pathname === '/' || u.pathname === '/index.html') {
    return sendHtml(res, 200, page);
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`Multi-agent dashboard listening on http://${HOST}:${PORT}`);
});

