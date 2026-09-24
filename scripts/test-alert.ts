import "dotenv/config";
import { sendMessage } from "../src/telegram";

async function main(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");
  if (!chatId) throw new Error("TELEGRAM_CHAT_ID is required");

  await sendMessage(
    token,
    chatId,
    `✅ tokenWatcher test alert\nIf you can read this, the Telegram pipe works.\n${new Date().toISOString()}`,
  );
  console.log(`Test alert sent to chat ${chatId}.`);
}

main().catch((err) => {
  console.error(`test-alert failed: ${(err as Error).message}`);
  process.exit(1);
});
