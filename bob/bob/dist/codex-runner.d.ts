export interface CodexRunResult {
    ok: boolean;
    text?: string;
    error?: string;
}
export declare function runCodexExec(prompt: string, cwd: string): Promise<CodexRunResult>;
//# sourceMappingURL=codex-runner.d.ts.map