import { Connection } from "@solana/web3.js";
import type { CloseConfig } from "./close-config";
import { executeClose, type CloseResult } from "./close";
import {
  loadCloseState,
  saveCloseState,
  type CloseOrder,
  type CloseState,
} from "./close-state";
import {
  formatThresholdSummary,
  thresholdBreached,
  type LpSnapshotEntry,
  type ResolvedThreshold,
  type ThresholdKind,
} from "./lp";

const MISSING_TICKS_BEFORE_DONE = 4;

export interface CloseArmParams {
  position: string;
  pool: string;
  wallet: string;
  number?: number;
  tpPct?: number;
  slPct?: number;
  tpPrice?: number;
  slPrice?: number;
}

export interface CloseExecutorDeps {
  send: (text: string) => Promise<void>;
  log: (message: string) => void;
  state?: CloseState;
  saveState?: (state: CloseState) => void;
  execute?: typeof executeClose;
}

export interface CloseExecutorHandle {
  owner: string;
  stop: () => void;
  onTick: (snapshot: LpSnapshotEntry[]) => void;
  arm: (params: CloseArmParams) => CloseOrder;
  disarm: (position: string) => boolean;
  list: () => CloseOrder[];
  reload: () => void;
}

function formatPct(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatSol(lamports: string): string {
  const value = Number(lamports) / 1_000_000_000;
  if (!Number.isFinite(value)) return `${lamports} lamports`;
  return `${value.toFixed(value < 0.001 ? 9 : 4)} SOL`;
}

function rpcLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "custom";
  }
}

function label(order: CloseOrder): string {
  return order.number ? `#${order.number}` : "order";
}

function assertThreshold(kind: ThresholdKind, pct: number | undefined, price: number | undefined): void {
  if (pct !== undefined && (!Number.isFinite(pct) || pct < 0)) {
    throw new Error(`${kind}Pct must be a non-negative number`);
  }
  if (price !== undefined && (!Number.isFinite(price) || price <= 0)) {
    throw new Error(`${kind}Price must be a positive number`);
  }
  if (pct !== undefined && price !== undefined) {
    throw new Error(`${kind} cannot use both a percentage and a price`);
  }
}

function resolveOrderThreshold(
  orderPrice: number | undefined,
  orderPct: number | undefined,
  rowPrice: number | null,
  rowPct: number,
): ResolvedThreshold {
  if (orderPrice !== undefined) return { pct: 0, price: orderPrice };
  if (orderPct !== undefined) return { pct: orderPct, price: null };
  if (rowPrice !== null) return { pct: 0, price: rowPrice };
  return { pct: rowPct, price: null };
}

function backoffMs(config: CloseConfig, attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  const delay = config.retryBaseMs * 2 ** Math.min(exponent, 30);
  return Math.min(config.retryMaxMs, Math.max(config.retryBaseMs, delay));
}

function successMessage(
  order: CloseOrder,
  row: LpSnapshotEntry,
  reasonText: string,
  result: CloseResult,
): string {
  const lines = [
    `✅ Auto-close complete for ${label(order)} (${reasonText})`,
    `${row.poolName} · PnL ${formatPct(row.pnlPct ?? 0)}`,
  ];

  if (result.swaps.length > 0) {
    lines.push(`Swaps: ${result.swaps.length}`);
    for (const swap of result.swaps) {
      lines.push(`• ${swap.mint.slice(0, 4)}…${swap.mint.slice(-4)} → ${formatSol(swap.outAmount)}`);
    }
  } else if (result.skipped.length === 0) {
    lines.push("No token balances needed swapping.");
  }

  if (result.skipped.length > 0) {
    lines.push(
      `Left unsold: ${result.skipped
        .map((row) => `${row.mint.slice(0, 4)}…${row.mint.slice(-4)}=${row.amount} (${row.reason})`)
        .join(", ")}`,
    );
  }

  if (result.signatures.length > 0) {
    lines.push(`Txs: ${result.signatures.length}`);
  }
  return lines.join("\n");
}

export function startCloseExecutor(
  config: CloseConfig,
  deps: CloseExecutorDeps,
): CloseExecutorHandle {
  const state = deps.state ?? loadCloseState();
  const saveState = deps.saveState ?? saveCloseState;
  const execute = deps.execute ?? executeClose;
  const log = deps.log;
  const connection = new Connection(config.rpcUrl, "confirmed");

  let running = true;
  let processing = false;
  let pendingSnapshot: LpSnapshotEntry[] | null = null;

  const notify = async (text: string): Promise<void> => {
    try {
      await deps.send(text);
    } catch (err) {
      log(`close notify failed: ${(err as Error).message}`);
    }
  };

  const runOrder = async (
    order: CloseOrder,
    row: LpSnapshotEntry,
    reason: ThresholdKind,
    threshold: ResolvedThreshold,
  ): Promise<void> => {
    order.status = "executing";
    order.attempts += 1;
    order.lastAttemptAt = new Date().toISOString();
    order.nextAttemptAt = undefined;
    saveState(state);

    const reasonText = formatThresholdSummary(reason, threshold.pct, threshold.price);
    log(
      `Executing close for ${label(order)} (${reasonText}, PnL ${(row.pnlPct ?? 0).toFixed(2)}%)`,
    );

    await notify(
      `⚙️ Auto-close started for ${label(order)} (${reasonText})\n` +
        `${row.poolName} · PnL ${formatPct(row.pnlPct ?? 0)}`,
    );

    try {
      const result = await execute({
        connection,
        keypair: config.keypair,
        pool: order.pool,
        position: order.position,
        slippageBps: config.slippageBps,
        priorityFeeCapLamports: config.priorityFeeCapLamports,
        computeUnitLimit: config.computeUnitLimit,
        log,
      });

      order.status = "done";
      order.closedAt = new Date().toISOString();
      order.signatures = result.signatures;
      order.lastError = undefined;
      order.nextAttemptAt = undefined;
      saveState(state);

      log(`Close complete for ${label(order)} · ${result.signatures.length} tx(s)`);
      await notify(successMessage(order, row, reasonText, result));
    } catch (err) {
      const message = (err as Error).message;
      order.lastError = message;
      const exhausted = config.maxAttempts > 0 && order.attempts >= config.maxAttempts;
      order.status = exhausted ? "failed" : "armed";

      const delay = backoffMs(config, order.attempts);
      order.nextAttemptAt = new Date(Date.now() + delay).toISOString();
      saveState(state);

      log(
        `Close failed for ${label(order)} (attempt ${order.attempts}): ${message}; ` +
          (exhausted ? "giving up" : `retry in ${Math.round(delay / 1000)}s`),
      );

      if (exhausted || order.attempts === 1 || order.attempts % 10 === 0) {
        await notify(
          `⚠️ Auto-close failed for ${label(order)} (attempt ${order.attempts})\n` +
            `${message}\n` +
            (exhausted
              ? "Giving up (executor.maxAttempts reached)."
              : `Retrying in ${Math.round(delay / 1000)}s.`),
        );
      }
    }
  };

  const processSnapshot = async (snapshot: LpSnapshotEntry[]): Promise<void> => {
    const byPosition = new Map(snapshot.map((row) => [row.position, row]));
    const now = Date.now();
    let changed = false;

    for (const order of Object.values(state)) {
      if (order.status === "done" || order.status === "failed") continue;
      if (order.status === "executing") order.status = "armed";

      if (order.wallet !== config.owner) {
        order.status = "failed";
        order.lastError = `position wallet ${order.wallet} does not match executor ${config.owner}`;
        changed = true;
        log(`Close order ${label(order)} disabled: ${order.lastError}`);
        continue;
      }

      if (order.nextAttemptAt) {
        const at = new Date(order.nextAttemptAt).getTime();
        if (Number.isFinite(at) && at > now) continue;
      }

      const row = byPosition.get(order.position);
      if (!row) {
        order.missingTicks = (order.missingTicks ?? 0) + 1;
        changed = true;
        if (order.missingTicks >= MISSING_TICKS_BEFORE_DONE) {
          order.status = "done";
          order.closedAt = new Date().toISOString();
          order.nextAttemptAt = undefined;
          log(`Close order ${label(order)} marked done: position no longer open`);
          await notify(
            `ℹ️ Close order ${label(order)} marked done — position is no longer open.`,
          );
        }
        continue;
      }

      if (order.missingTicks) {
        order.missingTicks = 0;
        changed = true;
      }

      const tp = resolveOrderThreshold(order.tpPrice, order.tpPct, row.tpPrice, row.tpPct);
      const sl = resolveOrderThreshold(order.slPrice, order.slPct, row.slPrice, row.slPct);
      const tpHit = thresholdBreached("tp", tp.pct, tp.price, row);
      const slHit = thresholdBreached("sl", sl.pct, sl.price, row);
      if (!tpHit && !slHit) continue;

      await runOrder(order, row, tpHit ? "tp" : "sl", tpHit ? tp : sl);
      changed = true;
    }

    if (changed) saveState(state);
  };

  const pump = async (): Promise<void> => {
    if (processing) return;
    processing = true;
    try {
      while (running && pendingSnapshot) {
        const snapshot = pendingSnapshot;
        pendingSnapshot = null;
        await processSnapshot(snapshot);
      }
    } catch (err) {
      log(`executor tick error: ${(err as Error).message}`);
    } finally {
      processing = false;
    }
  };

  log(
    `Close executor started · owner=${config.owner} · rpc=${rpcLabel(config.rpcUrl)} · ` +
      `slippage=${config.slippageBps}bps · feeCap=${config.priorityFeeCapLamports} lamports · ` +
      `armed=${Object.values(state).filter((order) => order.status !== "done").length}`,
  );

  return {
    owner: config.owner,
    stop: () => {
      running = false;
    },
    onTick: (snapshot) => {
      if (!running) return;
      pendingSnapshot = snapshot;
      void pump();
    },
    arm: (params) => {
      if (params.wallet !== config.owner) {
        throw new Error(
          `position wallet ${params.wallet} does not match executor ${config.owner}`,
        );
      }
      assertThreshold("tp", params.tpPct, params.tpPrice);
      assertThreshold("sl", params.slPct, params.slPrice);
      const existing = state[params.position];
      let tpPct = params.tpPct ?? existing?.tpPct;
      let slPct = params.slPct ?? existing?.slPct;
      let tpPrice = params.tpPrice ?? existing?.tpPrice;
      let slPrice = params.slPrice ?? existing?.slPrice;
      if (params.tpPrice !== undefined) tpPct = undefined;
      if (params.tpPct !== undefined) tpPrice = undefined;
      if (params.slPrice !== undefined) slPct = undefined;
      if (params.slPct !== undefined) slPrice = undefined;

      const order: CloseOrder = {
        position: params.position,
        pool: params.pool,
        wallet: params.wallet,
        number: params.number,
        tpPct,
        slPct,
        tpPrice,
        slPrice,
        armedAt: new Date().toISOString(),
        status: "armed",
        attempts: 0,
      };
      state[params.position] = order;
      saveState(state);
      log(
        `Armed close for ${label(order)} · ` +
          `${formatThresholdSummary("tp", order.tpPct ?? 0, order.tpPrice ?? null)} / ` +
          `${formatThresholdSummary("sl", order.slPct ?? 0, order.slPrice ?? null)}`,
      );
      return { ...order };
    },
    disarm: (position) => {
      const order = state[position];
      if (!order) return false;
      if (order.status === "executing") return false;
      delete state[position];
      saveState(state);
      return true;
    },
    list: () =>
      Object.values(state)
        .map((order) => ({ ...order }))
        .sort((a, b) => (a.number ?? 0) - (b.number ?? 0)),
    reload: () => {
      const fresh = loadCloseState();
      for (const key of Object.keys(state)) delete state[key];
      Object.assign(state, fresh);
    },
  };
}
