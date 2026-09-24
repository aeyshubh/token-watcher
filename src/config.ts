import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AppConfig, Direction, WatchItem } from "./types";

const WATCHLIST_PATH = resolve(process.cwd(), "config/watchlist.json");

function required(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number (got "${raw}")`);
  }
  return Math.floor(value);
}

export function parseWatchItem(raw: unknown, index: number): WatchItem {
  const item = raw as Record<string, unknown>;
  if (!item || typeof item !== "object") {
    throw new Error(`watchlist[${index}] must be an object`);
  }

  const address = item.address;
  if (typeof address !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
    throw new Error(`watchlist[${index}].address must be a valid base58 Solana address`);
  }

  const target = item.target as Record<string, unknown> | undefined;
  if (!target || typeof target !== "object") {
    throw new Error(`watchlist[${index}].target is required`);
  }
  const price = Number(target.price);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`watchlist[${index}].target.price must be a positive number`);
  }
  const direction = target.direction;
  if (direction !== "above" && direction !== "below") {
    throw new Error(`watchlist[${index}].target.direction must be "above" or "below"`);
  }

  const pingsRaw = Number(item.pings);
  const pings = Number.isFinite(pingsRaw) && pingsRaw > 0 ? Math.floor(pingsRaw) : 1;

  return {
    address,
    symbol: typeof item.symbol === "string" && item.symbol.trim() ? item.symbol.trim() : undefined,
    target: { price, direction: direction as Direction },
    pings,
  };
}

export function loadWatchlist(path: string = WATCHLIST_PATH): WatchItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Failed to read watchlist at ${path}: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("config/watchlist.json must be a non-empty array");
  }
  return parsed.map((item, index) => parseWatchItem(item, index));
}

export function loadConfig(): AppConfig {
  return {
    gmgnApiKey: required("GMGN_API_KEY"),
    telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
    telegramChatId: required("TELEGRAM_CHAT_ID"),
    pollIntervalMs: positiveInt("POLL_INTERVAL_MS", 15000),
    pingCount: positiveInt("PING_COUNT", 5),
    pingDelayMs: positiveInt("PING_DELAY_MS", 1000),
  };
}
