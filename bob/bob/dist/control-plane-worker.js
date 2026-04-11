process.env.NANOCLAW_PROCESS_ROLE ??= 'control-plane-worker';
import { AGENT_KEY, CONTROL_PLANE_URL } from './config.js';
import { ControlPlaneClient } from './control-plane-client.js';
import { resolveControlPlaneGroup } from './control-plane-executor.js';
import { createTelegramControlPlaneNotifier } from './control-plane-notifier.js';
import { createControlPlaneRunner } from './control-plane-runner.js';
import { cleanupOrphans, ensureContainerRuntimeRunning, } from './container-runtime.js';
import { initDatabase } from './db.js';
import { applySupportedEnvAliases } from './env.js';
import { logger } from './logger.js';
applySupportedEnvAliases();
export async function startControlPlaneWorker(opts = {}) {
    if (!CONTROL_PLANE_URL) {
        throw new Error('CONTROL_PLANE_URL is required');
    }
    if (!AGENT_KEY) {
        throw new Error('AGENT_KEY is required');
    }
    if (!opts.embedded) {
        ensureContainerRuntimeRunning();
        cleanupOrphans();
        initDatabase();
    }
    const client = new ControlPlaneClient({
        baseUrl: CONTROL_PLANE_URL,
        agentKey: AGENT_KEY,
    });
    const selection = resolveControlPlaneWorkerGroup();
    const notifier = createTelegramControlPlaneNotifier(selection.jid);
    const runner = createControlPlaneRunner({
        client,
        resolveGroup: () => selection,
        notifyLocalMessage: notifier
            ? async (message) => notifier.send(message)
            : undefined,
    });
    if (!opts.embedded) {
        const shutdown = (signal) => {
            logger.info({ signal }, 'Stopping control-plane worker');
            runner.stop();
            process.exit(0);
        };
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));
    }
    await runner.start();
}
function resolveControlPlaneWorkerGroup() {
    return resolveControlPlaneGroup();
}
const isDirectRun = process.argv[1] &&
    new URL(import.meta.url).pathname ===
        new URL(`file://${process.argv[1]}`).pathname;
if (isDirectRun) {
    startControlPlaneWorker().catch((err) => {
        logger.error({ err }, 'Failed to start control-plane worker');
        process.exit(1);
    });
}
//# sourceMappingURL=control-plane-worker.js.map