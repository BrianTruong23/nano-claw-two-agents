export class ControlPlaneClient {
    baseUrl;
    agentKey;
    fetchImpl;
    constructor(options) {
        this.baseUrl = options.baseUrl.replace(/\/+$/, '');
        this.agentKey = options.agentKey;
        this.fetchImpl = options.fetchImpl || fetch;
    }
    async bootstrap() {
        return this.request('GET', '/api/agent/bootstrap');
    }
    async heartbeat(status, metadata) {
        return this.request('POST', '/api/agent/heartbeat', {
            status,
            metadata,
        });
    }
    async getTasks(includeBacklog = false) {
        const search = includeBacklog ? '?includeBacklog=true' : '';
        const result = await this.request('GET', `/api/agent/tasks${search}`);
        if (Array.isArray(result))
            return result;
        if (Array.isArray(result?.tasks))
            return result.tasks;
        return [];
    }
    async updateTask(taskId, payload) {
        return this.request('PATCH', `/api/agent/tasks/${encodeURIComponent(taskId)}`, payload);
    }
    async getMessages(taskId) {
        const search = taskId ? `?taskId=${encodeURIComponent(taskId)}` : '';
        const result = await this.request('GET', `/api/agent/messages${search}`);
        if (Array.isArray(result))
            return result;
        if (Array.isArray(result?.messages))
            return result.messages;
        return [];
    }
    async postMessage(payload) {
        return this.request('POST', '/api/agent/messages', payload);
    }
    async request(method, path, body) {
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
            method,
            headers: {
                'x-agent-key': this.agentKey,
                ...(body ? { 'content-type': 'application/json' } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await response.text();
        const parsed = text ? safeJsonParse(text) : null;
        if (!response.ok) {
            const message = (parsed && typeof parsed.error === 'string' && parsed.error) ||
                text ||
                response.statusText;
            throw new Error(`Control plane ${method} ${path} failed: ${response.status} ${message}`);
        }
        return parsed;
    }
}
function safeJsonParse(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return text;
    }
}
//# sourceMappingURL=control-plane-client.js.map