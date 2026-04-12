export type ResearchMode = 'andy' | 'verify' | 'collaborate';
export type ResearchModeSource = 'command' | 'classifier';
export interface ResearchModeDecision {
    mode: ResearchMode;
    source: ResearchModeSource;
    cleanedContent: string;
}
export declare function classifyResearchMode(content: string): ResearchModeDecision;
export declare function isResearchModeCommand(content: string): boolean;
export declare function shouldAgentRunForResearchMode(mode: ResearchMode, waitForBotResponse: boolean): boolean;
export declare function buildResearchModePrompt(formattedMessages: string, decision: ResearchModeDecision, assistantName: string, waitForBotResponse: boolean): string;
//# sourceMappingURL=research-mode.d.ts.map