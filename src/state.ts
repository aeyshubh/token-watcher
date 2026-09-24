import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import type { FiredState } from "./types";

const STATE_PATH = resolve(process.cwd(), "state.json");

export function loadState(): FiredState {
  if (!existsSync(STATE_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as FiredState) : {};
  } catch {
    return {};
  }
}

export function saveState(state: FiredState): void {
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function resetState(): void {
  if (existsSync(STATE_PATH)) unlinkSync(STATE_PATH);
}

export function statePath(): string {
  return STATE_PATH;
}
