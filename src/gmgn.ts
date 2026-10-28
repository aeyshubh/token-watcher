import { randomUUID } from "node:crypto";
import type { TokenInfo, TokenStats } from "./types";

const HOST = "https://openapi.gmgn.ai";
const MAX_ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 15000;
/** Fallback ban window when a 429 carries no reset timestamp. */
const DEFAULT_BAN_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function minIntervalMs(): number {
  const raw = Number(process.env.GMGN_MIN_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1000;
}

/**
 * Process-wide GMGN throttle (shared by the price loop and the scout).
 * - Requests are serialized and spaced by GMGN_MIN_INTERVAL_MS (default 1000ms).
 * - After a 429, every call fails fast until the reset time: retrying during a
 *   GMGN cooldown extends the ban.
 */
let blockedUntil = 0;
let lastRequestAt = 0;
let queue: Promise<void> = Promise.resolve();

export class GmgnRateLimitError extends Error {
  constructor(public readonly resetAt: number) {
    super(`GMGN rate-limited until ${new Date(resetAt).toISOString()}`);
  }
}

function assertNotBlocked(): void {
  if (Date.now() < blockedUntil) throw new GmgnRateLimitError(blockedUntil);
}

function acquireSlot(): Promise<void> {
  const turn = queue.then(async () => {
    assertNotBlocked();
    const wait = lastRequestAt + minIntervalMs() - Date.now();
    if (wait > 0) await sleep(wait);
    assertNotBlocked();
    lastRequestAt = Date.now();
  });
  queue = turn.catch(() => undefined);
  return turn;
}

async function markRateLimited(res: Response): Promise<number> {
  let resetSec = Number(res.headers.get("x-ratelimit-reset"));
  try {
    const body = (await res.json()) as { reset_at?: number };
    if (Number.isFinite(body.reset_at)) resetSec = Number(body.reset_at);
  } catch {
    // ignore unparsable body
  }
  const resetAt =
    Number.isFinite(resetSec) && resetSec * 1000 > Date.now() ? resetSec * 1000 + 500 : Date.now() + DEFAULT_BAN_MS;
  blockedUntil = Math.max(blockedUntil, resetAt);
  return blockedUntil;
}

interface GmgnTokenData {
  address: string;
  symbol: string;
  name: string;
  liquidity: string | number;
  circulating_supply?: string | number;
  total_supply?: string | number;
  price: {
    price: string;
    volume_5m?: string | number;
    volume_1h?: string | number;
    volume_24h?: string | number;
  };
}

interface GmgnResponse {
  code: number;
  message?: string;
  data?: GmgnTokenData;
}

async function fetchTokenData(apiKey: string, chain: string, address: string): Promise<GmgnTokenData> {
  if (chain !== "sol") {
    throw new Error(`GMGN screening is Solana-only (chain=sol), got "${chain}"`);
  }
  let lastError: Error = new Error("GMGN request failed");

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await acquireSlot();

      const params = new URLSearchParams({
        chain,
        address,
        timestamp: String(Math.floor(Date.now() / 1000)),
        client_id: randomUUID(),
      });

      const res = await fetch(`${HOST}/v1/token/info?${params.toString()}`, {
        headers: { "X-APIKEY": apiKey, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (res.status === 429) {
        throw new GmgnRateLimitError(await markRateLimited(res));
      }
      if (res.status >= 500) {
        throw new Error(`GMGN HTTP ${res.status}`);
      }

      const json = (await res.json()) as GmgnResponse;
      if (json.code !== 0 || !json.data) {
        throw new Error(`GMGN error code=${json.code}${json.message ? ` ${json.message}` : ""}`);
      }
      return json.data;
    } catch (err) {
      // Never retry into a rate-limit cooldown.
      if (err instanceof GmgnRateLimitError) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_ATTEMPTS) {
        await sleep(attempt * 2000);
      }
    }
  }

  throw lastError;
}

function parsePrice(data: GmgnTokenData): number {
  const price = Number(data.price?.price);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("GMGN returned a non-numeric price");
  }
  return price;
}

function finiteOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export async function getTokenInfo(
  apiKey: string,
  chain: string,
  address: string,
): Promise<TokenInfo> {
  const data = await fetchTokenData(apiKey, chain, address);
  return {
    address: data.address,
    symbol: data.symbol,
    name: data.name,
    price: parsePrice(data),
    liquidity: Number(data.liquidity),
  };
}

/**
 * Token info plus trading stats used by the scout.
 * Volumes are token-wide (all pools GMGN indexes), in USD.
 * Market cap = price × circulating supply (falls back to total supply).
 */
export async function getTokenStats(
  apiKey: string,
  chain: string,
  address: string,
): Promise<TokenStats> {
  const data = await fetchTokenData(apiKey, chain, address);
  if (data.address && data.address !== address) {
    throw new Error(`GMGN returned data for ${data.address}, expected ${address}`);
  }

  const price = parsePrice(data);
  const supply = finiteOr(data.circulating_supply, NaN);
  const fallbackSupply = finiteOr(data.total_supply, NaN);
  const effectiveSupply = supply > 0 ? supply : fallbackSupply;
  if (!(effectiveSupply > 0)) {
    throw new Error("GMGN returned no usable supply for market cap");
  }

  const volume5m = Number(data.price.volume_5m);
  if (!Number.isFinite(volume5m)) {
    throw new Error("GMGN returned no 5m volume");
  }

  return {
    address,
    symbol: data.symbol,
    name: data.name,
    price,
    liquidity: finiteOr(data.liquidity, 0),
    marketCap: price * effectiveSupply,
    volume5m,
    volume1h: finiteOr(data.price.volume_1h, 0),
    volume24h: finiteOr(data.price.volume_24h, 0),
  };
}
