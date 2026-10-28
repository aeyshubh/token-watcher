import "dotenv/config";
import { fetchPools, fetchSolUsd, type MeteoraPool, type MeteoraToken } from "./hawkfi";
import { getTokenStats } from "./gmgn";
import { sendMessage } from "./telegram";
import {
  buildPoolFilter,
  describeSelection,
  loadSelection,
  needsSolPrice,
  type SelectionCriteria,
} from "./selection";
import {
  loadScoutState,
  saveScoutState,
  type ScoutState,
} from "./scout-state";
import type { TokenStats } from "./types";

/** GMGN calls are serialized/throttled in gmgn.ts; this only bounds in-flight promises. */
const GMGN_CONCURRENCY = 2;
/** Reuse a token's GMGN stats across scans for this long (5m volume tolerates ~30s staleness). */
const TOKEN_STATS_TTL_MS = 30_000;
const statsCache = new Map<string, { stats: TokenStats; at: number }>();

/** Runtime settings come from .env; all selection criteria come from config/selection.json. */
export interface ScoutConfig {
  botToken: string;
  chatId: string;
  gmgnApiKey: string;
  intervalMs: number;
  minAlertIntervalMs: number;
  selection: SelectionCriteria;
}

export interface PoolMatch {
  pool: MeteoraPool;
  base: MeteoraToken;
  token: TokenStats;
  solUsd: number | null;
}

export interface ScanResult {
  matches: PoolMatch[];
  /** Pools that passed Meteora's server-side filters (before GMGN checks). */
  candidates: number;
  rejected: { pool: MeteoraPool; reason: string }[];
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
  overrides: Partial<Pick<ScoutConfig, "botToken" | "chatId" | "gmgnApiKey">> = {},
): ScoutConfig {
  return {
    botToken: overrides.botToken ?? required("TELEGRAM_BOT_TOKEN"),
    chatId: overrides.chatId ?? required("TELEGRAM_CHAT_ID"),
    gmgnApiKey: overrides.gmgnApiKey ?? required("GMGN_API_KEY"),
    intervalMs: numberEnv("SCOUT_INTERVAL_MS", 15000),
    minAlertIntervalMs: numberEnv("SCOUT_MIN_ALERT_INTERVAL_MS", 60000, true),
    selection: loadSelection(),
  };
}

function pickBaseToken(pool: MeteoraPool, quoteMints: Set<string>): MeteoraToken | null {
  const xQuote = quoteMints.has(pool.token_x.address);
  const yQuote = quoteMints.has(pool.token_y.address);
  if (xQuote && yQuote) return null;
  return xQuote ? pool.token_y : pool.token_x;
}

/** GMGN-side criteria (token-wide). Returns a rejection reason, or null if the token passes. */
export function checkToken(token: TokenStats, criteria: SelectionCriteria): string | null {
  if (!(token.marketCap > criteria.minMarketCapUsd)) {
    return `MC ${formatUsd(token.marketCap)} ≤ ${formatUsd(criteria.minMarketCapUsd)}`;
  }
  if (!(token.volume5m > criteria.minVolume5mUsd)) {
    return `5m vol ${formatUsd(token.volume5m)} ≤ ${formatUsd(criteria.minVolume5mUsd)}`;
  }
  return null;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function evaluatePools(
  pools: MeteoraPool[],
  config: ScoutConfig,
  solUsd: number | null,
): Promise<ScanResult> {
  const quoteMints = new Set(config.selection.quoteMints);
  const rejected: ScanResult["rejected"] = [];
  const withBase: { pool: MeteoraPool; base: MeteoraToken }[] = [];

  for (const pool of pools) {
    const base = pickBaseToken(pool, quoteMints);
    if (!base) {
      rejected.push({ pool, reason: "both sides are quote mints" });
      continue;
    }
    withBase.push({ pool, base });
  }

  // One GMGN lookup per unique base token, cached briefly across scans.
  const addresses = [...new Set(withBase.map((c) => c.base.address))];
  const lookups = await mapLimit(addresses, GMGN_CONCURRENCY, async (address) => {
    const cached = statsCache.get(address);
    if (cached && Date.now() - cached.at < TOKEN_STATS_TTL_MS) return { address, stats: cached.stats };
    try {
      const stats = await getTokenStats(config.gmgnApiKey, config.selection.chain, address);
      statsCache.set(address, { stats, at: Date.now() });
      return { address, stats };
    } catch (err) {
      return { address, error: (err as Error).message };
    }
  });
  for (const [address, entry] of statsCache) {
    if (Date.now() - entry.at >= TOKEN_STATS_TTL_MS) statsCache.delete(address);
  }
  const byAddress = new Map(lookups.map((l) => [l.address, l]));

  const matches: PoolMatch[] = [];
  for (const { pool, base } of withBase) {
    const lookup = byAddress.get(base.address);
    if (!lookup || !("stats" in lookup) || !lookup.stats) {
      rejected.push({ pool, reason: `GMGN lookup failed: ${lookup && "error" in lookup ? lookup.error : "unknown"}` });
      continue;
    }
    const reason = checkToken(lookup.stats, config.selection);
    if (reason) {
      rejected.push({ pool, reason });
      continue;
    }
    matches.push({ pool, base, token: lookup.stats, solUsd });
  }

  return { matches, candidates: pools.length, rejected };
}

export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(1)}k`;
  return `$${value.toFixed(0)}`;
}

function formatAge(createdAtMs: number | undefined): string {
  if (!createdAtMs || !Number.isFinite(createdAtMs)) return "n/a";
  const hours = (Date.now() - createdAtMs) / 3_600_000;
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function poolFees(pool: MeteoraPool, window: SelectionCriteria["minFees"]["window"]): number {
  const value = (pool.fees as unknown as Record<string, number | undefined>)[window];
  return typeof value === "number" ? value : NaN;
}

export function formatPoolAlert(match: PoolMatch, criteria: SelectionCriteria): string {
  const { pool, token, solUsd } = match;
  const window = criteria.minFees.window;
  const fees = poolFees(pool, window);
  const feesSol = solUsd && Number.isFinite(fees) ? ` (~${(fees / solUsd).toFixed(1)} SOL)` : "";
  const ratio = pool.fee_tvl_ratio?.["1h"];

  return [
    "🟢 HawkFi pool match",
    `${pool.name} · MC ${formatUsd(token.marketCap)}`,
    `TVL ${formatUsd(pool.tvl)} · 5m Vol ${formatUsd(token.volume5m)} (token, GMGN)`,
    `${window} Fees ${formatUsd(fees)}${feesSol} · Fee/TVL 1h ${typeof ratio === "number" ? `${ratio.toFixed(3)}%` : "n/a"} · age ${formatAge(pool.created_at)}`,
    `Pool: ${pool.address}`,
    `https://www.hawkfi.ag/meteora/${pool.address}?create=true`,
  ].join("\n");
}

function summarize(match: PoolMatch, criteria: SelectionCriteria): string {
  const { pool, token } = match;
  return (
    `${pool.name} · MC ${formatUsd(token.marketCap)} · TVL ${formatUsd(pool.tvl)} · ` +
    `5m Vol ${formatUsd(token.volume5m)} · ${criteria.minFees.window} Fees ${formatUsd(poolFees(pool, criteria.minFees.window))}`
  );
}

export async function scanOnce(
  config: ScoutConfig,
  options: {
    send?: boolean;
    verbose?: boolean;
    state?: ScoutState;
    saveState?: (state: ScoutState) => void;
  } = {},
): Promise<ScanResult> {
  const { send = true, verbose = false, state, saveState } = options;
  const criteria = config.selection;

  const solUsd = needsSolPrice(criteria) ? await fetchSolUsd(criteria.solUsdPool) : null;
  const filter = buildPoolFilter(criteria, solUsd);
  if (verbose) {
    log(`SOL/USD ${solUsd ?? "n/a"} · filter_by: ${filter}`);
  }

  const pools = await fetchPools({
    filter,
    sortBy: criteria.sortBy,
    pageSize: criteria.pageSize,
  });

  const result = await evaluatePools(pools, config, solUsd);

  if (verbose) {
    log(`${result.candidates} pool(s) passed Meteora filters`);
    for (const { pool, reason } of result.rejected) log(`rejected ${pool.name}: ${reason}`);
  } else {
    const gmgnFailures = result.rejected.filter((r) => r.reason.startsWith("GMGN lookup failed"));
    if (gmgnFailures.length > 0) {
      log(`GMGN unavailable for ${gmgnFailures.length} candidate(s): ${gmgnFailures[0].reason}`);
    }
  }

  for (const match of result.matches) {
    const { pool } = match;
    log(`match ${summarize(match, criteria)}`);

    if (!send) continue;

    const lastAlert = state?.[pool.address];
    if (lastAlert) {
      if (config.minAlertIntervalMs <= 0) {
        log(`already alerted: ${pool.name} (fired once)`);
        continue;
      }
      const elapsed = Date.now() - new Date(lastAlert.firedAt).getTime();
      if (elapsed < config.minAlertIntervalMs) {
        const left = Math.ceil((config.minAlertIntervalMs - elapsed) / 1000);
        log(`cooldown: ${pool.name} (${left}s left)`);
        continue;
      }
    }

    try {
      await sendMessage(config.botToken, config.chatId, formatPoolAlert(match, criteria));
      if (state) {
        state[pool.address] = { firedAt: new Date().toISOString() };
        saveState?.(state);
      }
      log(
        `alert sent: ${pool.name} ` +
          `(${config.minAlertIntervalMs > 0 ? `re-alerts after ${Math.round(config.minAlertIntervalMs / 1000)}s` : "will not alert again"})`,
      );
    } catch (err) {
      log(`telegram send failed for ${pool.name}: ${(err as Error).message}`);
    }
  }

  return result;
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
      `${describeSelection(config.selection)} · ` +
      `${config.minAlertIntervalMs > 0 ? `re-alert every ${Math.round(config.minAlertIntervalMs / 1000)}s` : "fire-once"} ` +
      `(${Object.keys(state).length} pool(s) already alerted)`,
  );

  let running = true;
  let scanCount = 0;
  let timer: NodeJS.Timeout | undefined;

  const loop = async (): Promise<void> => {
    const started = Date.now();
    try {
      const { matches, candidates } = await scanOnce(config, { send: true, state, saveState });
      scanCount += 1;
      if (matches.length === 0 && scanCount % 20 === 0) {
        log(`heartbeat · ${scanCount} scans · no matches yet (${candidates} Meteora candidate(s) last scan)`);
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
