import { readEnvValue } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel } from './registry.js';
function getTelegramToken() {
    return readEnvValue([
        'TELEGRAM_BOT_TOKEN',
        'TELEGRAM_TOKEN',
        'TELEGRAM-TOKEN',
    ]);
}
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function buildSenderName(user) {
    if (!user)
        return 'Unknown';
    const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ');
    return fullName || user.username || `Telegram User ${user.id}`;
}
function buildChatName(chat) {
    if (chat.title)
        return chat.title;
    const fullName = [chat.first_name, chat.last_name].filter(Boolean).join(' ');
    return fullName || chat.username || `Telegram ${chat.id}`;
}
function extractMessageText(message) {
    return message.text || message.caption || '[non-text Telegram message]';
}
class TelegramChannel {
    opts;
    token;
    name = 'telegram';
    connected = false;
    offset = 0;
    botUserId = null;
    pollPromise = null;
    abortController = null;
    constructor(opts, token) {
        this.opts = opts;
        this.token = token;
    }
    async connect() {
        if (this.connected)
            return;
        const me = await this.api('getMe');
        this.botUserId = me.id;
        this.connected = true;
        logger.info({ botUserId: me.id }, 'Telegram channel connected');
        this.pollPromise = this.pollLoop();
    }
    isConnected() {
        return this.connected;
    }
    ownsJid(jid) {
        return jid.startsWith('tg:');
    }
    async disconnect() {
        this.connected = false;
        this.abortController?.abort();
        try {
            await this.pollPromise;
        }
        catch {
            // ignore abort-related errors during shutdown
        }
        logger.info('Telegram channel disconnected');
    }
    async sendMessage(jid, text) {
        const chatId = this.chatIdFromJid(jid);
        const sent = await this.api('sendMessage', {
            method: 'POST',
            body: {
                chat_id: chatId,
                text,
            },
        });
        const timestamp = new Date(sent.date * 1000).toISOString();
        this.opts.onMessage(jid, {
            id: String(sent.message_id),
            chat_jid: jid,
            sender: sent.from
                ? `tg:user:${sent.from.id}`
                : `tg:user:${this.botUserId}`,
            sender_name: buildSenderName(sent.from),
            content: extractMessageText(sent),
            timestamp,
            is_from_me: true,
            is_bot_message: true,
        });
    }
    async setTyping(jid, isTyping) {
        if (!isTyping)
            return;
        const chatId = this.chatIdFromJid(jid);
        await this.api('sendChatAction', {
            method: 'POST',
            body: {
                chat_id: chatId,
                action: 'typing',
            },
        });
    }
    chatIdFromJid(jid) {
        if (!jid.startsWith('tg:')) {
            throw new Error(`Invalid Telegram JID: ${jid}`);
        }
        const raw = jid.slice(3);
        const chatId = Number(raw);
        if (!Number.isFinite(chatId)) {
            throw new Error(`Invalid Telegram chat ID: ${jid}`);
        }
        return chatId;
    }
    async pollLoop() {
        while (this.connected) {
            this.abortController = new AbortController();
            try {
                const updates = await this.api('getUpdates', {
                    query: {
                        timeout: '25',
                        offset: String(this.offset),
                        allowed_updates: JSON.stringify(['message', 'edited_message']),
                    },
                    signal: this.abortController.signal,
                });
                for (const update of updates) {
                    this.offset = update.update_id + 1;
                    await this.handleUpdate(update);
                }
            }
            catch (err) {
                if (!this.connected)
                    break;
                if (err instanceof Error && err.name === 'AbortError')
                    break;
                logger.warn({ err }, 'Telegram polling failed');
                await delay(2000);
            }
            finally {
                this.abortController = null;
            }
        }
    }
    async handleUpdate(update) {
        const message = update.message || update.edited_message;
        if (!message)
            return;
        const chatJid = `tg:${message.chat.id}`;
        const timestamp = new Date((message.edit_date || message.date) * 1000).toISOString();
        this.opts.onChatMetadata(chatJid, timestamp, buildChatName(message.chat), 'telegram', message.chat.type !== 'private');
        const inbound = {
            id: String(message.message_id),
            chat_jid: chatJid,
            sender: message.from ? `tg:user:${message.from.id}` : chatJid,
            sender_name: buildSenderName(message.from),
            content: extractMessageText(message),
            timestamp,
            is_from_me: this.botUserId !== null && message.from?.id === this.botUserId,
            reply_to_message_id: message.reply_to_message
                ? String(message.reply_to_message.message_id)
                : undefined,
            reply_to_message_content: message.reply_to_message
                ? extractMessageText(message.reply_to_message)
                : undefined,
            reply_to_sender_name: message.reply_to_message?.from
                ? buildSenderName(message.reply_to_message.from)
                : undefined,
        };
        this.opts.onMessage(chatJid, inbound);
    }
    async api(method, options) {
        const url = new URL(`https://api.telegram.org/bot${this.token}/${method}`);
        if (options?.query) {
            for (const [key, value] of Object.entries(options.query)) {
                url.searchParams.set(key, value);
            }
        }
        const response = await fetch(url, {
            method: options?.method || 'GET',
            headers: options?.body
                ? { 'content-type': 'application/json; charset=utf-8' }
                : undefined,
            body: options?.body ? JSON.stringify(options.body) : undefined,
            signal: options?.signal,
        });
        if (!response.ok) {
            throw new Error(`Telegram API ${method} failed with ${response.status}`);
        }
        const payload = (await response.json());
        if (!payload.ok) {
            throw new Error(payload.description || `Telegram API ${method} returned ok=false`);
        }
        return payload.result;
    }
}
registerChannel('telegram', (opts) => {
    const token = getTelegramToken();
    if (!token)
        return null;
    return new TelegramChannel(opts, token);
});
//# sourceMappingURL=telegram.js.map