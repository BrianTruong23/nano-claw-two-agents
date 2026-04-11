import fs from 'fs';
import path from 'path';
import { DATA_DIR, DEFAULT_TRIGGER } from './config.js';
const DASHBOARD_DIR = path.join(DATA_DIR, 'dashboard');
export const DASHBOARD_RUNTIME_FILE = path.join(DASHBOARD_DIR, 'runtime-status.json');
export const DASHBOARD_EVENTS_FILE = path.join(DASHBOARD_DIR, 'events.jsonl');
let runtimeState = null;
function ensureDashboardDir() {
    fs.mkdirSync(DASHBOARD_DIR, { recursive: true });
}
function writeJsonAtomic(filePath, value) {
    ensureDashboardDir();
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2) + '\n');
    fs.renameSync(tempPath, filePath);
}
export function initRuntimeDashboardState() {
    const now = new Date().toISOString();
    runtimeState = {
        role: 'agent',
        pid: process.pid,
        status: 'starting',
        startedAt: now,
        updatedAt: now,
        heartbeatAt: now,
        defaultTrigger: DEFAULT_TRIGGER,
        channels: [],
        queue: {
            activeCount: 0,
            waitingGroups: [],
            groups: {},
        },
    };
    writeJsonAtomic(DASHBOARD_RUNTIME_FILE, runtimeState);
}
export function updateRuntimeDashboardState(update) {
    if (!runtimeState)
        initRuntimeDashboardState();
    const now = new Date().toISOString();
    runtimeState = {
        ...runtimeState,
        ...update,
        updatedAt: now,
        heartbeatAt: update.heartbeatAt ?? now,
    };
    writeJsonAtomic(DASHBOARD_RUNTIME_FILE, runtimeState);
}
export function markRuntimeDashboardStopped(status = 'stopped') {
    updateRuntimeDashboardState({ status });
}
//# sourceMappingURL=dashboard-state.js.map