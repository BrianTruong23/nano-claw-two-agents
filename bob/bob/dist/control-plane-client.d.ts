export interface ControlPlaneTaskUpdate {
    claim?: boolean;
    status?: string;
    message?: string;
}
export interface ControlPlaneMessagePayload {
    taskId?: string;
    body: string;
}
export interface ControlPlaneHeartbeatPayload {
    status: string;
    metadata?: Record<string, unknown>;
}
export interface ControlPlaneClientOptions {
    baseUrl: string;
    agentKey: string;
    fetchImpl?: typeof fetch;
}
export declare class ControlPlaneClient {
    private readonly baseUrl;
    private readonly agentKey;
    private readonly fetchImpl;
    constructor(options: ControlPlaneClientOptions);
    bootstrap(): Promise<any>;
    heartbeat(status: string, metadata?: Record<string, unknown>): Promise<any>;
    getTasks(includeBacklog?: boolean): Promise<any[]>;
    updateTask(taskId: string, payload: ControlPlaneTaskUpdate): Promise<any>;
    getMessages(taskId?: string): Promise<any[]>;
    postMessage(payload: ControlPlaneMessagePayload): Promise<any>;
    private request;
}
//# sourceMappingURL=control-plane-client.d.ts.map