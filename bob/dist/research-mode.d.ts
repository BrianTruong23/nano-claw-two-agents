/**
 * Research-style routing (used only in multi-user group chats, not DMs):
 *
 * All messages route to **verify** mode. The `/verify` and `/collaborate`
 * slash commands are still accepted (they strip the prefix) but both resolve
 * to verify. Per-bot @mentions / group triggers are unchanged in the router.
 *
 * This is intentionally lightweight pattern matching, not an LLM classifier.
 */
export type ResearchMode = 'verify';
export type ResearchModeSource = 'command' | 'classifier';
export interface ResearchModeDecision {
    mode: ResearchMode;
    source: ResearchModeSource;
    cleanedContent: string;
}
export declare function classifyResearchMode(content: string): ResearchModeDecision;
export declare function isResearchModeCommand(content: string): boolean;
export declare function shouldAgentRunForResearchMode(_mode: ResearchMode, _waitForBotResponse: boolean): boolean;
/**
 * Short line posted to the group before this bot's container reply, so users see
 * how the classifier (or slash command) routed the turn.
 */
export declare function formatResearchModeUserNotice(decision: ResearchModeDecision, assistantName: string, waitForBotResponse: boolean): string;
export declare function buildResearchModePrompt(formattedMessages: string, decision: ResearchModeDecision, assistantName: string, waitForBotResponse: boolean): string;
//# sourceMappingURL=research-mode.d.ts.map