import "dotenv/config";
import { fetchPools, type MeteoraPool, type MeteoraToken } from "./hawkfi";
import { sendMessage } from "./telegram";
import {
  loadScoutState,
  saveScoutState,
  type ScoutState,
} from "./scout-state";

const QUOTE_MINTS = new Set([
  "So11111111111111111111111111111111111111112", // SOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

export interface ScoutConfig {
  botToken: string;
  chatId: string;
  intervalMs: number;
  minMarketCap: number;
  minFees1h: number;
  minTvl: number;
  minVolume30m: number;
  maxResults: number;
}

export interface PoolMatch {
  pool: MeteoraPool;
  base: MeteoraToken;
}

export function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function numberEnv(name: string, fallback: number, allowZero = false): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) {
    throw new Error(
      `${name} must be a ${allowZero ? "non-negative" : "positive"} number (got "${raw}")`,
    );
  }
  return value;
}

export function loadScoutConfig(
  overrides: Partial<Pick<ScoutConfig, "botToken" | "chatId">> = {},
): ScoutConfig {
  return {
    botToken: overrides.botToken ?? required("TELEGRAM_BOT_TOKEN"),
    chatId: overrides.chatId ?? required("TELEGRAM_CHAT_ID"),
    intervalMs: numberEnv("SCOUT_INTERVAL_MS", 15000),
    minMarketCap: numberEnv("SCOUT_MIN_MARKET_CAP", 1000000),
    minFees1h: numberEnv("SCOUT_MIN_FEES_1H", 2000),
    minTvl: numberEnv("SCOUT_MIN_TVL", 50000),
    minVolume30m: numberEnv("SCOUT_MIN_VOLUME_30M", 100000),
    maxResults: numberEnv("SCOUT_MAX_RESULTS", 100),
  };
}

function pickBaseToken(pool: MeteoraPool): MeteoraToken | null {
  const xQuote = QUOTE_MINTS.has(pool.token_x.address);
  const yQuote = QUOTE_MINTS.has(pool.token_y.address);
  if (xQuote && yQuote) return null;
  return xQuote ? pool.token_y : pool.token_x;
}

export function evaluatePools(pools: MeteoraPool[], config: ScoutConfig): PoolMatch[] {
  const matches: PoolMatch[] = [];
  for (const pool of pools) {
    const base = pickBaseToken(pool);
    if (!base) continue;

    const marketCap = Number(base.market_cap ?? 0);
    if (
      marketCap > config.minMarketCap &&
      pool.tvl > config.minTvl &&
      pool.volume["30m"] > config.minVolume30m &&
      pool.fees["1h"] > config.minFees1h
    ) {
      matches.push({ pool, base });
    }
  }
  return matches;
}

export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(1)}k`;
  return `$${value.toFixed(0)}`;
}

export function formatPoolAlert({ pool, base }: PoolMatch): string {
  return [
    "🟢 HawkFi pool match",
    `${pool.name} · MC ${formatUsd(Number(base.market_cap ?? 0))}`,
    `TVL ${formatUsd(pool.tvl)} · 30m Vol ${formatUsd(pool.volume["30m"])} · 1h Fees ${formatUsd(pool.fees["1h"])}`,
    `Pool: ${pool.address}`,
    `https://app.meteora.ag/dlmm/${pool.address}`,
  ].join("\n");
}

export async function scanOnce(
  config: ScoutConfig,
  options: {
    send?: boolean;
    state?: ScoutState;
    saveState?: (state: ScoutState) => void;
  } = {},
): Promise<PoolMatch[]> {
  const { send = true, state, saveState } = options;

  const pools = await fetchPools({
    minTvl: config.minTvl,
    minVolume30m: config.minVolume30m,
    minFees1h: config.minFees1h,
    pageSize: config.maxResults,
  });

  const matches = evaluatePools(pools, config);

  for (const match of matches) {
    const { pool, base } = match;
    const mcap = formatUsd(Number(base.market_cap ?? 0));
    log(
      `match ${pool.name} · MC ${mcap} · TVL ${formatUsd(pool.tvl)} · ` +
        `30m Vol ${formatUsd(pool.volume["30m"])} · 1h Fees ${formatUsd(pool.fees["1h"])}`,
    );

    if (!send) continue;

    if (state?.[pool.address]) {
      log(`already alerted: ${pool.name} (fired once)`);
      continue;
    }

    try {
      await sendMessage(config.botToken, config.chatId, formatPoolAlert(match));
      if (state) {
        state[pool.address] = { firedAt: new Date().toISOString() };
        saveState?.(state);
      }
      log(`alert sent: ${pool.name} (will not alert again)`);
    } catch (err) {
      log(`telegram send failed for ${pool.name}: ${(err as Error).message}`);
    }
  }

  return matches;
}

export interface ScoutHandle {
  stop: () => void;
}

/**
 * Start the scout scan loop. Returns a handle whose `stop()` halts further scans.
 * Can run standalone (`npm run scout`) or embedded in the price bot (see `index.ts`).
 */
export function startScout(
  config: ScoutConfig,
  options: {
    state?: ScoutState;
    saveState?: (state: ScoutState) => void;
  } = {},
): ScoutHandle {
  const state = options.state ?? loadScoutState();
  const saveState = options.saveState ?? saveScoutState;

  log(
    `HawkFi scout started · interval=${config.intervalMs}ms · chat=${config.chatId} · ` +
      `MC>${formatUsd(config.minMarketCap)} · fees1h>${formatUsd(config.minFees1h)} · ` +
      `TVL>${formatUsd(config.minTvl)} · vol30m>${formatUsd(config.minVolume30m)} · ` +
      `fire-once (${Object.keys(state).length} pool(s) already alerted)`,
  );

  let running = true;
  let scanCount = 0;
  let timer: NodeJS.Timeout | undefined;

  const loop = async (): Promise<void> => {
    const started = Date.now();
    try {
      const matches = await scanOnce(config, { send: true, state, saveState });
      scanCount += 1;
      if (matches.length === 0 && scanCount % 20 === 0) {
        log(`heartbeat · ${scanCount} scans · no matches yet`);
      }
    } catch (err) {
      log(`tick error: ${(err as Error).message}`);
    }

    if (!running) return;
    const elapsed = Date.now() - started;
    timer = setTimeout(loop, Math.max(0, config.intervalMs - elapsed));
  };

  void loop();

  return {
    stop: () => {
      running = false;
      if (timer) clearTimeout(timer);
    },
  };
}

async function main(): Promise<void> {
  const config = loadScoutConfig();
  const scout = startScout(config);

  const shutdown = (signal: string): void => {
    log(`received ${signal}, shutting down`);
    scout.stop();
    setTimeout(() => process.exit(0), 50);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[hawkfi-scout] fatal: ${(err as Error).message}`);
    process.exit(1);
  });
}
