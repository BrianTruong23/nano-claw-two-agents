import { readEnvValue } from './env.js';

export interface ControlPlaneNotifier {
  send(text: string): Promise<void>;
}

export function createTelegramControlPlaneNotifier(
  jid: string,
): ControlPlaneNotifier | null {
  if (!jid.startsWith('tg:')) return null;

  const token = readEnvValue([
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_TOKEN',
    'TELEGRAM-TOKEN',
  ]);
  if (!token) return null;

  const chatId = Number(jid.slice(3));
  if (!Number.isFinite(chatId)) {
    throw new Error(`Invalid Telegram JID for notifier: ${jid}`);
  }

  return {
    async send(text: string): Promise<void> {
      const response = await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json; charset=utf-8',
          },
          body: JSON.stringify({
            chat_id: chatId,
            text,
          }),
        },
      );

      if (!response.ok) {
        throw new Error(
          `Telegram notifier sendMessage failed with ${response.status}`,
        );
      }

      const payload = (await response.json()) as {
        ok: boolean;
        description?: string;
      };
      if (!payload.ok) {
        throw new Error(
          payload.description || 'Telegram notifier returned ok=false',
        );
      }
    },
  };
}
