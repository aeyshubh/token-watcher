import { sendMessage, sendLongMessage, getUpdates, setMyCommands } from "./telegram";
import { handleCommand, BOT_COMMANDS } from "./commands";
import { loadLpConfig, startLpTracker, type LpTrackerHandle } from "./lp";
import { loadCloseConfig } from "./close-config";
import { startCloseExecutor, type CloseExecutorHandle } from "./executor";
import { loadSettings, requireTelegramChatId } from "./settings";

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

async function drainUpdates(botToken: string): Promise<number> {
  try {
    const updates = await getUpdates(botToken, 0, 0);
    const maxId = updates.reduce((max, update) => Math.max(max, update.updateId), 0);
    return maxId + 1;
  } catch (err) {
    log(`could not drain pending updates: ${(err as Error).message}`);
    return 0;
  }
}

async function main(): Promise<void> {
  const settings = loadSettings();
  const botToken = required("TELEGRAM_BOT_TOKEN");
  const chatId = requireTelegramChatId();

  const lpEnabled = settings.lp.enabled;
  const executorEnabled = settings.executor.enabled;

  log(
    `tokenWatcher started · chat=${chatId} · ` +
      `lp=${lpEnabled ? "on" : "off"} · executor=${executorEnabled ? "on" : "off"}`,
  );

  const reply = (text: string): Promise<void> => sendMessage(botToken, chatId, text);
  const replyLong = (text: string): Promise<void> => sendLongMessage(botToken, chatId, text);

  try {
    await setMyCommands(botToken, BOT_COMMANDS);
    log("registered bot command menu");
  } catch (err) {
    log(`could not register command menu: ${(err as Error).message}`);
  }

  let close: CloseExecutorHandle | undefined;
  if (executorEnabled) {
    try {
      const closeConfig = loadCloseConfig({ botToken, chatId });
      if (!closeConfig) {
        log("auto-close executor disabled: set LP_EXECUTOR_PRIVATE_KEY in .env to enable it");
      } else {
        close = startCloseExecutor(closeConfig, { send: reply, log });
      }
    } catch (err) {
      log(`could not start auto-close executor: ${(err as Error).message}`);
    }
  }

  let lp: LpTrackerHandle | undefined;
  if (lpEnabled) {
    try {
      const lpConfig = loadLpConfig({ botToken, chatId });
      if (lpConfig.wallets.length === 0) {
        log("LP tracker disabled: config/lp-wallets.json has no wallets");
      } else {
        lp = startLpTracker(lpConfig, { onTick: close?.onTick });
      }
    } catch (err) {
      log(`could not start LP tracker: ${(err as Error).message}`);
    }
  }

  if (close && !lp) {
    log("auto-close executor will not run: LP tracker is disabled or has no wallets");
  }

  let running = true;

  const shutdown = (signal: string): void => {
    if (!running) return;
    running = false;
    log(`received ${signal}, shutting down`);
    lp?.stop();
    close?.stop();
    setTimeout(() => process.exit(0), 50);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  const runCommandLoop = async (): Promise<void> => {
    let offset = await drainUpdates(botToken);
    while (running) {
      try {
        const updates = await getUpdates(botToken, offset, 30);
        for (const update of updates) {
          offset = update.updateId + 1;
          if (String(update.chatId) !== chatId) continue;
          try {
            await handleCommand(update.text, {
              reply,
              replyLong,
              lp,
              close,
            });
          } catch (err) {
            log(`command error: ${(err as Error).message}`);
          }
        }
      } catch (err) {
        log(`command loop error: ${(err as Error).message}`);
        await sleep(3000);
      }
    }
  };

  void runCommandLoop();
}

main().catch((err) => {
  console.error(`[tokenWatcher] fatal: ${(err as Error).message}`);
  process.exit(1);
});
