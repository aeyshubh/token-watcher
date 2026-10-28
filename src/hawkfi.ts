const HOST = "https://dlmm.datapi.meteora.ag";
const MAX_ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 15000;
const SOL_MINT = "So11111111111111111111111111111111111111112";
const SOL_PRICE_TTL_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface MeteoraToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  price: number;
  market_cap?: number | null;
}

/** Meteora returns these windows in responses (5m is filterable but not returned). */
export interface TimeWindowMetrics {
  "30m": number;
  "1h": number;
  "2h": number;
  "4h": number;
  "12h": number;
  "24h": number;
}

export interface MeteoraPool {
  address: string;
  name: string;
  token_x: MeteoraToken;
  token_y: MeteoraToken;
  tvl: number;
  current_price?: number;
  created_at?: number;
  volume: TimeWindowMetrics;
  fees: TimeWindowMetrics;
  fee_tvl_ratio?: TimeWindowMetrics;
  is_blacklisted: boolean;
  launchpad?: string | null;
}

export interface PoolQuery {
  /** Meteora `filter_by` expression (already AND-joined). */
  filter: string;
  sortBy: string;
  pageSize: number;
}

interface PoolsResponse {
  total?: number;
  data?: MeteoraPool[];
  message?: string;
}

async function getJson<T>(url: string): Promise<T> {
  let lastError: Error = new Error(`Meteora request failed: ${url}`);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

      if (res.status === 400) {
        // Bad filter/sort: retrying won't help, surface the API's message.
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw Object.assign(new Error(`Meteora HTTP 400${body.message ? `: ${body.message}` : ""}`), {
          fatal: true,
        });
      }
      if (!res.ok) throw new Error(`Meteora HTTP ${res.status}`);

      return (await res.json()) as T;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if ((err as { fatal?: boolean }).fatal) break;
      if (attempt < MAX_ATTEMPTS) await sleep(attempt * 2000);
    }
  }

  throw lastError;
}

export async function fetchPools(query: PoolQuery): Promise<MeteoraPool[]> {
  const params = new URLSearchParams({
    sort_by: query.sortBy,
    page_size: String(query.pageSize),
  });
  if (query.filter) params.set("filter_by", query.filter);

  const json = await getJson<PoolsResponse>(`${HOST}/pools?${params.toString()}`);
  if (!Array.isArray(json.data)) {
    throw new Error(`Meteora returned an unexpected payload${json.message ? `: ${json.message}` : ""}`);
  }
  return json.data;
}

let solPriceCache: { pool: string; price: number; at: number } | null = null;

/** Live SOL/USD from a SOL-quoted Meteora pool, cached for 60s. Throws if unavailable. */
export async function fetchSolUsd(poolAddress: string): Promise<number> {
  const now = Date.now();
  if (solPriceCache && solPriceCache.pool === poolAddress && now - solPriceCache.at < SOL_PRICE_TTL_MS) {
    return solPriceCache.price;
  }

  const pool = await getJson<MeteoraPool>(`${HOST}/pools/${poolAddress}`);
  const sol =
    pool.token_x?.address === SOL_MINT ? pool.token_x : pool.token_y?.address === SOL_MINT ? pool.token_y : null;
  if (!sol) throw new Error(`solUsdPool ${poolAddress} does not contain SOL`);

  const price = Number(sol.price);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`solUsdPool ${poolAddress} returned an invalid SOL price`);
  }

  solPriceCache = { pool: poolAddress, price, at: now };
  return price;
}
