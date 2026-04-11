import { ControlPlaneClient } from './control-plane-client.js';
import { executeControlPlaneTask, resolveControlPlaneGroup } from './control-plane-executor.js';
export interface ControlPlaneRunnerDeps {
    client?: Pick<ControlPlaneClient, 'bootstrap' | 'heartbeat' | 'getTasks' | 'updateTask' | 'postMessage'>;
    executeTask?: typeof executeControlPlaneTask;
    resolveGroup?: typeof resolveControlPlaneGroup;
    sleep?: (ms: number) => Promise<void>;
    heartbeatIntervalMs?: number;
    pollIntervalMs?: number;
    includeBacklog?: boolean;
    successStatus?: string;
    failureStatus?: string;
    notifyLocalMessage?: (message: string) => Promise<void>;
}
export declare function createControlPlaneRunner(deps: ControlPlaneRunnerDeps): {
    start(): Promise<void>;
    stop(): void;
    pollOnce(): Promise<void>;
    getActiveTaskId(): string | null;
    getLastBootstrap(): any;
};
//# sourceMappingURL=control-plane-runner.d.ts.map