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
    <title>NanoClaw — Multi-agent dashboard</title>
    <style>
      :root { color-scheme: light dark; }
      body { font: 14px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 16px; }
      .row { display: flex; gap: 12px; flex-wrap: wrap; }
      .card { border: 1px solid rgba(127,127,127,.35); border-radius: 10px; padding: 12px; min-width: 320px; flex: 1; }
      .title { display:flex; align-items:baseline; justify-content:space-between; gap: 8px; }
      .h { font-weight: 700; font-size: 16px; }
      .pill { font-size: 12px; padding: 2px 8px; border-radius: 999px; border: 1px solid rgba(127,127,127,.35); }
      .ok { background: rgba(46,204,113,.12); }
      .bad { background: rgba(231,76,60,.12); }
      .muted { opacity: .75; }
      .k { opacity: .75; }
      .grid { display: grid; grid-template-columns: 140px 1fr; gap: 6px 10px; margin-top: 10px; }
      .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      .events { margin-top: 10px; border-top: 1px solid rgba(127,127,127,.25); padding-top: 10px; }
      .event { display:flex; gap:8px; margin: 4px 0; }
      .event .t { width: 84px; opacity:.75; }
      .event .m { flex:1; }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
      .small { font-size: 12px; }
      details > summary { cursor: pointer; }
    </style>
  </head>
  <body>
    <div class="title">
      <div>
        <div class="h">NanoClaw — Multi-agent dashboard</div>
        <div class="muted small">Read-only snapshot of Andy + Bob runtime heartbeats. Auto-refreshes every 2s.</div>
      </div>
      <div class="pill" id="updated">loading…</div>
    </div>

    <div class="card" style="margin-top:12px">
      <div class="h">Permissions / allowlists</div>
      <div class="grid" id="allowlists"></div>
      <div class="muted small">Edit allowlists on the host, then restart agents to apply container mount decisions.</div>
    </div>

    <div class="row" style="margin-top:12px">
      <div class="card">
        <div class="title">
          <div class="h">Andy</div>
          <div class="pill" id="andy_status">…</div>
        </div>
        <div class="grid" id="andy"></div>
        <details style="margin-top:10px">
          <summary class="small">Raw runtime JSON</summary>
          <pre class="small" id="andy_raw"></pre>
        </details>
      </div>
      <div class="card">
        <div class="title">
          <div class="h">Bob</div>
          <div class="pill" id="bob_status">…</div>
        </div>
        <div class="grid" id="bob"></div>
        <details style="margin-top:10px">
          <summary class="small">Raw runtime JSON</summary>
          <pre class="small" id="bob_raw"></pre>
        </details>
      </div>
    </div>

    <script>
      const el = (id) => document.getElementById(id);
      const fmtMs = (ms) => {
        if (ms == null) return "n/a";
        if (ms < 1000) return ms + "ms";
        const s = Math.round(ms / 1000);
        if (s < 60) return s + "s";
        const m = Math.floor(s / 60);
        const r = s % 60;
        return m + "m " + r + "s";
      };
      const kv = (k, v) => '<div class="k">' + k + '</div><div>' + v + '</div>';
      const pill = (node, ok) => {
        node.classList.toggle('ok', ok);
        node.classList.toggle('bad', !ok);
      };

      function renderAgent(targetId, statusId, rawId, agent) {
        const grid = el(targetId);
        const status = el(statusId);
        const raw = el(rawId);
        const rt = agent.runtime;
        const age = agent.runtimeAgeMs;
        const isHealthy = agent.health && agent.health.ok === true;

        status.textContent = rt
          ? (rt.status + (age != null ? (" · heartbeat " + fmtMs(age) + " ago") : "") + (agent.health ? (" · " + agent.health.reason) : ""))
          : "no runtime-status.json";
        pill(status, isHealthy);

        if (!rt) {
          grid.innerHTML = kv("runtime file", "<code>" + agent.runtimePath + "</code>") +
                           kv("hint", "Start the agent to populate runtime status.");
          raw.textContent = "";
          return;
        }

        const q = rt.queue || {};
        const waiting = (q.waitingGroups || []).slice(0, 6).join(", ");
        const groups = q.groups || {};
        const active = Object.entries(groups).filter(([,v]) => v && v.active).map(([k]) => k).slice(0, 6).join(", ");
        const backlog = agent.backlog || {};
        const nextAction = agent.nextAction || "n/a";
        const events = Array.isArray(agent.recentEvents) ? agent.recentEvents.slice(-6).reverse() : [];

        grid.innerHTML =
          kv("pid", String(rt.pid)) +
          kv("default trigger", "<code>" + (rt.defaultTrigger || "") + "</code>") +
          kv("channels", (rt.channels || []).map(c => c.name + (c.connected ? "✓" : "×")).join(", ") || "none") +
          kv("queue", "active=" + (q.activeCount ?? 0) + ", waiting=" + ((q.waitingGroups || []).length)) +
          kv("backlog", "pendingMsgs(groups)=" + (backlog.pendingMessagesGroups ?? 0) + ", pendingTasks=" + (backlog.pendingTaskCount ?? 0)) +
          kv("next action", "<span class='mono'>" + nextAction.replace(/</g, "&lt;") + "</span>") +
          kv("active groups", active || "<span class='muted'>none</span>") +
          kv("waiting groups", waiting || "<span class='muted'>none</span>") +
          '<div class="events" style="grid-column:1 / -1">' +
            '<div class="h" style="font-size:13px; margin-bottom:6px">Recent events</div>' +
            (events.length ? events.map(e => {
              const t = (e.at || "").slice(11,19);
              const level = (e.level || "").toUpperCase();
              const msg = (e.msg || "");
              const group = e.data && e.data.group ? (" · " + e.data.group) : "";
              return '<div class="event"><div class="t">' + t + '</div><div class="m"><span class="pill">' + level + '</span> ' + msg.replace(/</g, "&lt;") + '<span class="muted">' + group.replace(/</g, "&lt;") + '</span></div></div>';
            }).join("") : "<div class=\"muted small\">No events yet.</div>") +
          '</div>';

        raw.textContent = JSON.stringify(rt, null, 2);
      }

      function renderAllowlists(a) {
        el("allowlists").innerHTML =
          kv("mount allowlist", "<code>" + a.mountAllowlistPath + "</code> (" + a.mountCount + " entries)") +
          kv("sender allowlist", "<code>" + a.senderAllowlistPath + "</code> (" + a.senderCount + " entries)");
      }

      async function tick() {
        const res = await fetch("/api/snapshot");
        const data = await res.json();
        el("updated").textContent = "updated " + new Date(data.at).toLocaleTimeString();
        renderAllowlists(data.allowlists);
        renderAgent("andy", "andy_status", "andy_raw", data.agents.andy);
        renderAgent("bob", "bob_status", "bob_raw", data.agents.bob);
      }

      tick().catch(() => {});
      setInterval(() => tick().catch(() => {}), 2000);
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

