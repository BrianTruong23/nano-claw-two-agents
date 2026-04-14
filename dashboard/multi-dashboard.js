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

function snapshot() {
  const allowlists = readAllowlistSummary();
  const andy = readJson(ANDY_RUNTIME);
  const bob = readJson(BOB_RUNTIME);
  return {
    at: new Date().toISOString(),
    repoRoot: REPO_ROOT,
    allowlists,
    agents: {
      andy: {
        runtimePath: ANDY_RUNTIME,
        runtimeAgeMs: fileAgeMs(ANDY_RUNTIME),
        runtime: andy,
      },
      bob: {
        runtimePath: BOB_RUNTIME,
        runtimeAgeMs: fileAgeMs(BOB_RUNTIME),
        runtime: bob,
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
        const isHealthy = rt && rt.status === 'running' && age != null && age < 15000;

        status.textContent = rt ? (rt.status + (age != null ? (" · heartbeat " + fmtMs(age) + " ago") : "")) : "no runtime-status.json";
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

        grid.innerHTML =
          kv("pid", String(rt.pid)) +
          kv("default trigger", "<code>" + (rt.defaultTrigger || "") + "</code>") +
          kv("channels", (rt.channels || []).map(c => c.name + (c.connected ? "✓" : "×")).join(", ") || "none") +
          kv("queue", "active=" + (q.activeCount ?? 0) + ", waiting=" + ((q.waitingGroups || []).length)) +
          kv("active groups", active || "<span class='muted'>none</span>") +
          kv("waiting groups", waiting || "<span class='muted'>none</span>");

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

