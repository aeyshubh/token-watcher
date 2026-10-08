import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

export interface ScoutFiredRecord {
  firedAt: string;
}

export type ScoutState = Record<string, ScoutFiredRecord>;

const SCOUT_STATE_PATH = resolve(process.cwd(), "scout-state.json");

export function loadScoutState(): ScoutState {
  if (!existsSync(SCOUT_STATE_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(SCOUT_STATE_PATH, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as ScoutState) : {};
  } catch {
    return {};
  }
}

export function saveScoutState(state: ScoutState): void {
  writeFileSync(SCOUT_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function resetScoutState(): void {
  if (existsSync(SCOUT_STATE_PATH)) unlinkSync(SCOUT_STATE_PATH);
}

export function scoutStatePath(): string {
  return SCOUT_STATE_PATH;
}
