import "dotenv/config";
import { getMyCommands, setMyCommands } from "../src/telegram";
import { BOT_COMMANDS } from "../src/commands";

async function main(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");

  await setMyCommands(token, BOT_COMMANDS);

  const current = await getMyCommands(token);
  console.log(`Registered ${current.length} commands (visible in the "/" menu):`);
  for (const command of current) {
    console.log(`  /${command.command} — ${command.description}`);
  }
}

main().catch((err) => {
  console.error(`set-commands failed: ${(err as Error).message}`);
  process.exit(1);
});
