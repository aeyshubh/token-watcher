import { loadConfig } from "./config";
import { getTokenInfo } from "./gmgn";
import { sendMessage, sendLongMessage, getUpdates, setMyCommands } from "./telegram";
import { loadState, saveState } from "./state";
import { formatAlert, formatPrice, isHit, targetKey } from "./alerts";
import { WatchStore } from "./store";
import { handleCommand, BOT_COMMANDS } from "./commands";
import { loadScoutConfig, startScout, type ScoutHandle } from "./scout";
import type { AppConfig, FiredState } from "./types";

const CHAIN = "sol";

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function priceTick(
  config: AppConfig,
  store: WatchStore,
  state: FiredState,
): Promise<void> {
  for (const item of store.list()) {
    const label = item.symbol ?? item.address;
    const key = targetKey(item);

    let info;
    try {
      info = await getTokenInfo(config.gmgnApiKey, CHAIN, item.address);
    } catch (err) {
      log(`fetch failed for ${label}: ${(err as Error).message}`);
      continue;
    }

    const price = info.price;
    const hit = isHit(price, item);
    const alreadyFired = Boolean(state[key]);

    log(
      `${info.symbol || label} $${formatPrice(price)} vs ${item.target.direction} ` +
        `$${formatPrice(item.target.price)} -> ${hit ? "HIT" : "wait"}` +
        `${alreadyFired ? " (already fired)" : ""}`,
    );

    if (alreadyFired || !hit) continue;

    const pings = item.pings || config.pingCount;
    for (let i = 1; i <= pings; i += 1) {
      const text = formatAlert({
        symbol: info.symbol || label,
        price,
        target: item.target.price,
        direction: item.target.direction,
        address: item.address,
        index: i,
        total: pings,
        when: new Date(),
      });
      try {
        await sendMessage(config.telegramBotToken, config.telegramChatId, text);
        log(`sent ping ${i}/${pings} for ${label}`);
      } catch (err) {
        log(`telegram send failed (${i}/${pings}) for ${label}: ${(err as Error).message}`);
      }
      if (i < pings) await sleep(config.pingDelayMs);
    }

    state[key] = { firedAt: new Date().toISOString(), price };
    saveState(state);
    log(`target fired for ${label}; persisted to state.json`);
  }
}

async function drainUpdates(config: AppConfig): Promise<number> {
  try {
    const updates = await getUpdates(config.telegramBotToken, 0, 0);
    const maxId = updates.reduce((max, update) => Math.max(max, update.updateId), 0);
    return maxId + 1;
  } catch (err) {
    log(`could not drain pending updates: ${(err as Error).message}`);
    return 0;
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new WatchStore();
  const state = loadState();

  const scoutEnabled = (process.env.SCOUT_ENABLED ?? "true").toLowerCase() !== "false";

  log(
    `tokenWatcher started · poll=${config.pollIntervalMs}ms · ` +
      `tokens=${store.count()} · chat=${config.telegramChatId} · ` +
      `scout=${scoutEnabled ? "on" : "off"}`,
  );

  try {
    await setMyCommands(config.telegramBotToken, BOT_COMMANDS);
    log("registered bot command menu");
  } catch (err) {
    log(`could not register command menu: ${(err as Error).message}`);
  }

  let scout: ScoutHandle | undefined;
  if (scoutEnabled) {
    try {
      scout = startScout(
        loadScoutConfig({
          botToken: config.telegramBotToken,
          chatId: config.telegramChatId,
        }),
      );
    } catch (err) {
      log(`could not start scout: ${(err as Error).message}`);
    }
  }

  let running = true;
  const timers: NodeJS.Timeout[] = [];

  const shutdown = (signal: string): void => {
    if (!running) return;
    running = false;
    log(`received ${signal}, shutting down`);
    scout?.stop();
    for (const timer of timers) clearTimeout(timer);
    setTimeout(() => process.exit(0), 50);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  const reply = (text: string): Promise<void> =>
    sendMessage(config.telegramBotToken, config.telegramChatId, text);

  const replyLong = (text: string): Promise<void> =>
    sendLongMessage(config.telegramBotToken, config.telegramChatId, text);

  const runPriceLoop = async (): Promise<void> => {
    try {
      await priceTick(config, store, state);
    } catch (err) {
      log(`tick error: ${(err as Error).message}`);
    }
    if (running) timers.push(setTimeout(runPriceLoop, config.pollIntervalMs));
  };

  const runCommandLoop = async (): Promise<void> => {
    let offset = await drainUpdates(config);
    while (running) {
      try {
        const updates = await getUpdates(config.telegramBotToken, offset, 30);
        for (const update of updates) {
          offset = update.updateId + 1;
          if (String(update.chatId) !== config.telegramChatId) continue;
          try {
            await handleCommand(update.text, { config, store, state, saveState, reply, replyLong });
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

  void runPriceLoop();
  void runCommandLoop();
}

main().catch((err) => {
  console.error(`[tokenWatcher] fatal: ${(err as Error).message}`);
  process.exit(1);
});
