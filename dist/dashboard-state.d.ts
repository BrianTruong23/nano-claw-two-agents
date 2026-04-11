import { GroupQueueSnapshot } from './group-queue.js';
export type RuntimeLifecycleStatus = 'starting' | 'running' | 'shutting_down' | 'stopped' | 'error';
export interface RuntimeChannelStatus {
    name: string;
    connected: boolean;
}
export interface RuntimeDashboardState {
    role: 'agent';
    pid: number;
    status: RuntimeLifecycleStatus;
    startedAt: string;
    updatedAt: string;
    heartbeatAt: string;
    defaultTrigger: string;
    channels: RuntimeChannelStatus[];
    queue: GroupQueueSnapshot;
}
type RuntimeDashboardUpdate = Partial<Omit<RuntimeDashboardState, 'role' | 'pid' | 'startedAt' | 'defaultTrigger'>>;
export declare const DASHBOARD_RUNTIME_FILE: string;
export declare const DASHBOARD_EVENTS_FILE: string;
export declare function initRuntimeDashboardState(): void;
export declare function updateRuntimeDashboardState(update: RuntimeDashboardUpdate): void;
export declare function markRuntimeDashboardStopped(status?: Extract<RuntimeLifecycleStatus, 'stopped' | 'error'>): void;
export {};
//# sourceMappingURL=dashboard-state.d.ts.map