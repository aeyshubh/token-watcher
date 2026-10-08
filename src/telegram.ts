const API_BASE = "https://api.telegram.org";
const MAX_ATTEMPTS = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface TelegramResponse<T> {
  ok: boolean;
  description?: string;
  result?: T;
  parameters?: { retry_after?: number };
}

async function call<T>(
  botToken: string,
  method: string,
  payload: Record<string, unknown>,
  timeoutMs = 15000,
): Promise<T> {
  let lastError: Error = new Error(`Telegram ${method} failed`);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(`${API_BASE}/bot${botToken}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });

      const json = (await res.json()) as TelegramResponse<T>;
      if (json.ok) {
        return json.result as T;
      }

      if (res.status === 429) {
        const waitMs = (json.parameters?.retry_after ?? attempt * 2) * 1000;
        lastError = new Error(`Telegram rate limited (retry in ${waitMs}ms)`);
        await sleep(waitMs);
        continue;
      }

      throw new Error(`Telegram error: ${json.description ?? res.status}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_ATTEMPTS) {
        await sleep(attempt * 1500);
      }
    }
  }

  throw lastError;
}

export async function sendMessage(
  botToken: string,
  chatId: string,
  text: string,
): Promise<void> {
  await call(botToken, "sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  });
}

/** Split text into <= limit chunks on line boundaries (Telegram caps at 4096). */
export function splitMessage(text: string, limit = 3900): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    if (current.length + line.length + 1 > limit && current) {
      chunks.push(current);
      current = "";
    }
    if (line.length > limit) {
      for (let i = 0; i < line.length; i += limit) chunks.push(line.slice(i, i + limit));
      continue;
    }
    current = current ? `${current}\n${line}` : line;
  }
  if (current) chunks.push(current);
  return chunks;
}

export async function sendLongMessage(
  botToken: string,
  chatId: string,
  text: string,
): Promise<void> {
  for (const chunk of splitMessage(text)) {
    await sendMessage(botToken, chatId, chunk);
  }
}

export interface TelegramChat {
  chat_id: number;
  type: string;
  username?: string;
  first_name?: string;
  text?: string;
}

interface Update {
  message?: { chat: TelegramChat; text?: string; date: number };
  edited_message?: { chat: TelegramChat; text?: string; date: number };
  my_chat_member?: { chat: TelegramChat; date: number };
}

export async function getChats(botToken: string): Promise<TelegramChat[]> {
  const updates = await call<Update[]>(botToken, "getUpdates", {}, 25000);
  const seen = new Map<number, TelegramChat>();
  for (const update of updates) {
    const msg = update.message ?? update.edited_message ?? update.my_chat_member;
    if (!msg) continue;
    const chat = msg.chat;
    seen.set(chat.chat_id, {
      chat_id: chat.chat_id,
      type: chat.type,
      username: chat.username,
      first_name: chat.first_name,
      text: "text" in msg ? (msg.text as string | undefined) : undefined,
    });
  }
  return [...seen.values()];
}

export interface IncomingMessage {
  updateId: number;
  messageId: number;
  chatId: number;
  text: string;
}

interface RawUpdate {
  update_id: number;
  message?: { message_id: number; chat: { id: number }; text?: string };
}

export async function getUpdates(
  botToken: string,
  offset: number,
  timeoutSec: number,
): Promise<IncomingMessage[]> {
  const updates = await call<RawUpdate[]>(
    botToken,
    "getUpdates",
    { offset, timeout: timeoutSec, allowed_updates: ["message"] },
    (timeoutSec + 10) * 1000,
  );

  const messages: IncomingMessage[] = [];
  for (const update of updates) {
    if (!update.message || typeof update.message.text !== "string") continue;
    messages.push({
      updateId: update.update_id,
      messageId: update.message.message_id,
      chatId: update.message.chat.id,
      text: update.message.text,
    });
  }
  return messages;
}

export interface BotCommand {
  command: string;
  description: string;
}

export async function setMyCommands(
  botToken: string,
  commands: BotCommand[],
): Promise<void> {
  await call(botToken, "setMyCommands", { commands });
}

export async function getMyCommands(botToken: string): Promise<BotCommand[]> {
  return call<BotCommand[]>(botToken, "getMyCommands", {});
}
