export function normalizeControlPlaneTask(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return null;
    const record = raw;
    const id = pickString(record, ['id', 'taskId', 'uuid']);
    if (!id)
        return null;
    const status = (pickString(record, ['status']) || '').trim().toLowerCase();
    const title = pickString(record, ['title', 'name', 'summary']) || undefined;
    const displayId = pickString(record, ['taskNumber', 'identifier', 'slug']) || id;
    const prompt = buildPrompt(record, title);
    if (!prompt)
        return null;
    return {
        id,
        status,
        prompt,
        raw: record,
        displayId,
        title,
    };
}
export function isBacklogTask(task) {
    return task.status === 'backlog';
}
function buildPrompt(record, title) {
    const directPrompt = pickString(record, [
        'prompt',
        'body',
        'content',
        'description',
        'details',
        'instructions',
    ]);
    if (directPrompt)
        return directPrompt.trim();
    const pieces = [
        title ? `Task: ${title}` : null,
        pickString(record, ['acceptanceCriteria', 'acceptance_criteria']),
        pickString(record, ['goal', 'objective']),
    ].filter((value) => !!value && value.trim().length > 0);
    if (pieces.length === 0)
        return null;
    return pieces.join('\n\n').trim();
}
function pickString(record, keys) {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }
    return null;
}
//# sourceMappingURL=control-plane-task.js.map