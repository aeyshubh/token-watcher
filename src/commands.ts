import { formatPrice, formatUsd } from "./format";
import { isBase58 } from "./solana";
import {
  formatPositionStatus,
  formatThresholdHit,
  formatThresholdSummary,
  thresholdBreached,
  type LpSnapshotEntry,
  type LpTarget,
  type LpTrackerHandle,
  type ThresholdKind,
} from "./lp";
import type { CloseExecutorHandle } from "./executor";

export interface CommandContext {
  reply: (text: string) => Promise<void>;
  replyLong: (text: string) => Promise<void>;
  lp?: LpTrackerHandle;
  close?: CloseExecutorHandle;
}

export interface BotCommand {
  command: string;
  description: string;
}

export const BOT_COMMANDS: BotCommand[] = [
  { command: "lp", description: "LP positions (#1, #2 …) + TP/SL: /lp [list|status|set|unset|reload]" },
  { command: "status", description: "Detailed LP status: /status [number] (omit number for all)" },
  { command: "set", description: "Set LP TP/SL: /set sl 1 20% (PnL) or /set tp 1 0.0001917 (price)" },
  { command: "close", description: "Auto-close on TP/SL: /close <#|position> [tp <pct|price>] [sl <pct|price>] · /close list · /close off <#>" },
  { command: "help", description: "Show all commands" },
  { command: "start", description: "Show all commands" },
];

const HELP = [
  "tokenWatcher commands:",
  "/lp  — list auto-detected LP positions with numbers (#1, #2 …)",
  "/status [number]  — detailed LP status (all positions if number omitted)",
  "/lp set <#|position> [tp <pct|price>] [sl <pct|price>]  — e.g. /lp set 1 tp 20 sl 10",
  "/set <tp|sl> <#|position> <pct|price>  — e.g. /set sl 1 20% · /set tp 1 0.0001917",
  "  prices use pool price (quote per token); use price:<n> to force price, <n>% to force PnL %",
  "/lp unset <#|position>  — remove an override",
  "/lp reload  — reload wallets + overrides from disk",
  "/close <#|position> [tp <pct|price>] [sl <pct|price>]  — e.g. /close 1 tp 10 sl 20",
  "/close list  — show armed auto-close orders",
  "/close off <#>  — disarm an auto-close order",
  "/help  — this message",
].join("\n");

export interface ParsedThreshold {
  pct?: number;
  price?: number;
}

/**
 * Parse a TP/SL value.
 * - `price:<n>` always means pool price (must be > 0).
 * - `<n>%` always means PnL percent.
 * - A positive value below 1 (e.g. 0.0001917) is treated as pool price.
 * - Everything else is treated as PnL percent.
 */
export function parseThresholdValue(raw: string | undefined): ParsedThreshold | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const forcePrice = /^price:/i.test(trimmed);
  const forcePct = trimmed.endsWith("%");
  const numeric = trimmed.replace(/^price:/i, "").replace(/%$/, "").trim();
  if (!numeric) return null;
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(numeric)) return null;

  const value = Number(numeric);
  if (!Number.isFinite(value) || value < 0) return null;

  if (forcePrice) return value > 0 ? { price: value } : null;
  if (forcePct) return { pct: value };
  if (value > 0 && value < 1) return { price: value };
  return { pct: value };
}

function isPositionRef(token: string): boolean {
  return /^#?\d+$/.test(token) || isBase58(token);
}

function parseLpSetArgs(
  args: string[],
  options: { requireTarget?: boolean } = {},
): { ref: string; target: LpTarget } | { error: string } {
  const requireTarget = options.requireTarget !== false;
  const clean = args.filter((token) => token && token !== "%").map((token) => token.trim());
  if (clean.length === 0) {
    return {
      error:
        "Usage: /lp set <#|position> [tp <pct|price>] [sl <pct|price>]\n" +
        "Examples: /lp set 1 tp 20 sl 10 · /lp set sl 1 20% · /lp set tp 1 0.0001917",
    };
  }

  const first = clean[0];
  const key = first.toLowerCase();
  let ref: string;
  let rest: string[];

  if (isPositionRef(first)) {
    ref = first;
    rest = clean.slice(1);
  } else if ((key === "tp" || key === "sl") && clean.length >= 3 && isPositionRef(clean[1])) {
    ref = clean[1];
    rest = [first, clean[2], ...clean.slice(3)];
  } else {
    return {
      error:
        "Could not find a position number or address.\n" +
        "Usage: /lp set <#|position> [tp <pct|price>] [sl <pct|price>]",
    };
  }

  const target: LpTarget = {};
  for (let i = 0; i < rest.length; i += 2) {
    const field = rest[i]?.toLowerCase();
    const raw = rest[i + 1];
    if (field !== "tp" && field !== "sl") {
      return { error: `Unknown field "${rest[i]}". Use tp <pct|price> and/or sl <pct|price>.` };
    }
    const parsed = parseThresholdValue(raw);
    if (!parsed) {
      return { error: `Invalid ${field} value "${raw ?? ""}".` };
    }
    if (field === "tp") {
      if (parsed.price !== undefined) target.tpPrice = parsed.price;
      else target.tpPct = parsed.pct;
    } else {
      if (parsed.price !== undefined) target.slPrice = parsed.price;
      else target.slPct = parsed.pct;
    }
  }

  if (
    requireTarget &&
    target.tpPct === undefined &&
    target.tpPrice === undefined &&
    target.slPct === undefined &&
    target.slPrice === undefined
  ) {
    return {
      error: "Nothing to set. Usage: /lp set <#|position> [tp <pct|price>] [sl <pct|price>]",
    };
  }

  return { ref, target };
}

function resolveLpPosition(ref: string, tracker: LpTrackerHandle): string | { error: string } {
  const cleaned = ref.replace(/^#/, "");
  if (/^\d+$/.test(cleaned)) {
    const number = Number(cleaned);
    const row = tracker.snapshot().find((entry) => entry.number === number);
    if (!row) {
      return { error: `No position #${number}. Send /lp to see current numbers.` };
    }
    return row.position;
  }
  if (isBase58(ref)) return ref;
  return { error: `"${ref}" is not a position number or address.` };
}

function refLabel(ref: string, position: string): string {
  return /^#?\d+$/.test(ref) ? `#${ref.replace(/^#/, "")}` : position;
}

function resolveCloseRef(
  ref: string,
  tracker: LpTrackerHandle,
  executor: CloseExecutorHandle,
): string | { error: string } {
  const resolved = resolveLpPosition(ref, tracker);
  if (typeof resolved === "string") return resolved;

  const cleaned = ref.replace(/^#/, "");
  if (/^\d+$/.test(cleaned)) {
    const number = Number(cleaned);
    const order = executor.list().find((entry) => entry.number === number);
    if (order) return order.position;
  }
  return resolved;
}

interface EffectiveThreshold {
  pct: number;
  price: number | null;
  changed: boolean;
}

function effectiveThreshold(
  target: LpTarget | undefined,
  row: LpSnapshotEntry | undefined,
  kind: ThresholdKind,
): EffectiveThreshold {
  const targetPrice = kind === "tp" ? target?.tpPrice : target?.slPrice;
  const targetPct = kind === "tp" ? target?.tpPct : target?.slPct;
  if (targetPrice !== undefined) return { pct: 0, price: targetPrice, changed: true };
  if (targetPct !== undefined) return { pct: targetPct, price: null, changed: true };

  const rowPrice = kind === "tp" ? row?.tpPrice ?? null : row?.slPrice ?? null;
  const rowPct = kind === "tp" ? row?.tpPct ?? 0 : row?.slPct ?? 0;
  return { pct: rowPct, price: rowPrice, changed: false };
}

async function applyLpSet(
  args: string[],
  tracker: LpTrackerHandle,
  reply: (text: string) => Promise<void>,
): Promise<void> {
  const parsed = parseLpSetArgs(args);
  if ("error" in parsed) {
    await reply(parsed.error);
    return;
  }

  const resolved = resolveLpPosition(parsed.ref, tracker);
  if (typeof resolved !== "string") {
    await reply(resolved.error);
    return;
  }

  const row = tracker.snapshot().find((entry) => entry.position === resolved);
  tracker.setTarget(resolved, parsed.target);
  const label = refLabel(parsed.ref, resolved);
  const tp = effectiveThreshold(parsed.target, row, "tp");
  const sl = effectiveThreshold(parsed.target, row, "sl");
  const lines = [`✅ Override saved for ${label}`];
  lines.push(
    `${tp.changed ? formatThresholdSummary("tp", tp.pct, tp.price) : "TP unchanged"} · ` +
      `${sl.changed ? formatThresholdSummary("sl", sl.pct, sl.price) : "SL unchanged"}`,
  );

  if (!row) {
    lines.push("Hit prices: n/a (position not in latest snapshot)");
  } else {
    if (tp.price !== null || sl.price !== null) {
      lines.push(`Current price: ${row.activePrice === null ? "n/a" : formatPrice(row.activePrice)}`);
    }
    if (thresholdBreached("tp", tp.pct, tp.price, row)) {
      lines.push("⚠️ TP target is already breached — it will trigger on the next tick.");
    }
    if (thresholdBreached("sl", sl.pct, sl.price, row)) {
      lines.push("⚠️ SL target is already breached — it will trigger on the next tick.");
    }
    const tpLine = formatThresholdHit(row, "tp", tp.pct, tp.price);
    if (tpLine) lines.push(tpLine);
    const slLine = formatThresholdHit(row, "sl", sl.pct, sl.price);
    if (slLine) lines.push(slLine);
  }

  await reply(lines.join("\n"));
}

async function applyLpStatus(
  args: string[],
  tracker: LpTrackerHandle,
  reply: (text: string) => Promise<void>,
  replyLong: (text: string) => Promise<void>,
): Promise<void> {
  const rows = tracker.snapshot();
  if (rows.length === 0) {
    await reply("No open LP positions detected yet. The tracker polls the Meteora API automatically.");
    return;
  }

  const ref = args[0];
  if (ref) {
    const resolved = resolveLpPosition(ref, tracker);
    if (typeof resolved !== "string") {
      await reply(resolved.error);
      return;
    }
    const row = rows.find((entry) => entry.position === resolved);
    if (!row) {
      await reply(`Position ${refLabel(ref, resolved)} is tracked but not in the latest snapshot. Send /lp.`);
      return;
    }
    await replyLong(formatPositionStatus(row));
    return;
  }

  const ordered = [...rows].sort((a, b) => a.number - b.number);
  const text = ordered.map(formatPositionStatus).join("\n\n──────────\n\n");
  await replyLong(text);
}

export async function handleCommand(text: string, ctx: CommandContext): Promise<void> {
  const { reply, replyLong } = ctx;
  const trimmed = (text ?? "").trim();
  if (!trimmed.startsWith("/")) return;

  const [rawCommand, ...args] = trimmed.split(/\s+/);
  const command = rawCommand.split("@")[0].toLowerCase();

  switch (command) {
    case "/start":
    case "/help":
      await reply(HELP);
      return;

    case "/lp": {
      const tracker = ctx.lp;
      if (!tracker) {
        await reply(
          "LP tracker is not running.\n" +
            "Add wallets to config/lp-wallets.json, keep lp.enabled=true in config/app.json, then restart.",
        );
        return;
      }

      const sub = (args[0] ?? "list").toLowerCase();

      if (sub === "list") {
        const rows = tracker.snapshot();
        if (rows.length === 0) {
          await reply("No open LP positions detected yet. The tracker polls the Meteora API automatically.");
          return;
        }
        const lines = rows.map((row) => {
          const status =
            row.isOutOfRange === null ? "—" : row.isOutOfRange ? "OUT of range" : "IN range";
          const pnl =
            row.pnlPct === null
              ? "n/a"
              : `${row.pnlPct >= 0 ? "+" : ""}${row.pnlPct.toFixed(2)}%`;
          const parts = [
            `#${row.number} · ${row.poolName} · ${row.walletLabel}`,
            `  PnL ${pnl} · Bal ${formatUsd(row.balances)} · ${status}`,
            `  ${formatThresholdSummary("tp", row.tpPct, row.tpPrice)} / ` +
              `${formatThresholdSummary("sl", row.slPct, row.slPrice)}`,
          ];
          const tpHit = formatThresholdHit(row, "tp", row.tpPct, row.tpPrice);
          if (tpHit) parts.push(`  ${tpHit}`);
          const slHit = formatThresholdHit(row, "sl", row.slPct, row.slPrice);
          if (slHit) parts.push(`  ${slHit}`);
          return parts.join("\n");
        });
        await replyLong(`LP positions (${rows.length}):\n\n${lines.join("\n\n")}`);
        return;
      }

      if (sub === "status") {
        await applyLpStatus(args.slice(1), tracker, reply, replyLong);
        return;
      }

      if (sub === "reload") {
        tracker.reload();
        await reply("🔄 LP tracker reloaded wallets + overrides from disk.");
        return;
      }

      if (sub === "set") {
        await applyLpSet(args.slice(1), tracker, reply);
        return;
      }

      if (sub === "unset" || sub === "clear") {
        const ref = args[1];
        if (!ref) {
          await reply("Usage: /lp unset <#|position>");
          return;
        }
        const resolved = resolveLpPosition(ref, tracker);
        if (typeof resolved !== "string") {
          await reply(resolved.error);
          return;
        }
        const removed = tracker.clearTarget(resolved);
        const label = refLabel(ref, resolved);
        await reply(
          removed
            ? `🗑️ Override removed for ${label}. Wallet/default thresholds apply.`
            : `No override stored for ${label}.`,
        );
        return;
      }

      await reply(
        "LP tracker commands:\n" +
          "/lp  — list detected positions with numbers (#1, #2 …)\n" +
          "/status [number]  — detailed status\n" +
          "/lp set <#|position> [tp <pct|price>] [sl <pct|price>]\n" +
          "/set <tp|sl> <#|position> <pct|price>\n" +
          "/lp unset <#|position>\n" +
          "/lp reload",
      );
      return;
    }

    case "/status": {
      const tracker = ctx.lp;
      if (!tracker) {
        await reply(
          "LP tracker is not running.\n" +
            "Add wallets to config/lp-wallets.json, keep lp.enabled=true in config/app.json, then restart.",
        );
        return;
      }
      await applyLpStatus(args, tracker, reply, replyLong);
      return;
    }

    case "/set": {
      const tracker = ctx.lp;
      if (!tracker) {
        await reply(
          "LP tracker is not running.\n" +
            "Add wallets to config/lp-wallets.json, keep lp.enabled=true in config/app.json, then restart.",
        );
        return;
      }
      await applyLpSet(args, tracker, reply);
      return;
    }

    case "/close": {
      const executor = ctx.close;
      if (!executor) {
        await reply(
          "Auto-close executor is not running.\n" +
            "Set LP_EXECUTOR_PRIVATE_KEY in .env, keep executor.enabled=true in config/app.json, then restart.",
        );
        return;
      }

      const tracker = ctx.lp;
      const sub = (args[0] ?? "list").toLowerCase();

      if (sub === "list" || sub === "status") {
        const all = executor.list();
        const active = all.filter((order) => order.status !== "done");
        const doneCount = all.length - active.length;
        if (active.length === 0) {
          await reply(
            doneCount > 0
              ? `No active auto-close orders (${doneCount} completed).`
              : "No auto-close orders armed. Use /close <#|position> [tp <pct|price>] [sl <pct|price>].",
          );
          return;
        }
        const lines = active.map((order) => {
          const ref = order.number ? `#${order.number}` : "order";
          const tp = formatThresholdSummary("tp", order.tpPct ?? 0, order.tpPrice ?? null);
          const sl = formatThresholdSummary("sl", order.slPct ?? 0, order.slPrice ?? null);
          const retry =
            order.nextAttemptAt && order.status === "armed"
              ? `\n  next retry: ${order.nextAttemptAt}`
              : "";
          const error = order.lastError ? `\n  last error: ${order.lastError}` : "";
          return (
            `${ref} · ${order.status.toUpperCase()}\n` +
            `  ${tp} / ${sl} · attempts ${order.attempts}${retry}${error}`
          );
        });
        const suffix = doneCount > 0 ? `\n\nCompleted: ${doneCount}` : "";
        await reply(`Auto-close orders (${active.length} active):\n\n${lines.join("\n\n")}${suffix}`);
        return;
      }

      if (sub === "off" || sub === "cancel" || sub === "remove") {
        const ref = args[1];
        if (!ref) {
          await reply("Usage: /close off <#|position>");
          return;
        }
        if (!tracker) {
          await reply("LP tracker is not running; cannot resolve position numbers.");
          return;
        }
        const resolved = resolveCloseRef(ref, tracker, executor);
        if (typeof resolved !== "string") {
          await reply(resolved.error);
          return;
        }
        const removed = executor.disarm(resolved);
        await reply(
          removed
            ? `🗑️ Auto-close disarmed for ${refLabel(ref, resolved)}.`
            : `No auto-close order removed for ${refLabel(ref, resolved)} (not armed or currently executing).`,
        );
        return;
      }

      if (!tracker) {
        await reply("LP tracker is not running; cannot resolve position numbers.");
        return;
      }

      const parsed = parseLpSetArgs(args, { requireTarget: false });
      if ("error" in parsed) {
        await reply(
          "Usage: /close <#|position> [tp <pct|price>] [sl <pct|price>]\n" +
            "Examples: /close 1 tp 10 sl 20 · /close 1 tp 0.0001917 · /close 2 · /close list · /close off 1",
        );
        return;
      }

      const resolved = resolveLpPosition(parsed.ref, tracker);
      if (typeof resolved !== "string") {
        await reply(resolved.error);
        return;
      }

      const row = tracker.snapshot().find((entry) => entry.position === resolved);
      if (!row) {
        await reply(
          `Position ${refLabel(parsed.ref, resolved)} is not in the latest snapshot. Send /lp and retry.`,
        );
        return;
      }

      if (row.wallet !== executor.owner) {
        await reply(
          `Cannot auto-close ${refLabel(parsed.ref, resolved)}: the executor key does not own this position's wallet.`,
        );
        return;
      }

      const tp = effectiveThreshold(parsed.target, row, "tp");
      const sl = effectiveThreshold(parsed.target, row, "sl");
      if (tp.pct <= 0 && tp.price === null && sl.pct <= 0 && sl.price === null) {
        await reply("Both TP and SL are disabled; nothing would trigger the close.");
        return;
      }

      try {
        executor.arm({
          position: row.position,
          pool: row.pool,
          wallet: row.wallet,
          number: row.number,
          tpPct: parsed.target.tpPct,
          slPct: parsed.target.slPct,
          tpPrice: parsed.target.tpPrice,
          slPrice: parsed.target.slPrice,
        });
      } catch (err) {
        await reply(`Could not arm auto-close: ${(err as Error).message}`);
        return;
      }

      const breached: string[] = [];
      if (thresholdBreached("tp", tp.pct, tp.price, row)) breached.push("TP");
      if (thresholdBreached("sl", sl.pct, sl.price, row)) breached.push("SL");

      await reply(
        [
          `✅ Auto-close armed for ${refLabel(parsed.ref, resolved)}`,
          `${row.poolName} · ${row.walletLabel}`,
          `Trigger: ${formatThresholdSummary("tp", tp.pct, tp.price)} / ` +
            `${formatThresholdSummary("sl", sl.pct, sl.price)}`,
          "On trigger: remove 100% liquidity, claim fees/rewards, swap all to SOL.",
          breached.length > 0
            ? `⚠️ ${breached.join(" + ")} already breached at current price/PnL — closing on the next tick.`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
      return;
    }

    default:
      await reply(`Unknown command ${command}.\n\n${HELP}`);
  }
}
