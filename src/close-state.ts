import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export type CloseStatus = "armed" | "executing" | "done" | "failed";

export interface CloseOrder {
  position: string;
  pool: string;
  wallet: string;
  number?: number;
  tpPct?: number;
  slPct?: number;
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

export function loadCloseState(): CloseState {
  if (!existsSync(STATE_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const state = parsed as CloseState;
    for (const order of Object.values(state)) {
      // A crash during execution leaves "executing"; resume by re-arming.
      if (order.status === "executing") order.status = "armed";
    }
    return state;
  } catch {
    return {};
  }
}

export function saveCloseState(state: CloseState): void {
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
