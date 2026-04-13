import { describe, expect, it } from 'vitest';
import { buildResearchModePrompt, classifyResearchMode, isResearchModeCommand, shouldAgentRunForResearchMode, } from './research-mode.js';
describe('research group mode classifier', () => {
    it('honors /verify commands', () => {
        expect(classifyResearchMode('/verify check this answer')).toEqual({
            mode: 'verify',
            source: 'command',
            cleanedContent: 'check this answer',
        });
    });
    it('routes /col commands to verify', () => {
        expect(classifyResearchMode('/col compare these options')).toEqual({
            mode: 'verify',
            source: 'command',
            cleanedContent: 'compare these options',
        });
    });
    it('classifies verification requests', () => {
        expect(classifyResearchMode('Can you double-check the math?').mode).toBe('verify');
    });
    it('routes all messages to verify', () => {
        expect(classifyResearchMode('Research the best approach here').mode).toBe('verify');
    });
    it('defaults simple requests to verify', () => {
        expect(classifyResearchMode('What is 2+2?').mode).toBe('verify');
    });
    it('routes /andy text to verify', () => {
        expect(classifyResearchMode('/andy what is 2+2?').mode).toBe('verify');
    });
    it('detects mode commands', () => {
        expect(isResearchModeCommand('/collaborate hello')).toBe(true);
        expect(isResearchModeCommand('collaborate hello')).toBe(false);
    });
    it('runs both assistants for verify mode', () => {
        expect(shouldAgentRunForResearchMode('verify', false)).toBe(true);
        expect(shouldAgentRunForResearchMode('verify', true)).toBe(true);
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
        expect(prompt).toContain('at most 2 short sentences');
        expect(prompt).toContain('@Andy');
        expect(prompt).toContain('<messages />');
    });
});
//# sourceMappingURL=research-mode.test.js.map