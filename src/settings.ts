import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface LpSettings {
  enabled: boolean;
  intervalMs: number;
  maxRps: number;
  defaultTpPct: number;
  defaultSlPct: number;
  alertCooldownMs: number;
  oorCooldownMs: number;
  minPositionUsd: number;
  nearRangeWidthPct: number;
}

export interface ExecutorSettings {
  enabled: boolean;
  rpcUrl: string;
  slippageBps: number;
  priorityFeeCapLamports: number;
  retryBaseMs: number;
  retryMaxMs: number;
  maxAttempts: number;
  computeUnitLimit: number;
}

export interface AppSettings {
  telegramChatId: string;
  solanaRpcUrl: string;
  lp: LpSettings;
  executor: ExecutorSettings;
}

const SETTINGS_PATH = resolve(process.cwd(), "config/app.json");

const DEFAULTS: AppSettings = {
  telegramChatId: "",
  solanaRpcUrl: "https://api.mainnet-beta.solana.com",
  lp: {
    enabled: true,
    intervalMs: 15000,
    maxRps: 20,
    defaultTpPct: 20,
    defaultSlPct: 10,
    alertCooldownMs: 900000,
    oorCooldownMs: 3600000,
    minPositionUsd: 1,
    nearRangeWidthPct: 10,
  },
  executor: {
    enabled: true,
    rpcUrl: "",
    slippageBps: 300,
    priorityFeeCapLamports: 5_000_000,
    retryBaseMs: 5_000,
    retryMaxMs: 300_000,
    maxAttempts: 0,
    computeUnitLimit: 1_400_000,
  },
};

function readRoot(): Record<string, unknown> {
  if (!existsSync(SETTINGS_PATH)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  } catch (err) {
    throw new Error(`Failed to read ${SETTINGS_PATH}: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${SETTINGS_PATH} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function section(root: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = root[key];
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${SETTINGS_PATH}: "${key}" must be an object`);
  }
  return value as Record<string, unknown>;
}

function str(value: unknown, name: string, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") throw new Error(`${SETTINGS_PATH}: "${name}" must be a string`);
  return value.trim() || fallback;
}

function bool(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new Error(`${SETTINGS_PATH}: "${name}" must be true or false`);
  return value;
}

function num(
  value: unknown,
  name: string,
  fallback: number,
  opts: { min?: number; max?: number; allowZero?: boolean; integer?: boolean } = {},
): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${SETTINGS_PATH}: "${name}" must be a number`);
  if (opts.integer && !Number.isInteger(n)) {
    throw new Error(`${SETTINGS_PATH}: "${name}" must be an integer`);
  }
  if (!opts.allowZero && n === 0) {
    throw new Error(`${SETTINGS_PATH}: "${name}" must be non-zero`);
  }
  if (opts.min !== undefined && n < opts.min) {
    throw new Error(`${SETTINGS_PATH}: "${name}" must be >= ${opts.min}`);
  }
  if (opts.max !== undefined && n > opts.max) {
    throw new Error(`${SETTINGS_PATH}: "${name}" must be <= ${opts.max}`);
  }
  return n;
}

export function loadSettings(): AppSettings {
  const root = readRoot();
  const lp = section(root, "lp");
  const executor = section(root, "executor");

  return {
    telegramChatId: str(root.telegramChatId, "telegramChatId", ""),
    solanaRpcUrl: str(root.solanaRpcUrl, "solanaRpcUrl", DEFAULTS.solanaRpcUrl),
    lp: {
      enabled: bool(lp.enabled, "lp.enabled", DEFAULTS.lp.enabled),
      intervalMs: num(lp.intervalMs, "lp.intervalMs", DEFAULTS.lp.intervalMs, {
        min: 1,
        integer: true,
      }),
      maxRps: num(lp.maxRps, "lp.maxRps", DEFAULTS.lp.maxRps, {
        min: 1,
        max: 30,
        integer: true,
      }),
      defaultTpPct: num(lp.defaultTpPct, "lp.defaultTpPct", DEFAULTS.lp.defaultTpPct, {
        min: 0,
        allowZero: true,
      }),
      defaultSlPct: num(lp.defaultSlPct, "lp.defaultSlPct", DEFAULTS.lp.defaultSlPct, {
        min: 0,
        allowZero: true,
      }),
      alertCooldownMs: num(lp.alertCooldownMs, "lp.alertCooldownMs", DEFAULTS.lp.alertCooldownMs, {
        min: 0,
        allowZero: true,
        integer: true,
      }),
      oorCooldownMs: num(lp.oorCooldownMs, "lp.oorCooldownMs", DEFAULTS.lp.oorCooldownMs, {
        min: 0,
        allowZero: true,
        integer: true,
      }),
      minPositionUsd: num(lp.minPositionUsd, "lp.minPositionUsd", DEFAULTS.lp.minPositionUsd, {
        min: 0,
        allowZero: true,
      }),
      nearRangeWidthPct: num(
        lp.nearRangeWidthPct,
        "lp.nearRangeWidthPct",
        DEFAULTS.lp.nearRangeWidthPct,
        { min: 0, max: 100, allowZero: true },
      ),
    },
    executor: {
      enabled: bool(executor.enabled, "executor.enabled", DEFAULTS.executor.enabled),
      rpcUrl: str(executor.rpcUrl, "executor.rpcUrl", DEFAULTS.executor.rpcUrl),
      slippageBps: num(executor.slippageBps, "executor.slippageBps", DEFAULTS.executor.slippageBps, {
        min: 1,
        max: 10000,
        integer: true,
      }),
      priorityFeeCapLamports: num(
        executor.priorityFeeCapLamports,
        "executor.priorityFeeCapLamports",
        DEFAULTS.executor.priorityFeeCapLamports,
        { min: 0, allowZero: true, integer: true },
      ),
      retryBaseMs: num(executor.retryBaseMs, "executor.retryBaseMs", DEFAULTS.executor.retryBaseMs, {
        min: 1000,
        integer: true,
      }),
      retryMaxMs: num(executor.retryMaxMs, "executor.retryMaxMs", DEFAULTS.executor.retryMaxMs, {
        min: 1000,
        integer: true,
      }),
      maxAttempts: num(executor.maxAttempts, "executor.maxAttempts", DEFAULTS.executor.maxAttempts, {
        min: 0,
        allowZero: true,
        integer: true,
      }),
      computeUnitLimit: num(
        executor.computeUnitLimit,
        "executor.computeUnitLimit",
        DEFAULTS.executor.computeUnitLimit,
        { min: 200000, max: 1400000, integer: true },
      ),
    },
  };
}

let cached: AppSettings | null = null;

export function getSettings(): AppSettings {
  if (!cached) cached = loadSettings();
  return cached;
}

export function requireTelegramChatId(): string {
  const chatId = getSettings().telegramChatId.trim();
  if (!chatId) {
    throw new Error(`Missing "telegramChatId" in ${SETTINGS_PATH}`);
  }
  return chatId;
}
