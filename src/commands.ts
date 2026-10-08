import type { AppConfig, Direction, FiredState, WatchItem } from "./types";
import type { WatchStore } from "./store";
import { getTokenInfo } from "./gmgn";
import { formatPrice, isHit } from "./alerts";
import { analyzePositionInput } from "./position";

const CHAIN = "sol";

export interface CommandContext {
  config: AppConfig;
  store: WatchStore;
  state: FiredState;
  saveState: (state: FiredState) => void;
  reply: (text: string) => Promise<void>;
  replyLong: (text: string) => Promise<void>;
}

export interface BotCommand {
  command: string;
  description: string;
}

export const BOT_COMMANDS: BotCommand[] = [
  { command: "pos", description: "Analyse an LP position + top wallets: /pos <position|pool> [wallet|pool]" },
  { command: "add", description: "Track a mint: /add <mint> <target> [above|below]" },
  { command: "list", description: "Show tracked mints with live price + status" },
  { command: "remove", description: "Stop tracking a mint: /remove <mint>" },
  { command: "clear", description: "Stop tracking everything" },
  { command: "reload", description: "Reload watchlist.json from disk" },
  { command: "help", description: "Show all commands" },
  { command: "start", description: "Show all commands" },
];

const HELP = [
  "tokenWatcher commands:",
  "/pos <position|pool> [wallet|pool]  — analyse your LP + scan the pool's top wallets",
  "     e.g. /pos <positionAddress> <poolAddress>",
  "     e.g. /pos <poolAddress> <walletAddress>",
  "     e.g. /pos https://app.meteora.ag/dlmm/<pool>",
  "/add <mint> <target> [above|below]  — track a mint (default: above)",
  "/list  — tracked mints with live price + status",
  "/remove <mint>  — stop tracking a mint",
  "/clear  — stop tracking everything",
  "/reload  — reload config/watchlist.json from disk",
  "/help  — this message",
].join("\n");

function parseDirection(raw: string | undefined): Direction | null {
  if (!raw) return "above";
  const value = raw.toLowerCase();
  if (value === "above" || value === "over" || value === ">") return "above";
  if (value === "below" || value === "under" || value === "<") return "below";
  return null;
}

function forgetFiredStates(state: FiredState, address: string): number {
  let removed = 0;
  for (const key of Object.keys(state)) {
    if (key.startsWith(`${address}:`)) {
      delete state[key];
      removed += 1;
    }
  }
  return removed;
}

export async function handleCommand(text: string, ctx: CommandContext): Promise<void> {
  const { config, store, state, saveState, reply, replyLong } = ctx;
  const trimmed = (text ?? "").trim();
  if (!trimmed.startsWith("/")) return;

  const [rawCommand, ...args] = trimmed.split(/\s+/);
  const command = rawCommand.split("@")[0].toLowerCase();

  switch (command) {
    case "/start":
    case "/help":
      await reply(HELP);
      return;

    case "/pos": {
      const input = args.join(" ").trim();
      if (!input) {
        await reply(
          "Usage: /pos <position|pool> [wallet|pool]\n" +
            "Examples:\n" +
            "  /pos <positionAddress> <poolAddress>\n" +
            "  /pos <poolAddress> <walletAddress>\n" +
            "  /pos https://app.meteora.ag/dlmm/<pool>",
        );
        return;
      }
      await reply("🔎 Analysing position + scanning pool wallets… (this can take ~20-40s)");
      try {
        const sections = await analyzePositionInput(input, {
          rpcUrl: config.solanaRpcUrl,
          topWallets: config.posTopWallets,
        });
        await replyLong(sections.join("\n\n"));
      } catch (err) {
        await reply(`Position analysis failed: ${(err as Error).message}`);
      }
      return;
    }

    case "/add": {
      if (args.length < 2) {
        await reply("Usage: /add <mint> <target> [above|below]\nExample: /add 7ga6rtE... 2.75 above");
        return;
      }
      const [mint, targetRaw, directionRaw] = args;
      const target = Number(targetRaw);
      if (!Number.isFinite(target) || target <= 0) {
        await reply(`Invalid target price "${targetRaw}".`);
        return;
      }
      const direction = parseDirection(directionRaw);
      if (!direction) {
        await reply(`Invalid direction "${directionRaw}". Use above or below.`);
        return;
      }

      let info;
      try {
        info = await getTokenInfo(config.gmgnApiKey, CHAIN, mint);
      } catch (err) {
        await reply(`Could not fetch mint ${mint}: ${(err as Error).message}`);
        return;
      }

      const item: WatchItem = {
        address: info.address,
        symbol: info.symbol,
        target: { price: target, direction },
        pings: config.pingCount,
      };

      const previouslyFired = forgetFiredStates(state, info.address);
      if (previouslyFired > 0) saveState(state);
      store.add(item);

      const hitNow = isHit(info.price, item);
      await reply(
        [
          `✅ Now tracking ${info.symbol}`,
          `${info.address}`,
          `Target: ${direction} $${formatPrice(target)}`,
          `Current: $${formatPrice(info.price)}`,
          hitNow ? "⚠️ Target already met — will fire 5 pings on next check." : "",
          `${store.count()} mint(s) tracked together.`,
        ]
          .filter(Boolean)
          .join("\n"),
      );
      return;
    }

    case "/list": {
      const items = store.list();
      if (items.length === 0) {
        await reply("No mints tracked yet. Use /add <mint> <target> [above|below].");
        return;
      }
      const lines = await Promise.all(
        items.map(async (item) => {
          const label = item.symbol ?? item.address;
          try {
            const info = await getTokenInfo(config.gmgnApiKey, CHAIN, item.address);
            const hit = isHit(info.price, item);
            return (
              `• ${info.symbol || label}\n` +
              `  ${item.address}\n` +
              `  now $${formatPrice(info.price)} → ${item.target.direction} $${formatPrice(item.target.price)} ` +
              `${hit ? "✅ HIT" : "⏳ waiting"}`
            );
          } catch (err) {
            return (
              `• ${label}\n  ${item.address}\n` +
              `  target ${item.target.direction} $${formatPrice(item.target.price)}\n` +
              `  ⚠️ price error: ${(err as Error).message}`
            );
          }
        }),
      );
      await reply(`Tracking ${items.length} mint(s):\n\n${lines.join("\n\n")}`);
      return;
    }

    case "/remove": {
      const mint = args[0];
      if (!mint) {
        await reply("Usage: /remove <mint>");
        return;
      }
      const removed = store.remove(mint);
      const cleared = forgetFiredStates(state, mint);
      if (cleared > 0) saveState(state);
      await reply(
        removed
          ? `🗑️ Removed ${mint}.\n${store.count()} mint(s) tracked.`
          : `Not tracking ${mint}.`,
      );
      return;
    }

    case "/clear": {
      const removed = store.clear();
      for (const key of Object.keys(state)) delete state[key];
      saveState(state);
      await reply(`🗑️ Removed all ${removed} mint(s).`);
      return;
    }

    case "/reload": {
      try {
        store.reload();
        await reply(`🔄 Reloaded from disk. ${store.count()} mint(s) tracked.`);
      } catch (err) {
        await reply(`Reload failed: ${(err as Error).message}`);
      }
      return;
    }

    default:
      await reply(`Unknown command ${command}.\n\n${HELP}`);
  }
}
