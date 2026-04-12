const COMMAND_PATTERNS = [
    [/^\/andy\b[:\s-]*/i, 'andy'],
    [/^\/verify\b[:\s-]*/i, 'verify'],
    [/^\/(?:col|collab|collaborate)\b[:\s-]*/i, 'collaborate'],
];
const VERIFY_PATTERNS = [
    /\b(?:verify|verification|fact[-\s]?check|double[-\s]?check|validate|audit|review|critique|proofread)\b/i,
    /\b(?:is this right|is that right|does this look right|sanity check)\b/i,
    /\b(?:check|confirm)\b.+\b(?:answer|claim|work|file|math|source|citation|logic|reasoning)\b/i,
];
const COLLABORATE_PATTERNS = [
    /\b(?:research|investigate|deep dive|brainstorm|compare|evaluate|analyze|analyse|strategy|plan|roadmap)\b/i,
    /\b(?:pros and cons|trade[-\s]?offs|multiple perspectives|joint answer|collaborate|work together)\b/i,
    /\b(?:help me decide|what should we do|best approach|options)\b/i,
];
export function classifyResearchMode(content) {
    const trimmed = content.trim();
    for (const [pattern, mode] of COMMAND_PATTERNS) {
        if (pattern.test(trimmed)) {
            const cleanedContent = trimmed.replace(pattern, '').trim();
            return {
                mode,
                source: 'command',
                cleanedContent: cleanedContent || trimmed,
            };
        }
    }
    if (VERIFY_PATTERNS.some((pattern) => pattern.test(trimmed))) {
        return { mode: 'verify', source: 'classifier', cleanedContent: trimmed };
    }
    if (COLLABORATE_PATTERNS.some((pattern) => pattern.test(trimmed)) ||
        trimmed.length >= 220) {
        return {
            mode: 'collaborate',
            source: 'classifier',
            cleanedContent: trimmed,
        };
    }
    return { mode: 'andy', source: 'classifier', cleanedContent: trimmed };
}
export function isResearchModeCommand(content) {
    const trimmed = content.trim();
    return COMMAND_PATTERNS.some(([pattern]) => pattern.test(trimmed));
}
export function shouldAgentRunForResearchMode(mode, waitForBotResponse) {
    const isSecondary = waitForBotResponse;
    if (mode === 'andy')
        return !isSecondary;
    return true;
}
export function buildResearchModePrompt(formattedMessages, decision, assistantName, waitForBotResponse) {
    const isSecondary = waitForBotResponse;
    const roleInstruction = getRoleInstruction(decision.mode, assistantName, isSecondary);
    return [
        `<research_group_mode mode="${decision.mode}" selected_by="${decision.source}">`,
        `Current user request, with any routing command removed: ${decision.cleanedContent}`,
        roleInstruction,
        '</research_group_mode>',
        '',
        formattedMessages,
    ].join('\n');
}
function getRoleInstruction(mode, assistantName, isSecondary) {
    if (mode === 'andy') {
        return `${assistantName}: answer as the primary assistant. No secondary verification is expected for this turn.`;
    }
    if (mode === 'verify') {
        if (isSecondary) {
            return [
                `${assistantName}: verify the primary assistant's answer instead of duplicating it.`,
                'Check the actual user request and the primary assistant reply in the message history.',
                'If the answer is correct, give a concise confirmation with any important caveat.',
                'If something is wrong, name the issue and provide the corrected answer.',
                'If a shared file is involved, inspect it with the workspace tools before confirming.',
            ].join(' ');
        }
        return `${assistantName}: provide the main answer first. Keep it complete enough to stand alone; the secondary assistant will verify afterward.`;
    }
    if (isSecondary) {
        return [
            `${assistantName}: collaborate with the primary assistant's reply and give the joint answer.`,
            'Use the primary answer as context, add your own independent check, resolve disagreements, and avoid merely repeating it.',
            'Present the final response as the combined Andy/Bob result.',
        ].join(' ');
    }
    return [
        `${assistantName}: start the collaboration with your best answer and reasoning.`,
        'Make useful progress on the request, and leave room for the secondary assistant to verify, add perspective, and synthesize.',
    ].join(' ');
}
//# sourceMappingURL=research-mode.js.map