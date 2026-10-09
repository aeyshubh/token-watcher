import {
  fetchPool,
  fetchPositions,
  fetchTotalClaims,
  type MeteoraPoolDetail,
  type PositionPnl,
} from "./meteora";
import {
  decodeFullPosition,
  fetchPoolLps,
  getAccountInfo,
  isBase58,
  isPositionV2,
  mapLimit,
  type PoolLp,
} from "./solana";

const QUOTE_SYMBOLS = new Set(["SOL", "WSOL", "USDC", "USDT", "USDG", "JUP", "JLP", "PYUSD"]);

export interface PositionAnalysisOptions {
  rpcUrl: string;
  topWallets: number;
}

export interface ResolvedTarget {
  pool?: string;
  owner?: string;
  position?: string;
  poolDetail?: MeteoraPoolDetail;
}

// ---------------------------------------------------------------------------
// formatting helpers
// ---------------------------------------------------------------------------
export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`;
  return `${sign}$${abs.toFixed(abs < 10 ? 2 : 0)}`;
}

function formatPct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function short(address: string): string {
  return address.length <= 10 ? address : `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function num(value: string | number | null | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function isQuote(token: { symbol: string; address: string }): boolean {
  return QUOTE_SYMBOLS.has(token.symbol) || token.address === "So11111111111111111111111111111111111111112";
}

function baseToken(pool: MeteoraPoolDetail) {
  return isQuote(pool.token_x) ? pool.token_y : pool.token_x;
}

// ---------------------------------------------------------------------------
// input resolution
// ---------------------------------------------------------------------------
export function extractAddresses(input: string): string[] {
  const found = new Set<string>();
  const matches = input.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) ?? [];
  for (const match of matches) {
    if (isBase58(match)) found.add(match);
  }
  return [...found];
}

export async function resolveTarget(
  input: string,
  rpcUrl: string,
): Promise<ResolvedTarget> {
  const candidates = extractAddresses(input);
  const result: ResolvedTarget = {};

  // 1) a PositionV2 account reveals both the pool and the owner on-chain
  for (const candidate of candidates) {
    try {
      const account = await getAccountInfo(rpcUrl, candidate);
      if (account && isPositionV2(account.data)) {
        const decoded = decodeFullPosition(account.data);
        result.position = candidate;
        result.owner = decoded.owner;
        result.pool = decoded.pool;
        return result;
      }
    } catch {
      // ignore and keep trying
    }
  }

  // 2) otherwise, find the pool among the candidates
  for (const candidate of candidates) {
    const pool = await fetchPool(candidate);
    if (pool) {
      result.pool = candidate;
      result.poolDetail = pool;
      break;
    }
  }

  // 3) any leftover candidate is treated as the wallet
  if (result.pool) {
    const wallet = candidates.find((c) => c !== result.pool);
    if (wallet) result.owner = wallet;
  }

  return result;
}

// ---------------------------------------------------------------------------
// user position
// ---------------------------------------------------------------------------
interface UserPositionReport {
  lines: string[];
}

function sideOf(position: PositionPnl): "single-quote" | "single-base" | "dual" | "unknown" {
  const x = num(position.allTimeDeposits.tokenX.usd);
  const y = num(position.allTimeDeposits.tokenY.usd);
  const total = x + y;
  if (total <= 0) return "unknown";
  const fx = x / total;
  if (fx >= 0.9) return "single-base";
  if (fx <= 0.1) return "single-quote";
  return "dual";
}

function mcapScaler(pool: MeteoraPoolDetail): (ratio: number) => number {
  const base = baseToken(pool);
  const currentMcap = num(base.market_cap);
  const currentPrice = pool.current_price;
  const baseIsX = !isQuote(pool.token_x);
  return (ratio: number) => {
    if (!currentPrice || !ratio) return currentMcap;
    return baseIsX
      ? (currentMcap * ratio) / currentPrice
      : (currentMcap * currentPrice) / ratio;
  };
}

function buildUserReport(
  pool: MeteoraPoolDetail,
  position: PositionPnl,
  now: number,
): UserPositionReport {
  const base = baseToken(pool);
  const lines: string[] = [];
  const open = !position.isClosed;
  const deposit = num(position.allTimeDeposits.total.usd);
  const fees = num(position.allTimeFees.total.usd);
  const balance = position.unrealizedPnl ? position.unrealizedPnl.balances : num(position.allTimeWithdrawals.total.usd);
  const pnlUsd = num(position.pnlUsd);
  const pnlPct = num(position.pnlPctChange);
  const ageHours = position.createdAt ? (now - position.createdAt) / 3600 : null;
  const feeYield = deposit > 0 ? (fees / deposit) * 100 : 0;
  const scale = mcapScaler(pool);
  const lowMcap = scale(num(position.minPrice));
  const highMcap = scale(num(position.maxPrice));
  const currentMcap = num(base.market_cap);
  const price = pool.current_price;
  const inRange = price >= num(position.minPrice) && price <= num(position.maxPrice);
  const side = sideOf(position);

  lines.push(`📊 Your position — ${pool.name}`);
  lines.push(`Balance ${formatUsd(balance)} · age ${ageHours === null ? "n/a" : `${ageHours.toFixed(1)}h`}`);
  lines.push(
    `Fees ${formatUsd(fees)} (${feeYield.toFixed(1)}% of deposit) · unclaimed ${formatUsd(
      num(position.unrealizedPnl?.unclaimedFeeTokenX.usd) + num(position.unrealizedPnl?.unclaimedFeeTokenY.usd),
    )}`,
  );
  lines.push(`PnL ${formatUsd(pnlUsd)} (${formatPct(pnlPct)})`);
  lines.push(`Deposit ${formatUsd(deposit)} · ${side} · ${position.lowerBinId}…${position.upperBinId} bins`);
  lines.push(
    `Range ${formatUsd(lowMcap)}–${formatUsd(highMcap)} mcap · now ${formatUsd(currentMcap)} · ` +
      `${inRange ? "IN range" : "OUT of range"}`,
  );
  lines.push(`Mcap to exit low ${formatUsd(lowMcap)} / high ${formatUsd(highMcap)}`);
  lines.push("");
  lines.push(...verdict(pool, position, { inRange, lowMcap, highMcap, currentMcap, feeYield, pnlPct }));
  void open;
  return { lines };
}

function verdict(
  pool: MeteoraPoolDetail,
  position: PositionPnl,
  ctx: { inRange: boolean; lowMcap: number; highMcap: number; currentMcap: number; feeYield: number; pnlPct: number },
): string[] {
  const out: string[] = [];
  const price = pool.current_price;
  const belowRange = price < num(position.minPrice);
  const aboveRange = price > num(position.maxPrice);

  if (belowRange) out.push("⚠️ Price BELOW your range → you are 100% in the token now.");
  if (aboveRange) out.push("ℹ️ Price ABOVE your range → you are 100% in SOL, earning no fees.");

  let call: string;
  if (belowRange) call = "CLOSE / DE-RISK";
  else if (ctx.inRange && ctx.feeYield >= 3) call = "HOLD";
  else if (ctx.inRange) call = "HOLD (with triggers)";
  else call = "HOLD / redeploy";

  const emoji = call.startsWith("HOLD") ? "🟢" : "🔴";
  out.push(`${emoji} Verdict: ${call}`);

  const triggers: string[] = [];
  if (ctx.lowMcap > 0) triggers.push(`mcap breaks ~${formatUsd(ctx.lowMcap)} (range floor)`);
  triggers.push("hourly pool fees collapse (< ~$300/hr)");
  if (belowRange) triggers.push("any further weakness → cut");
  out.push(`Close triggers: ${triggers.join("; ")}.`);
  return out;
}

// ---------------------------------------------------------------------------
// top wallets
// ---------------------------------------------------------------------------
interface WalletRow {
  owner: string;
  feesClaimed: number;
  size: number;
  pnlUsd: number;
  pnlPct: number;
  positions: number;
  inRange: boolean;
  side: string;
  ageHours: number | null;
}

async function buildWalletRow(pool: string, lp: PoolLp, claims: number, now: number): Promise<WalletRow> {
  const open = await fetchPositions(pool, lp.owner, "open");
  let size = 0;
  let pnlUsd = 0;
  let pnlPct = 0;
  let inRange = false;
  let side = "—";
  let ageHours: number | null = null;

  for (const position of open) {
    size += position.unrealizedPnl ? position.unrealizedPnl.balances : 0;
    pnlUsd += num(position.pnlUsd);
    pnlPct = Math.max(pnlPct, num(position.pnlPctChange));
    if (!position.isOutOfRange) inRange = true;
    if (ageHours === null && position.createdAt) ageHours = (now - position.createdAt) / 3600;
    side = sideOf(position);
  }

  return {
    owner: lp.owner,
    feesClaimed: claims,
    size,
    pnlUsd,
    pnlPct,
    positions: open.length,
    inRange,
    side,
    ageHours,
  };
}

function formatWalletRow(row: WalletRow, index: number): string {
  const pnl = row.positions > 0 ? `${formatUsd(row.pnlUsd)} (${formatPct(row.pnlPct)})` : "exited";
  const status = row.positions === 0 ? "❌ out" : row.inRange ? "✅ in-range" : "🟡 o-o-r";
  const age = row.ageHours === null ? "—" : `${row.ageHours.toFixed(0)}h`;
  return (
    `${String(index).padStart(2)}. ${short(row.owner)}  ` +
    `fees ${formatUsd(row.feesClaimed)} | size ${formatUsd(row.size)} | ${pnl} | ${status} | ${row.side} | ${age}`
  );
}

async function buildTopWallets(
  pool: string,
  options: PositionAnalysisOptions,
  now: number,
): Promise<string[]> {
  const lines: string[] = [];
  let lps: PoolLp[];
  try {
    lps = await fetchPoolLps(options.rpcUrl, pool, options.topWallets * 5);
  } catch (err) {
    return [`👥 Top wallets: on-chain scan failed (${(err as Error).message})`];
  }
  if (lps.length === 0) return ["👥 Top wallets: no PositionV2 accounts found for this pool."];

  // Pre-rank by on-chain liquidity, then rank the shortlist by fees claimed.
  const shortlist = lps.slice(0, Math.min(lps.length, options.topWallets * 3));
  const claimed = await mapLimit(shortlist, 8, async (lp) => {
    try {
      const claims = await fetchTotalClaims(lp.owner, pool);
      return { lp, fees: claims?.totalClaimsUsd ?? 0 };
    } catch {
      return { lp, fees: 0 };
    }
  });
  claimed.sort((a, b) => b.fees - a.fees);
  const top = claimed.slice(0, options.topWallets);

  const rows = await mapLimit(top, 6, async (entry) => {
    try {
      return await buildWalletRow(pool, entry.lp, entry.fees, now);
    } catch {
      return {
        owner: entry.lp.owner,
        feesClaimed: entry.fees,
        size: 0,
        pnlUsd: 0,
        pnlPct: 0,
        positions: 0,
        inRange: false,
        side: "—",
        ageHours: null,
      } satisfies WalletRow;
    }
  });

  const holding = rows.filter((r) => r.positions > 0).length;
  const exited = rows.length - holding;
  const netPositive = rows.filter((r) => r.pnlUsd > 0).length;
  const netNegative = rows.filter((r) => r.pnlUsd < 0).length;

  lines.push(`👥 Top ${rows.length} wallets in pool (ranked by fees claimed)`);
  lines.push(`Sampled from ${lps.length} on-chain LPs.`);
  lines.push("");
  rows.forEach((row, i) => lines.push(formatWalletRow(row, i + 1)));
  lines.push("");
  lines.push(
    `📈 Crowd: ${holding} holding / ${exited} exited · ${netPositive} net-positive, ${netNegative} net-negative.`,
  );
  lines.push(
    exited >= holding
      ? "⚠️ More than half the top wallets have exited — distribution risk."
      : "✅ Majority of top wallets still holding — healthy.",
  );
  return lines;
}

// ---------------------------------------------------------------------------
// pool health
// ---------------------------------------------------------------------------
function buildPoolHealth(pool: MeteoraPoolDetail): string[] {
  const base = baseToken(pool);
  return [
    `🏊 Pool ${pool.name} · ${pool.address}`,
    `MC ${formatUsd(num(base.market_cap))} · TVL ${formatUsd(pool.tvl)} · price ${pool.current_price}`,
    `bin step ${pool.pool_config.bin_step} · base fee ${pool.pool_config.base_fee_pct}%`,
    `Vol 1h ${formatUsd(pool.volume["1h"])} / 24h ${formatUsd(pool.volume["24h"])} · ` +
      `Fees 1h ${formatUsd(pool.fees["1h"])} / 24h ${formatUsd(pool.fees["24h"])}`,
  ];
}

// ---------------------------------------------------------------------------
// orchestrator
// ---------------------------------------------------------------------------
export async function analyzePositionInput(
  input: string,
  options: PositionAnalysisOptions,
): Promise<string[]> {
  const now = Math.floor(Date.now() / 1000);
  const target = await resolveTarget(input, options.rpcUrl);

  if (!target.pool) {
    return [
      "Could not resolve a Meteora DLMM pool from that input.",
      "Send a position address, a pool address, a Meteora link, or `/pos <pool> <wallet>`.",
    ];
  }

  const pool = target.poolDetail ?? (await fetchPool(target.pool));
  if (!pool) return [`Pool ${target.pool} not found on Meteora DLMM.`];

  const sections: string[] = [buildPoolHealth(pool).join("\n")];

  if (target.owner) {
    try {
      const open = await fetchPositions(pool.address, target.owner, "open");
      const closed = await fetchPositions(pool.address, target.owner, "closed");
      const all = [...open, ...closed];
      const mine =
        (target.position && all.find((p) => p.positionAddress === target.position)) ??
        open[0] ??
        closed[0];
      if (mine) {
        sections.push(buildUserReport(pool, mine, now).lines.join("\n"));
      } else {
        sections.push(`No positions found for ${short(target.owner)} in ${pool.name}.`);
      }
    } catch (err) {
      sections.push(`Could not load your position: ${(err as Error).message}`);
    }
  }

  sections.push((await buildTopWallets(pool.address, options, now)).join("\n"));
  return sections;
}
