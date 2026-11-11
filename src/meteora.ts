import {
  acquireMeteoraSlot,
  markMeteoraRateLimited,
  MeteoraRateLimitError,
} from "./meteora-rate";

const HOST = "https://dlmm.datapi.meteora.ag";
const MAX_ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 20000;
const PORTFOLIO_PAGE_SIZE = 50;
const PORTFOLIO_MAX_PAGES = 20;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson<T>(path: string): Promise<T | null> {
  let lastError: Error = new Error(`Meteora request failed: ${path}`);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await acquireMeteoraSlot();
      const res = await fetch(`${HOST}${path}`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (res.status === 404 || res.status === 400) return null;
      if (res.status === 429) {
        throw new MeteoraRateLimitError(await markMeteoraRateLimited(res));
      }
      if (res.status >= 500) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : attempt * 1500;
        throw new Error(`Meteora HTTP ${res.status} (retry in ${waitMs}ms)`);
      }
      if (!res.ok) throw new Error(`Meteora HTTP ${res.status}`);

      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof MeteoraRateLimitError) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_ATTEMPTS) await sleep(attempt * 1200);
    }
  }

  throw lastError;
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

export interface OpenPortfolioPool {
  poolAddress: string;
  binStep: number;
  baseFee: number;
  collectFeeMode: number;
  tokenX: string;
  tokenY: string;
  tokenXMint: string;
  tokenYMint: string;
  tokenXIcon?: string;
  tokenYIcon?: string;
  rewardX?: string;
  rewardY?: string;
  balances: string;
  balancesSol?: string | null;
  unclaimedFees: string;
  feePerTvl24h: string;
  pnl: string;
  pnlPctChange: string;
  pnlSol?: string | null;
  pnlSolPctChange?: string | null;
  poolPrice?: number | null;
  totalDeposit: string;
  totalDepositSol?: string | null;
  openPositionCount: number;
  listPositions: string[];
  positionsOutOfRange: string[];
  outOfRange?: boolean | null;
}

export interface OpenPortfolioResponse {
  hasNext: boolean;
  page: number;
  pageSize: number;
  pools: OpenPortfolioPool[];
  solPrice?: string | null;
  totalCount: number;
  totalPositions: number;
}

const EMPTY_PORTFOLIO: OpenPortfolioResponse = {
  hasNext: false,
  page: 1,
  pageSize: PORTFOLIO_PAGE_SIZE,
  pools: [],
  totalCount: 0,
  totalPositions: 0,
};

/** All pools where a wallet has open DLMM positions (auto-detection entrypoint). */
export async function fetchOpenPortfolio(
  user: string,
  maxPages: number = PORTFOLIO_MAX_PAGES,
): Promise<OpenPortfolioResponse> {
  const pools: OpenPortfolioPool[] = [];
  let first: OpenPortfolioResponse | null = null;

  for (let page = 1; page <= maxPages; page += 1) {
    const res = await getJson<OpenPortfolioResponse>(
      `/portfolio/open?user=${user}&page=${page}&page_size=${PORTFOLIO_PAGE_SIZE}`,
    );
    if (!res || !Array.isArray(res.pools)) break;
    if (!first) first = res;
    pools.push(...res.pools);
    if (!res.hasNext) break;
  }

  const base = first ?? EMPTY_PORTFOLIO;
  return { ...base, pools };
}


