import { ContainerOutput } from './container-runner.js';
import { RegisteredGroup } from './types.js';
export interface ControlPlaneGroupSelection {
    jid: string;
    group: RegisteredGroup;
}
export interface ExecuteControlPlaneTaskOptions {
    taskId: string;
    prompt: string;
    onOutput?: (output: ContainerOutput) => Promise<void>;
}
export interface ExecuteControlPlaneTaskResult {
    status: 'success' | 'error';
    result: string | null;
    error?: string;
}
export declare function resolveControlPlaneGroup(requestedFolder?: string | undefined): ControlPlaneGroupSelection;
export declare function executeControlPlaneTask(selection: ControlPlaneGroupSelection, options: ExecuteControlPlaneTaskOptions): Promise<ExecuteControlPlaneTaskResult>;
//# sourceMappingURL=control-plane-executor.d.ts.map