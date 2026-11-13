import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export type CloseStatus = "armed" | "executing" | "done" | "failed";

export interface CloseOrder {
  position: string;
  pool: string;
  wallet: string;
  number?: number;
  tpPct?: number;
  slPct?: number;
  tpPrice?: number;
  slPrice?: number;
  armedAt: string;
  status: CloseStatus;
  attempts: number;
  lastAttemptAt?: string;
  nextAttemptAt?: string;
  lastError?: string;
  lastNotifiedError?: string;
  missingTicks?: number;
  signatures?: string[];
  closedAt?: string;
}

export type CloseState = Record<string, CloseOrder>;

const STATE_PATH = resolve(process.cwd(), "close-state.json");

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeInt(value: unknown): number | undefined {
  const n = finite(value);
  return n !== undefined && Number.isInteger(n) && n >= 0 ? n : undefined;
}

function sanitizeOrder(raw: unknown): CloseOrder | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;

  const position = text(item.position);
  const pool = text(item.pool);
  const wallet = text(item.wallet);
  if (!position || !pool || !wallet) return null;

  const problems: string[] = [];

  const status =
    item.status === "armed" ||
    item.status === "executing" ||
    item.status === "done" ||
    item.status === "failed"
      ? item.status
      : "failed";
  if (status !== item.status) problems.push("invalid status");

  let tpPct = finite(item.tpPct);
  let slPct = finite(item.slPct);
  let tpPrice = finite(item.tpPrice);
  let slPrice = finite(item.slPrice);

  if (item.tpPct !== undefined && (tpPct === undefined || tpPct < 0)) {
    problems.push("tpPct");
    tpPct = undefined;
  }
  if (item.slPct !== undefined && (slPct === undefined || slPct < 0)) {
    problems.push("slPct");
    slPct = undefined;
  }
  if (item.tpPrice !== undefined && (tpPrice === undefined || tpPrice <= 0)) {
    problems.push("tpPrice");
    tpPrice = undefined;
  }
  if (item.slPrice !== undefined && (slPrice === undefined || slPrice <= 0)) {
    problems.push("slPrice");
    slPrice = undefined;
  }
  if (tpPct !== undefined && tpPrice !== undefined) {
    problems.push("tpPct+tpPrice");
    tpPrice = undefined;
  }
  if (slPct !== undefined && slPrice !== undefined) {
    problems.push("slPct+slPrice");
    slPrice = undefined;
  }

  const number = nonNegativeInt(item.number);
  const attempts = nonNegativeInt(item.attempts) ?? 0;
  const missingTicks = nonNegativeInt(item.missingTicks);

  return {
    position,
    pool,
    wallet,
    number: number !== undefined && number > 0 ? number : undefined,
    tpPct,
    slPct,
    tpPrice,
    slPrice,
    armedAt: text(item.armedAt) ?? new Date().toISOString(),
    status: problems.length > 0 ? "failed" : status === "executing" ? "armed" : status,
    attempts,
    lastAttemptAt: text(item.lastAttemptAt),
    nextAttemptAt: text(item.nextAttemptAt),
    lastError:
      problems.length > 0
        ? `invalid persisted close state: ${problems.join(", ")}`
        : text(item.lastError),
    lastNotifiedError: text(item.lastNotifiedError),
    missingTicks,
    signatures: Array.isArray(item.signatures)
      ? item.signatures.filter((sig): sig is string => typeof sig === "string")
      : undefined,
    closedAt: text(item.closedAt),
  };
}

export function loadCloseState(): CloseState {
  if (!existsSync(STATE_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const state: CloseState = {};
    for (const raw of Object.values(parsed as Record<string, unknown>)) {
      const order = sanitizeOrder(raw);
      if (order) state[order.position] = order;
    }
    return state;
  } catch {
    return {};
  }
}

export function saveCloseState(state: CloseState): void {
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    chmodSync(STATE_PATH, 0o600);
  } catch {
    // Best effort; some filesystems do not support POSIX modes.
  }
}
