import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Single source of truth for the scout's token/pool selection criteria.
 * Everything lives in `config/selection.json`; nothing here has defaults.
 *
 * Data sources:
 * - Meteora DLMM API (server-side `filter_by`): TVL, fees, fee/TVL ratio, pool age, extraFilters
 * - GMGN token info (checked in code): base-token 5m volume + market cap
 */

export const SELECTION_PATH = resolve(process.cwd(), "config/selection.json");

/** This project only screens Solana. Kept explicit so nothing can silently switch networks. */
export const SUPPORTED_CHAINS = ["sol"] as const;
export type SupportedChain = (typeof SUPPORTED_CHAINS)[number];

export const FEE_WINDOWS = ["5m", "30m", "1h", "2h", "4h", "12h", "24h"] as const;
export type FeeWindow = (typeof FEE_WINDOWS)[number];
export type FeeUnit = "USD" | "SOL";

export interface FeeFloor {
  amount: number;
  unit: FeeUnit;
  window: FeeWindow;
}

export interface SelectionCriteria {
  /** Network for all GMGN lookups. Only `sol` (Solana) is supported. */
  chain: SupportedChain;
  /** Mints treated as the quote side; the other side of the pool is the base token. */
  quoteMints: string[];
  /** GMGN: base-token market cap (price × circulating supply), USD. */
  minMarketCapUsd: number;
  /** GMGN: base-token 5m trading volume across all pools, USD. */
  minVolume5mUsd: number;
  /** Meteora: pool TVL, USD. */
  minTvlUsd: number;
  /** Meteora: `fee_tvl_ratio_1h` as reported by the API (percent, e.g. 0.05 = 0.05%/h). 0 disables. */
  minFeeTvlRatio1h: number;
  /** Meteora: minimum pool age in seconds. 0 disables. */
  minPoolAgeSeconds: number;
  /** Meteora: fees generated in `window`. SOL amounts are converted at the live SOL/USD price. */
  minFees: FeeFloor;
  /** Meteora `sort_by`, e.g. `fee_24h:desc`. */
  sortBy: string;
  /** Meteora `page_size` (1–1000). */
  pageSize: number;
  /** Meteora SOL-USDC pool used to price SOL for SOL-denominated thresholds. */
  solUsdPool: string;
  /** Raw Meteora `filter_by` expressions, AND-ed with the rest (e.g. `is_blacklisted=false`). */
  extraFilters: string[];
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SORT = /^[a-z0-9_]+:(asc|desc)(,[a-z0-9_]+:(asc|desc))*$/;
const FILTER_EXPR = /^\s*[a-z0-9_]+\s*(>=|<=|=|>|<)\s*\S.*$/;

function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`);
}

function nonNegative(raw: Record<string, unknown>, key: string, path: string): number {
  const value = raw[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail(path, `"${key}" must be a non-negative number`);
  }
  return value;
}

export function parseSelection(raw: unknown, path = SELECTION_PATH): SelectionCriteria {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(path, "must be a JSON object");
  const obj = raw as Record<string, unknown>;

  if (obj.chain !== "sol") {
    fail(path, `"chain" must be "sol" — GMGN screening is Solana-only`);
  }

  const quoteMints = obj.quoteMints;
  if (
    !Array.isArray(quoteMints) ||
    quoteMints.length === 0 ||
    !quoteMints.every((m) => typeof m === "string" && BASE58.test(m))
  ) {
    fail(path, `"quoteMints" must be a non-empty array of base58 mint addresses`);
  }

  const fees = obj.minFees as Record<string, unknown> | undefined;
  if (!fees || typeof fees !== "object") fail(path, `"minFees" is required`);
  const feeAmount = nonNegative(fees, "amount", `${path} minFees`);
  if (fees.unit !== "USD" && fees.unit !== "SOL") fail(path, `"minFees.unit" must be "USD" or "SOL"`);
  if (typeof fees.window !== "string" || !(FEE_WINDOWS as readonly string[]).includes(fees.window)) {
    fail(path, `"minFees.window" must be one of ${FEE_WINDOWS.join(", ")}`);
  }

  const sortBy = obj.sortBy;
  if (typeof sortBy !== "string" || !SORT.test(sortBy)) {
    fail(path, `"sortBy" must look like "fee_24h:desc"`);
  }

  const pageSize = obj.pageSize;
  if (typeof pageSize !== "number" || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
    fail(path, `"pageSize" must be an integer between 1 and 1000`);
  }

  const solUsdPool = obj.solUsdPool;
  if (typeof solUsdPool !== "string" || !BASE58.test(solUsdPool)) {
    fail(path, `"solUsdPool" must be a base58 pool address`);
  }

  const extraFilters = obj.extraFilters ?? [];
  if (
    !Array.isArray(extraFilters) ||
    !extraFilters.every((f) => typeof f === "string" && FILTER_EXPR.test(f) && !f.includes("&&"))
  ) {
    fail(path, `"extraFilters" must be an array of single expressions like "is_blacklisted=false"`);
  }

  return {
    chain: obj.chain,
    quoteMints: quoteMints as string[],
    minMarketCapUsd: nonNegative(obj, "minMarketCapUsd", path),
    minVolume5mUsd: nonNegative(obj, "minVolume5mUsd", path),
    minTvlUsd: nonNegative(obj, "minTvlUsd", path),
    minFeeTvlRatio1h: nonNegative(obj, "minFeeTvlRatio1h", path),
    minPoolAgeSeconds: nonNegative(obj, "minPoolAgeSeconds", path),
    minFees: { amount: feeAmount, unit: fees.unit, window: fees.window as FeeWindow },
    sortBy,
    pageSize,
    solUsdPool,
    extraFilters: (extraFilters as string[]).map((f) => f.trim()),
  };
}

export function loadSelection(path: string = SELECTION_PATH): SelectionCriteria {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Failed to read selection criteria at ${path}: ${(err as Error).message}`);
  }
  return parseSelection(parsed, path);
}

export function needsSolPrice(criteria: SelectionCriteria): boolean {
  return criteria.minFees.unit === "SOL" && criteria.minFees.amount > 0;
}

/** Fee floor in USD. `solUsd` is required when the floor is SOL-denominated. */
export function minFeesUsd(criteria: SelectionCriteria, solUsd: number | null): number {
  const { amount, unit } = criteria.minFees;
  if (unit === "USD") return amount;
  if (amount === 0) return 0;
  if (solUsd === null || !Number.isFinite(solUsd) || solUsd <= 0) {
    throw new Error("SOL/USD price required to evaluate a SOL-denominated fee floor");
  }
  return amount * solUsd;
}

/** Builds the Meteora `filter_by` string (all expressions AND-ed). */
export function buildPoolFilter(
  criteria: SelectionCriteria,
  solUsd: number | null,
  now: number = Date.now(),
): string {
  const parts: string[] = [];
  if (criteria.minTvlUsd > 0) parts.push(`tvl>${criteria.minTvlUsd}`);

  const feeFloor = minFeesUsd(criteria, solUsd);
  if (feeFloor > 0) parts.push(`fee_${criteria.minFees.window}>${feeFloor.toFixed(2)}`);

  if (criteria.minFeeTvlRatio1h > 0) parts.push(`fee_tvl_ratio_1h>${criteria.minFeeTvlRatio1h}`);

  // Meteora's pool_created_at is in milliseconds.
  if (criteria.minPoolAgeSeconds > 0) {
    parts.push(`pool_created_at<${Math.floor(now - criteria.minPoolAgeSeconds * 1000)}`);
  }

  parts.push(...criteria.extraFilters);
  return parts.join(" && ");
}

export function describeSelection(criteria: SelectionCriteria): string {
  const { amount, unit, window } = criteria.minFees;
  const parts = [
    `chain=${criteria.chain}`,
    `MC>$${criteria.minMarketCapUsd.toLocaleString("en-US")} (GMGN)`,
    `5m vol>$${criteria.minVolume5mUsd.toLocaleString("en-US")} (GMGN)`,
    `TVL>$${criteria.minTvlUsd.toLocaleString("en-US")}`,
    `fees ${window}>${unit === "SOL" ? `${amount} SOL` : `$${amount.toLocaleString("en-US")}`}`,
  ];
  if (criteria.minFeeTvlRatio1h > 0) parts.push(`fee/TVL 1h>${criteria.minFeeTvlRatio1h}%`);
  if (criteria.minPoolAgeSeconds > 0) parts.push(`age>${criteria.minPoolAgeSeconds}s`);
  if (criteria.extraFilters.length > 0) parts.push(...criteria.extraFilters);
  return parts.join(" · ");
}
