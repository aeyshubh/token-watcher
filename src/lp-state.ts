import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export interface LpAlertTimes {
  tp?: string;
  sl?: string;
  oor?: string;
  near?: string;
}

export interface LpPositionState {
  number?: number;
  pool: string;
  wallet: string;
  firstSeen: string;
  lastSeen: string;
  lastPnlPct?: number | null;
  lastPnlUsd?: number | null;
  balances?: number | null;
  deposit?: number | null;
  isOutOfRange?: boolean | null;
  nearSide?: "upper" | "lower" | null;
  alerts?: LpAlertTimes;
}

export type LpState = Record<string, LpPositionState>;

const STATE_PATH = resolve(process.cwd(), "lp-state.json");

export function loadLpState(): LpState {
  if (!existsSync(STATE_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as LpState)
      : {};
  } catch {
    return {};
  }
}

export function saveLpState(state: LpState): void {
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function resetLpState(): void {
  if (existsSync(STATE_PATH)) unlinkSync(STATE_PATH);
}

export function lpStatePath(): string {
  return STATE_PATH;
}
