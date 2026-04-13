import { ChildProcess } from 'child_process';
export interface GroupQueueSnapshot {
    activeCount: number;
    waitingGroups: string[];
    groups: Record<string, {
        active: boolean;
        idleWaiting: boolean;
        isTaskContainer: boolean;
        runningTaskId: string | null;
        pendingMessages: boolean;
        pendingTaskCount: number;
        containerName: string | null;
        groupFolder: string | null;
        retryCount: number;
    }>;
}
export declare class GroupQueue {
    private groups;
    private activeCount;
    private waitingGroups;
    private processMessagesFn;
    private shuttingDown;
    private getGroup;
    setProcessMessagesFn(fn: (groupJid: string) => Promise<boolean>): void;
    getSnapshot(): GroupQueueSnapshot;
    enqueueMessageCheck(groupJid: string): void;
    enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void;
    registerProcess(groupJid: string, proc: ChildProcess, containerName: string, groupFolder?: string): void;
    /**
     * Mark the container as idle-waiting (finished work, waiting for IPC input).
     * If tasks are pending, preempt the idle container immediately.
     */
    notifyIdle(groupJid: string): void;
    /**
     * Whether {@link sendMessage} would accept a write right now (sync check).
     * Used so we can post a user-visible banner only when piping, and avoid
     * duplicating the banner in {@link processMessagesFn} when we enqueue instead.
     */
    canPipeMessage(groupJid: string): boolean;
    /**
     * Send a follow-up message to the active container via IPC file.
     * Returns true if the message was written, false if no active container.
     */
    sendMessage(groupJid: string, text: string): boolean;
    /**
     * Signal the active container to wind down by writing a close sentinel.
     */
    closeStdin(groupJid: string): void;
    private runForGroup;
    private runTask;
    private scheduleRetry;
    private drainGroup;
    private drainWaiting;
    shutdown(_gracePeriodMs: number): Promise<void>;
}
//# sourceMappingURL=group-queue.d.ts.map