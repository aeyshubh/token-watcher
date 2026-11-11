import { formatUsd } from "./format";
import { isBase58 } from "./solana";
import { formatPositionStatus, type LpTarget, type LpTrackerHandle } from "./lp";
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
  { command: "set", description: "Set LP TP/SL by number: /set sl 1 20% or /set 1 tp 20 sl 10" },
  { command: "close", description: "Auto-close on TP/SL: /close <#> [tp <pct>] [sl <pct>] · /close list · /close off <#>" },
  { command: "help", description: "Show all commands" },
  { command: "start", description: "Show all commands" },
];

const HELP = [
  "tokenWatcher commands:",
  "/lp  — list auto-detected LP positions with numbers (#1, #2 …)",
  "/status [number]  — detailed LP status (all positions if number omitted)",
  "/lp set <#|position> [tp <pct>] [sl <pct>]  — e.g. /lp set 1 tp 20 sl 10",
  "/set <tp|sl> <#|position> <pct>  — e.g. /set sl 1 20%",
  "/lp unset <#|position>  — remove an override",
  "/lp reload  — reload wallets + overrides from disk",
  "/close <#> [tp <pct>] [sl <pct>]  — arm auto-close, e.g. /close 1 tp 10 sl 20",
  "/close list  — show armed auto-close orders",
  "/close off <#>  — disarm an auto-close order",
  "/help  — this message",
].join("\n");

function parsePercent(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number(raw.replace(/%$/, ""));
  return Number.isFinite(value) && value >= 0 ? value : null;
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
        "Usage: /lp set <#|position> [tp <pct>] [sl <pct>]\n" +
        "Examples: /lp set 1 tp 20 sl 10 · /lp set sl 1 20%",
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
        "Usage: /lp set <#|position> [tp <pct>] [sl <pct>]",
    };
  }

  const target: LpTarget = {};
  for (let i = 0; i < rest.length; i += 2) {
    const field = rest[i]?.toLowerCase();
    const raw = rest[i + 1];
    if (field !== "tp" && field !== "sl") {
      return { error: `Unknown field "${rest[i]}". Use tp <pct> and/or sl <pct>.` };
    }
    const value = parsePercent(raw);
    if (value === null) {
      return { error: `Invalid ${field} value "${raw ?? ""}".` };
    }
    if (field === "tp") target.tpPct = value;
    else target.slPct = value;
  }

  if (requireTarget && target.tpPct === undefined && target.slPct === undefined) {
    return {
      error: "Nothing to set. Usage: /lp set <#|position> [tp <pct>] [sl <pct>]",
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

  tracker.setTarget(resolved, parsed.target);
  const label = refLabel(parsed.ref, resolved);
  const lines = [`✅ Override saved for ${label}`];
  lines.push(
    `${parsed.target.tpPct !== undefined ? `TP +${parsed.target.tpPct}%` : "TP unchanged"} · ` +
      `${parsed.target.slPct !== undefined ? `SL -${parsed.target.slPct}%` : "SL unchanged"}`,
  );
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
          return (
            `#${row.number} · ${row.poolName} · ${row.walletLabel}\n` +
            `  PnL ${pnl} · Bal ${formatUsd(row.balances)} · ${status}\n` +
            `  TP +${row.tpPct}% / SL -${row.slPct}%`
          );
        });
        await reply(`LP positions (${rows.length}):\n\n${lines.join("\n\n")}`);
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
          "/lp set <#|position> [tp <pct>] [sl <pct>]\n" +
          "/set <tp|sl> <#|position> <pct>\n" +
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
              : "No auto-close orders armed. Use /close <#> [tp <pct>] [sl <pct>].",
          );
          return;
        }
        const lines = active.map((order) => {
          const ref = order.number ? `#${order.number}` : "order";
          const tp = order.tpPct !== undefined ? `+${order.tpPct}%` : "—";
          const sl = order.slPct !== undefined ? `-${order.slPct}%` : "—";
          const retry =
            order.nextAttemptAt && order.status === "armed"
              ? `\n  next retry: ${order.nextAttemptAt}`
              : "";
          const error = order.lastError ? `\n  last error: ${order.lastError}` : "";
          return (
            `${ref} · ${order.status.toUpperCase()}\n` +
            `  TP ${tp} / SL ${sl} · attempts ${order.attempts}${retry}${error}`
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
          "Usage: /close <#|position> [tp <pct>] [sl <pct>]\n" +
            "Examples: /close 1 tp 10 sl 20 · /close 2 · /close list · /close off 1",
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

      const tpPct = parsed.target.tpPct ?? row.tpPct;
      const slPct = parsed.target.slPct ?? row.slPct;
      if (tpPct <= 0 && slPct <= 0) {
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
        });
      } catch (err) {
        await reply(`Could not arm auto-close: ${(err as Error).message}`);
        return;
      }

      await reply(
        [
          `✅ Auto-close armed for ${refLabel(parsed.ref, resolved)}`,
          `${row.poolName} · ${row.walletLabel}`,
          `Trigger: TP +${tpPct}% / SL -${slPct}%`,
          "On trigger: remove 100% liquidity, claim fees/rewards, swap all to SOL.",
          row.pnlPct !== null &&
          ((tpPct > 0 && row.pnlPct >= tpPct) || (slPct > 0 && row.pnlPct <= -slPct))
            ? `⚠️ Current PnL ${row.pnlPct.toFixed(2)}% already breaches this trigger — closing on the next tick.`
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
