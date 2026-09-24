import "dotenv/config";
import { getChats } from "../src/telegram";

async function main(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");

  const chats = await getChats(token);
  if (chats.length === 0) {
    console.log("No chats found. Open Telegram, message your bot, send /start, then re-run.");
    return;
  }

  console.log("Chats that have talked to this bot:");
  for (const chat of chats) {
    console.log(
      `  chat_id=${chat.chat_id}  type=${chat.type}` +
        `${chat.username ? `  @${chat.username}` : ""}` +
        `${chat.first_name ? `  (${chat.first_name})` : ""}` +
        `${chat.text ? `  last="${chat.text}"` : ""}`,
    );
  }
}

main().catch((err) => {
  console.error(`get-chat-id failed: ${(err as Error).message}`);
  process.exit(1);
});
