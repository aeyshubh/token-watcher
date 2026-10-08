const HOST = "https://dlmm.datapi.meteora.ag";
const MAX_ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 20000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson<T>(path: string): Promise<T | null> {
  let lastError: Error = new Error(`Meteora request failed: ${path}`);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(`${HOST}${path}`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (res.status === 404 || res.status === 400) return null;
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : attempt * 1500;
        throw new Error(`Meteora HTTP ${res.status} (retry in ${waitMs}ms)`);
      }
      if (!res.ok) throw new Error(`Meteora HTTP ${res.status}`);

      return (await res.json()) as T;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_ATTEMPTS) await sleep(attempt * 1200);
    }
  }

  throw lastError;
}

export interface MeteoraTokenDetail {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  price: number;
  market_cap: number | null;
  holders?: number;
  freeze_authority_disabled?: boolean;
}

export interface TimeWindowMetrics {
  "30m": number;
  "1h": number;
  "2h": number;
  "4h": number;
  "12h": number;
  "24h": number;
}

export interface MeteoraPoolDetail {
  address: string;
  name: string;
  token_x: MeteoraTokenDetail;
  token_y: MeteoraTokenDetail;
  tvl: number;
  current_price: number;
  volume: TimeWindowMetrics;
  fees: TimeWindowMetrics;
  fee_tvl_ratio: TimeWindowMetrics;
  dynamic_fee_pct: number;
  pool_config: { bin_step: number; base_fee_pct: number; protocol_fee_pct: number; collect_fee_mode: number };
  launchpad?: string | null;
  is_blacklisted: boolean;
}

export interface TokenAmount {
  amount: string;
  usd: string;
  amountSol?: string | null;
}

export interface TokenPairTotal {
  tokenX: TokenAmount;
  tokenY: TokenAmount;
  total: { usd: string; sol?: string | null };
}

export interface UnrealizedPnl {
  balances: number;
  balancesSol?: string | null;
  balanceTokenX: TokenAmount;
  balanceTokenY: TokenAmount;
  unclaimedFeeTokenX: TokenAmount;
  unclaimedFeeTokenY: TokenAmount;
  unclaimedRewardTokenX?: TokenAmount;
  unclaimedRewardTokenY?: TokenAmount;
}

export interface PositionPnl {
  positionAddress: string;
  minPrice: string;
  maxPrice: string;
  lowerBinId: number;
  upperBinId: number;
  poolActivePrice?: string | null;
  feePerTvl24h: string;
  isClosed: boolean;
  isOutOfRange?: boolean | null;
  pnlUsd: string;
  pnlPctChange: string;
  pnlSol?: number | null;
  createdAt?: number | null;
  closedAt?: number | null;
  allTimeDeposits: TokenPairTotal;
  allTimeWithdrawals: TokenPairTotal;
  allTimeFees: TokenPairTotal;
  unrealizedPnl?: UnrealizedPnl | null;
}

interface PositionPnlResponse {
  totalCount: number;
  hasNext: boolean;
  page: number;
  positions: PositionPnl[];
  tokenX?: string | null;
  tokenY?: string | null;
  tokenXPrice?: string;
  tokenYPrice?: string;
  solPrice?: string | null;
}

export async function fetchPool(address: string): Promise<MeteoraPoolDetail | null> {
  return getJson<MeteoraPoolDetail>(`/pools/${address}`);
}

export async function fetchPositions(
  pool: string,
  user: string,
  status: "open" | "closed" | "all" = "all",
): Promise<PositionPnl[]> {
  const out: PositionPnl[] = [];
  let page = 1;
  // Bounded pagination (max 5 pages = 500 positions) to keep bot latency sane.
  while (page <= 5) {
    const res = await getJson<PositionPnlResponse>(
      `/positions/${pool}/pnl?user=${user}&status=${status}&page=${page}&page_size=100`,
    );
    if (!res || !Array.isArray(res.positions)) break;
    out.push(...res.positions);
    if (!res.hasNext) break;
    page += 1;
  }
  return out;
}

export interface WalletClaims {
  totalClaimsUsd: number;
  totalFeeUsd: number;
  feeClaimCount: number;
  lastFeeClaimTime?: string | null;
}

export async function fetchTotalClaims(wallet: string, pool: string): Promise<WalletClaims | null> {
  const res = await getJson<{
    total_claims_usd?: string;
    total_fee_x_usd?: string;
    total_fee_y_usd?: string;
    fee_claim_count?: number;
    last_fee_claim_time?: string | null;
  }>(`/wallets/${wallet}/pools/${pool}/total_claims`);
  if (!res) return null;
  const total = Number(res.total_claims_usd ?? 0);
  const feeX = Number(res.total_fee_x_usd ?? 0);
  const feeY = Number(res.total_fee_y_usd ?? 0);
  return {
    totalClaimsUsd: Number.isFinite(total) ? total : 0,
    totalFeeUsd: (Number.isFinite(feeX) ? feeX : 0) + (Number.isFinite(feeY) ? feeY : 0),
    feeClaimCount: res.fee_claim_count ?? 0,
    lastFeeClaimTime: res.last_fee_claim_time ?? null,
  };
}
