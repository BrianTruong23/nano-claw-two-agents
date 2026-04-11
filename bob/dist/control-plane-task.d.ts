export interface NormalizedControlPlaneTask {
    id: string;
    status: string;
    prompt: string;
    raw: Record<string, unknown>;
    displayId: string;
    title?: string;
}
export declare function normalizeControlPlaneTask(raw: unknown): NormalizedControlPlaneTask | null;
export declare function isBacklogTask(task: NormalizedControlPlaneTask): boolean;
//# sourceMappingURL=control-plane-task.d.ts.map