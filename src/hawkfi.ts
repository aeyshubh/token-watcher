const HOST = "https://dlmm.datapi.meteora.ag";
const MAX_ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 15000;

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
  volume: TimeWindowMetrics;
  fees: TimeWindowMetrics;
  is_blacklisted: boolean;
  launchpad?: string | null;
}

export interface PoolQuery {
  minTvl: number;
  minVolume30m: number;
  minFees1h: number;
  pageSize: number;
}

interface PoolsResponse {
  total?: number;
  data?: MeteoraPool[];
}

export async function fetchPools(query: PoolQuery): Promise<MeteoraPool[]> {
  const filter = [
    `tvl>${query.minTvl}`,
    `volume_30m>${query.minVolume30m}`,
    `fee_1h>${query.minFees1h}`,
  ].join(" && ");

  const qs =
    `filter_by=${encodeURIComponent(filter)}` +
    `&sort_by=${encodeURIComponent("fee_1h:desc")}` +
    `&page_size=${query.pageSize}`;

  let lastError: Error = new Error("Meteora pools request failed");

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(`${HOST}/pools?${qs}`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!res.ok) {
        throw new Error(`Meteora HTTP ${res.status}`);
      }

      const json = (await res.json()) as PoolsResponse;
      if (!Array.isArray(json.data)) {
        throw new Error("Meteora returned an unexpected payload");
      }
      return json.data;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_ATTEMPTS) {
        await sleep(attempt * 2000);
      }
    }
  }

  throw lastError;
}
