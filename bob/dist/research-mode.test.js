import { describe, expect, it } from 'vitest';
import { buildResearchModePrompt, classifyResearchMode, isResearchModeCommand, shouldAgentRunForResearchMode, } from './research-mode.js';
describe('research group mode classifier', () => {
    it('honors /andy commands', () => {
        expect(classifyResearchMode('/andy what is 2+2?')).toEqual({
            mode: 'andy',
            source: 'command',
            cleanedContent: 'what is 2+2?',
        });
    });
    it('honors /verify commands', () => {
        expect(classifyResearchMode('/verify check this answer')).toEqual({
            mode: 'verify',
            source: 'command',
            cleanedContent: 'check this answer',
        });
    });
    it('honors /col commands', () => {
        expect(classifyResearchMode('/col compare these options')).toEqual({
            mode: 'collaborate',
            source: 'command',
            cleanedContent: 'compare these options',
        });
    });
    it('classifies verification requests', () => {
        expect(classifyResearchMode('Can you double-check the math?').mode).toBe('verify');
    });
    it('classifies research requests as collaboration', () => {
        expect(classifyResearchMode('Research the best approach here').mode).toBe('collaborate');
    });
    it('defaults simple requests to Andy-only', () => {
        expect(classifyResearchMode('What is 2+2?').mode).toBe('andy');
    });
    it('detects mode commands', () => {
        expect(isResearchModeCommand('/collaborate hello')).toBe(true);
        expect(isResearchModeCommand('collaborate hello')).toBe(false);
    });
    it('runs only the primary assistant for Andy-only mode', () => {
        expect(shouldAgentRunForResearchMode('andy', false)).toBe(true);
        expect(shouldAgentRunForResearchMode('andy', true)).toBe(false);
    });
    it('runs both assistants for verify and collaborate modes', () => {
        expect(shouldAgentRunForResearchMode('verify', false)).toBe(true);
        expect(shouldAgentRunForResearchMode('verify', true)).toBe(true);
        expect(shouldAgentRunForResearchMode('collaborate', false)).toBe(true);
        expect(shouldAgentRunForResearchMode('collaborate', true)).toBe(true);
    });
    it('wraps prompts with mode and cleaned request', () => {
        const prompt = buildResearchModePrompt('<messages />', {
            mode: 'verify',
            source: 'command',
            cleanedContent: 'check this',
        }, 'Bob', true);
        expect(prompt).toContain('<research_group_mode mode="verify"');
        expect(prompt).toContain('check this');
        expect(prompt).toContain('verify the primary assistant');
        expect(prompt).toContain('<messages />');
    });
});
//# sourceMappingURL=research-mode.test.js.map