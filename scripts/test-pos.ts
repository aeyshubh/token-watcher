import "dotenv/config";
import { analyzePositionInput } from "../src/position";

/**
 * Smoke-test the /pos analysis without Telegram.
 *
 *   npm run test-pos -- <position|pool|url> [wallet|pool]
 *   npm run test-pos -- --send <input...>     # also deliver to Telegram
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const send = argv.includes("--send");
  const args = argv.filter((a) => a !== "--send");

  if (args.length === 0) {
    console.error("Usage: npm run test-pos -- <position|pool|url> [wallet|pool] [--send]");
    process.exit(1);
  }

  const rpcUrl = process.env.SOLANA_RPC_URL?.trim() || "https://api.mainnet-beta.solana.com";
  const topWallets = Number(process.env.POS_TOP_WALLETS || 15);
  const input = args.join(" ");

  console.log(`Analysing "${input}" · rpc=${rpcUrl} · top=${topWallets}\n`);

  const started = Date.now();
  const sections = await analyzePositionInput(input, { rpcUrl, topWallets });
  const text = sections.join("\n\n");
  console.log(text);
  console.log(`\n[done in ${((Date.now() - started) / 1000).toFixed(1)}s]`);

  if (send) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID required for --send");
    const { sendLongMessage } = await import("../src/telegram");
    await sendLongMessage(token, chatId, text);
    console.log("Sent to Telegram.");
  }
}

main().catch((err) => {
  console.error(`test-pos failed: ${(err as Error).message}`);
  process.exit(1);
});
