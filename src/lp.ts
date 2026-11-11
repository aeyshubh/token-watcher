import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  fetchOpenPortfolio,
  fetchPositions,
  type OpenPortfolioPool,
  type PositionPnl,
} from "./meteora";
import { setMeteoraMaxRps } from "./meteora-rate";
import { formatPrice, formatUsd } from "./format";
import { sendMessage } from "./telegram";
import { isBase58 } from "./solana";
import { loadLpState, saveLpState, type LpState } from "./lp-state";
import { loadSettings, requireTelegramChatId } from "./settings";

export const LP_WALLETS_PATH = resolve(process.cwd(), "config/lp-wallets.json");
export const LP_TARGETS_PATH = resolve(process.cwd(), "config/lp-targets.json");

export interface LpWallet {
  address: string;
  label: string;
  tpPct?: number;
  slPct?: number;
}

export interface LpTarget {
  tpPct?: number;
  slPct?: number;
}

export interface LpConfig {
  botToken: string;
  chatId: string;
  intervalMs: number;
  maxRps: number;
  defaultTpPct: number;
  defaultSlPct: number;
  alertCooldownMs: number;
  oorCooldownMs: number;
  minPositionUsd: number;
  nearRangeWidthPct: number;
  wallets: LpWallet[];
  targets: Record<string, LpTarget>;
}

export interface LpSnapshotEntry {
  number: number;
  position: string;
  pool: string;
  poolName: string;
  wallet: string;
  walletLabel: string;
  pnlPct: number | null;
  pnlUsd: number | null;
  balances: number | null;
  deposit: number | null;
  fees: number | null;
  unclaimedFeesUsd: number | null;
  isOutOfRange: boolean | null;
  lowerBinId: number | null;
  upperBinId: number | null;
  minPrice: number | null;
  maxPrice: number | null;
  activePrice: number | null;
  createdAt: number | null;
  feePerTvl24h: number | null;
  tpPct: number;
  slPct: number;
  lastSeen: string;
}

export type LpEventType = "tp" | "sl" | "oor" | "near";

export interface LpEvent {
  type: LpEventType;
  position: string;
  pool: string;
  text: string;
}

export interface LpTickResult {
  snapshot: LpSnapshotEntry[];
  events: LpEvent[];
  errors: string[];
}

export interface LpTrackerHandle {
  stop: () => void;
  snapshot: () => LpSnapshotEntry[];
  reload: () => void;
  setTarget: (position: string, target: LpTarget) => void;
  clearTarget: (position: string) => boolean;
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

function num(value: string | number | null | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function numberOrNull(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function optionalPct(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return n;
}

function short(address: string): string {
  return address.length <= 10 ? address : `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function formatPct(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function poolName(pool: OpenPortfolioPool): string {
  const x = pool.tokenX?.trim();
  const y = pool.tokenY?.trim();
  return x && y ? `${x}-${y}` : short(pool.poolAddress);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Failed to read ${path}: ${(err as Error).message}`);
  }
}

export function readLpWallets(path: string = LP_WALLETS_PATH): LpWallet[] {
  if (!existsSync(path)) return [];
  const parsed = readJson(path);
  if (!Array.isArray(parsed)) {
    throw new Error(`${path} must be a JSON array`);
  }

  const wallets: LpWallet[] = [];
  const seen = new Set<string>();
  parsed.forEach((raw, index) => {
    let address: string;
    let label: string;
    let tpPct: number | undefined;
    let slPct: number | undefined;

    if (typeof raw === "string") {
      address = raw.trim();
      label = short(address);
    } else if (raw && typeof raw === "object") {
      const item = raw as Record<string, unknown>;
      address = typeof item.address === "string" ? item.address.trim() : "";
      label =
        typeof item.label === "string" && item.label.trim() ? item.label.trim() : short(address);
      tpPct = optionalPct(item.tpPct, `${path}[${index}].tpPct`);
      slPct = optionalPct(item.slPct, `${path}[${index}].slPct`);
    } else {
      throw new Error(`${path}[${index}] must be a wallet address or { address, label } object`);
    }

    if (!isBase58(address)) {
      throw new Error(`${path}[${index}] must be a valid base58 Solana wallet address`);
    }
    if (seen.has(address)) return;
    seen.add(address);
    wallets.push({ address, label, tpPct, slPct });
  });

  return wallets;
}

export function readLpTargets(path: string = LP_TARGETS_PATH): Record<string, LpTarget> {
  if (!existsSync(path)) return {};
  const parsed = readJson(path);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must be a JSON object keyed by position address`);
  }

  const targets: Record<string, LpTarget> = {};
  for (const [position, raw] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isBase58(position)) {
      throw new Error(`${path}: "${position}" is not a valid base58 position address`);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`${path}.${position} must be an object with tpPct / slPct`);
    }

    const item = raw as Record<string, unknown>;
    const target: LpTarget = {};
    for (const key of ["tpPct", "slPct"] as const) {
      if (item[key] === undefined) continue;
      const value = Number(item[key]);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`${path}.${position}.${key} must be a non-negative number`);
      }
      target[key] = value;
    }
    targets[position] = target;
  }
  return targets;
}

function writeLpTargets(targets: Record<string, LpTarget>): void {
  mkdirSync(dirname(LP_TARGETS_PATH), { recursive: true });
  writeFileSync(LP_TARGETS_PATH, `${JSON.stringify(targets, null, 2)}\n`, "utf8");
}

export function setLpTarget(position: string, target: LpTarget): void {
  if (!isBase58(position)) throw new Error("Position must be a valid base58 address");
  const targets = readLpTargets();
  targets[position] = { ...targets[position], ...target };
  writeLpTargets(targets);
}

export function clearLpTarget(position: string): boolean {
  const targets = readLpTargets();
  if (!(position in targets)) return false;
  delete targets[position];
  writeLpTargets(targets);
  return true;
}

export function loadLpConfig(
  overrides: Partial<Pick<LpConfig, "botToken" | "chatId">> = {},
): LpConfig {
  const settings = loadSettings();
  const maxRps = settings.lp.maxRps;
  setMeteoraMaxRps(maxRps);

  return {
    botToken: overrides.botToken ?? required("TELEGRAM_BOT_TOKEN"),
    chatId: overrides.chatId ?? requireTelegramChatId(),
    intervalMs: settings.lp.intervalMs,
    maxRps,
    defaultTpPct: settings.lp.defaultTpPct,
    defaultSlPct: settings.lp.defaultSlPct,
    alertCooldownMs: settings.lp.alertCooldownMs,
    oorCooldownMs: settings.lp.oorCooldownMs,
    minPositionUsd: settings.lp.minPositionUsd,
    nearRangeWidthPct: settings.lp.nearRangeWidthPct,
    wallets: readLpWallets(),
    targets: readLpTargets(),
  };
}

interface DetectedPosition {
  position: string;
  pool: string;
  wallet: LpWallet;
  poolName: string;
}

async function detectPositions(
  config: LpConfig,
): Promise<{ detected: Map<string, DetectedPosition>; complete: boolean; errors: string[] }> {
  const detected = new Map<string, DetectedPosition>();
  const errors: string[] = [];
  let complete = true;

  for (const wallet of config.wallets) {
    try {
      const portfolio = await fetchOpenPortfolio(wallet.address);
      for (const pool of portfolio.pools) {
        for (const position of pool.listPositions ?? []) {
          detected.set(position, {
            position,
            pool: pool.poolAddress,
            wallet,
            poolName: poolName(pool),
          });
        }
      }
    } catch (err) {
      complete = false;
      errors.push(`detect ${wallet.label}: ${(err as Error).message}`);
    }
  }

  return { detected, complete, errors };
}

function compareDetected(a: DetectedPosition, b: DetectedPosition): number {
  if (a.wallet.label !== b.wallet.label) return a.wallet.label.localeCompare(b.wallet.label);
  if (a.poolName !== b.poolName) return a.poolName.localeCompare(b.poolName);
  return a.position.localeCompare(b.position);
}

interface RangeState {
  outOfRange: boolean;
  above: boolean;
  below: boolean;
}

function rangeState(position: PositionPnl): RangeState {
  const price = num(position.poolActivePrice);
  const min = num(position.minPrice);
  const max = num(position.maxPrice);
  const above = price > 0 && max > 0 && price > max;
  const below = price > 0 && min > 0 && price < min;
  const outOfRange =
    typeof position.isOutOfRange === "boolean" ? position.isOutOfRange : above || below;
  return { outOfRange, above, below };
}

function rangeLabel(range: RangeState): string {
  if (range.above) return "price above range (100% quote)";
  if (range.below) return "price below range (100% base)";
  return "out of range";
}

/**
 * Which range edge the active price is close to, if any. Proximity is measured
 * as a fraction of the total range width (`widthPct` percent from an edge).
 * Returns null when out of range, disabled, or still comfortably mid-range.
 */
function nearSideOf(
  position: PositionPnl,
  range: RangeState,
  widthPct: number,
): "upper" | "lower" | null {
  if (widthPct <= 0 || range.outOfRange) return null;
  const min = num(position.minPrice);
  const max = num(position.maxPrice);
  const price = num(position.poolActivePrice);
  if (!(max > min) || !(price > 0)) return null;

  const width = max - min;
  const upper = (max - price) / width;
  const lower = (price - min) / width;
  if (upper < 0 || lower < 0) return null;

  const threshold = widthPct / 100;
  if (upper > threshold && lower > threshold) return null;
  return upper <= lower ? "upper" : "lower";
}

function buildEventText(
  type: LpEventType,
  detected: DetectedPosition,
  position: PositionPnl,
  tpPct: number,
  slPct: number,
  nearSide: "upper" | "lower" | null = null,
): string {
  const pnlPct = num(position.pnlPctChange);
  const pnlUsd = num(position.pnlUsd);
  const balances = num(position.unrealizedPnl?.balances);
  const deposit = num(position.allTimeDeposits.total.usd);
  const fees = num(position.allTimeFees.total.usd);
  const range = rangeState(position);

  const title =
    type === "tp"
      ? "🎯 LP TAKE PROFIT"
      : type === "sl"
        ? "🛑 LP STOP LOSS"
        : type === "near"
          ? "⚠️ LP NEAR RANGE EDGE"
          : "⚠️ LP OUT OF RANGE";

  const lines = [
    title,
    `${detected.poolName} · ${detected.wallet.label}`,
    `PnL ${formatPct(pnlPct)} (${formatUsd(pnlUsd)})`,
    `Bal ${formatUsd(balances)} · deposit ${formatUsd(deposit)} · fees ${formatUsd(fees)}`,
  ];

  if (type === "oor") lines.push(rangeLabel(range));
  if (type === "near" && nearSide) {
    const min = num(position.minPrice);
    const max = num(position.maxPrice);
    const price = num(position.poolActivePrice);
    const width = max - min;
    if (width > 0) {
      const pct =
        nearSide === "upper" ? ((max - price) / width) * 100 : ((price - min) / width) * 100;
      lines.push(`Price within ${pct.toFixed(1)}% of range width from the ${nearSide} edge`);
      lines.push(`Range ${formatPrice(min)}–${formatPrice(max)} · now ${formatPrice(price)}`);
    }
  }
  lines.push(`Thresholds TP +${tpPct}% / SL -${slPct}%`);
  lines.push(`https://www.meteora.ag/dlmm/${detected.pool}`);
  return lines.join("\n");
}

function formatAge(createdAt: number): string {
  const seconds = Date.now() / 1000 - createdAt;
  if (!Number.isFinite(seconds) || seconds <= 0) return "n/a";
  const hours = seconds / 3600;
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function rangeStatusLabel(row: LpSnapshotEntry): string {
  if (row.isOutOfRange === null) return "UNKNOWN";
  if (!row.isOutOfRange) return "IN range";
  if (row.activePrice !== null && row.minPrice !== null && row.activePrice < row.minPrice) {
    return "OUT of range · below range (100% base)";
  }
  if (row.activePrice !== null && row.maxPrice !== null && row.activePrice > row.maxPrice) {
    return "OUT of range · above range (100% quote)";
  }
  return "OUT of range";
}

function thresholdLabel(row: LpSnapshotEntry): string {
  const parts: string[] = [];

  if (row.tpPct > 0) {
    if (row.pnlPct === null) parts.push(`TP +${row.tpPct}%`);
    else if (row.pnlPct >= row.tpPct) parts.push(`TP +${row.tpPct}% (breached)`);
    else parts.push(`TP +${row.tpPct}% (${(row.tpPct - row.pnlPct).toFixed(2)} pts away)`);
  } else {
    parts.push("TP off");
  }

  if (row.slPct > 0) {
    if (row.pnlPct === null) parts.push(`SL -${row.slPct}%`);
    else if (row.pnlPct <= -row.slPct) parts.push(`SL -${row.slPct}% (breached)`);
    else parts.push(`SL -${row.slPct}% (${(row.pnlPct + row.slPct).toFixed(2)} pts away)`);
  } else {
    parts.push("SL off");
  }

  return parts.join(" · ");
}

export function formatPositionStatus(row: LpSnapshotEntry): string {
  const pnl = row.pnlPct === null ? "n/a" : formatPct(row.pnlPct);
  const pnlUsd = row.pnlUsd === null ? "n/a" : formatUsd(row.pnlUsd);
  const feeTvl = row.feePerTvl24h === null ? "n/a" : `${row.feePerTvl24h.toFixed(2)}%`;
  const age = row.createdAt === null ? "n/a" : formatAge(row.createdAt);

  const lines = [
    `#${row.number} · ${row.poolName} · ${row.walletLabel}`,
    `Status: ${rangeStatusLabel(row)}`,
    `PnL: ${pnl} (${pnlUsd})`,
    `Bal: ${formatUsd(row.balances)} · Deposit: ${formatUsd(row.deposit)} · ` +
      `Fees: ${formatUsd(row.fees)} · Unclaimed: ${formatUsd(row.unclaimedFeesUsd)}`,
  ];

  if (row.lowerBinId !== null && row.upperBinId !== null) {
    lines.push(`Bins: ${row.lowerBinId}…${row.upperBinId}`);
  }

  if (row.minPrice !== null && row.maxPrice !== null) {
    const active = row.activePrice === null ? "n/a" : formatPrice(row.activePrice);
    lines.push(
      `Range price: ${formatPrice(row.minPrice)}–${formatPrice(row.maxPrice)} · now ${active}`,
    );
  }

  lines.push(`Age: ${age} · Fee/TVL 24h: ${feeTvl}`);
  lines.push(thresholdLabel(row));
  lines.push(`https://www.meteora.ag/dlmm/${row.pool}`);
  return lines.join("\n");
}

function cooldownDue(last: string | undefined, cooldownMs: number): boolean {
  if (!last) return true;
  if (cooldownMs <= 0) return true;
  const at = new Date(last).getTime();
  return !Number.isFinite(at) || Date.now() - at >= cooldownMs;
}

export async function trackOnce(
  config: LpConfig,
  state: LpState,
  saveState: (state: LpState) => void = saveLpState,
  options: { send?: boolean } = {},
): Promise<LpTickResult> {
  const send = options.send !== false;
  const errors: string[] = [];
  const events: LpEvent[] = [];
  const snapshot: LpSnapshotEntry[] = [];

  if (config.wallets.length === 0) {
    return { snapshot, events, errors };
  }

  const { detected, complete, errors: detectErrors } = await detectPositions(config);
  errors.push(...detectErrors);

  if (complete) {
    const configuredWallets = new Set(config.wallets.map((wallet) => wallet.address));
    for (const [positionAddress, entry] of Object.entries(state)) {
      if (!detected.has(positionAddress) || !configuredWallets.has(entry.wallet)) {
        delete state[positionAddress];
      }
    }
  }

  const groups = new Map<string, { pool: string; wallet: LpWallet; items: DetectedPosition[] }>();
  for (const item of detected.values()) {
    const key = `${item.pool}::${item.wallet.address}`;
    const group = groups.get(key);
    if (group) group.items.push(item);
    else groups.set(key, { pool: item.pool, wallet: item.wallet, items: [item] });
  }

  const pnlByPosition = new Map<string, PositionPnl>();
  for (const group of groups.values()) {
    try {
      const positions = await fetchPositions(group.pool, group.wallet.address, "open");
      for (const position of positions) pnlByPosition.set(position.positionAddress, position);
    } catch (err) {
      errors.push(`positions ${group.wallet.label}/${short(group.pool)}: ${(err as Error).message}`);
    }
  }

  const ordered = [...detected.values()].sort(compareDetected);
  const usedNumbers = new Set<number>();
  for (const entry of Object.values(state)) {
    if (typeof entry.number === "number" && Number.isInteger(entry.number) && entry.number > 0) {
      usedNumbers.add(entry.number);
    }
  }
  const allocateNumber = (): number => {
    let next = 1;
    while (usedNumbers.has(next)) next += 1;
    usedNumbers.add(next);
    return next;
  };

  const nowIso = new Date().toISOString();

  for (const detectedItem of ordered) {
    const { position: positionAddress, wallet } = detectedItem;
    const override = config.targets[positionAddress];
    const tpPct = override?.tpPct ?? wallet.tpPct ?? config.defaultTpPct;
    const slPct = override?.slPct ?? wallet.slPct ?? config.defaultSlPct;

    let entry = state[positionAddress];
    const isNew = !entry;
    if (!entry) {
      entry = {
        number: allocateNumber(),
        pool: detectedItem.pool,
        wallet: wallet.address,
        firstSeen: nowIso,
        lastSeen: nowIso,
        isOutOfRange: null,
        alerts: {},
      };
      state[positionAddress] = entry;
    } else if (
      typeof entry.number !== "number" ||
      !Number.isInteger(entry.number) ||
      entry.number <= 0
    ) {
      entry.number = allocateNumber();
    }

    entry.pool = detectedItem.pool;
    entry.wallet = wallet.address;
    entry.lastSeen = nowIso;

    const pnl = pnlByPosition.get(positionAddress);

    if (!pnl) {
      snapshot.push({
        number: entry.number ?? 0,
        position: positionAddress,
        pool: detectedItem.pool,
        poolName: detectedItem.poolName,
        wallet: wallet.address,
        walletLabel: wallet.label,
        pnlPct: entry.lastPnlPct ?? null,
        pnlUsd: entry.lastPnlUsd ?? null,
        balances: entry.balances ?? null,
        deposit: entry.deposit ?? null,
        fees: null,
        unclaimedFeesUsd: null,
        isOutOfRange: entry.isOutOfRange ?? null,
        lowerBinId: null,
        upperBinId: null,
        minPrice: null,
        maxPrice: null,
        activePrice: null,
        createdAt: null,
        feePerTvl24h: null,
        tpPct,
        slPct,
        lastSeen: entry.lastSeen,
      });
      continue;
    }

    const pnlPct = num(pnl.pnlPctChange);
    const pnlUsd = num(pnl.pnlUsd);
    const balances = num(pnl.unrealizedPnl?.balances);
    const deposit = num(pnl.allTimeDeposits.total.usd);
    const fees = num(pnl.allTimeFees.total.usd);
    const unclaimedFeesUsd = pnl.unrealizedPnl
      ? num(pnl.unrealizedPnl.unclaimedFeeTokenX.usd) +
        num(pnl.unrealizedPnl.unclaimedFeeTokenY.usd)
      : null;
    const range = rangeState(pnl);

    const wasOutOfRange = entry.isOutOfRange === true;
    entry.lastPnlPct = pnlPct;
    entry.lastPnlUsd = pnlUsd;
    entry.balances = balances;
    entry.deposit = deposit;
    entry.isOutOfRange = range.outOfRange;

    snapshot.push({
      number: entry.number ?? 0,
      position: positionAddress,
      pool: detectedItem.pool,
      poolName: detectedItem.poolName,
      wallet: wallet.address,
      walletLabel: wallet.label,
      pnlPct,
      pnlUsd,
      balances,
      deposit,
      fees,
      unclaimedFeesUsd,
      isOutOfRange: range.outOfRange,
      lowerBinId: pnl.lowerBinId,
      upperBinId: pnl.upperBinId,
      minPrice: numberOrNull(pnl.minPrice),
      maxPrice: numberOrNull(pnl.maxPrice),
      activePrice: numberOrNull(pnl.poolActivePrice),
      createdAt: pnl.createdAt ?? null,
      feePerTvl24h: numberOrNull(pnl.feePerTvl24h),
      tpPct,
      slPct,
      lastSeen: entry.lastSeen,
    });

    const isDust = pnl.unrealizedPnl != null && balances < config.minPositionUsd;
    if (isDust) continue;

    const detectedNearSide = nearSideOf(pnl, range, config.nearRangeWidthPct);
    const previousNearSide = entry.nearSide ?? null;
    entry.nearSide = detectedNearSide;

    const triggered: LpEventType[] = [];
    if (tpPct > 0 && pnlPct >= tpPct) triggered.push("tp");
    if (slPct > 0 && pnlPct <= -slPct) triggered.push("sl");
    if (!isNew && !wasOutOfRange && range.outOfRange) triggered.push("oor");
    if (
      detectedNearSide &&
      (detectedNearSide !== previousNearSide ||
        cooldownDue(entry.alerts?.near, config.oorCooldownMs))
    ) {
      triggered.push("near");
    }

    for (const type of triggered) {
      const text = buildEventText(
        type,
        detectedItem,
        pnl,
        tpPct,
        slPct,
        type === "near" ? detectedNearSide : null,
      );
      const event: LpEvent = {
        type,
        position: positionAddress,
        pool: detectedItem.pool,
        text,
      };

      if (!send) {
        events.push(event);
        continue;
      }

      entry.alerts = entry.alerts ?? {};
      const last = entry.alerts[type];
      const cooldown =
        type === "oor" || type === "near" ? config.oorCooldownMs : config.alertCooldownMs;
      if (!cooldownDue(last, cooldown)) continue;

      try {
        await sendMessage(config.botToken, config.chatId, text);
        entry.alerts[type] = new Date().toISOString();
        events.push(event);
        saveState(state);
        log(
          `${type.toUpperCase()} alert sent · ${detectedItem.poolName} · ` +
            `${wallet.label} · ${short(positionAddress)}`,
        );
      } catch (err) {
        const message = `telegram ${type} ${short(positionAddress)}: ${(err as Error).message}`;
        errors.push(message);
        log(message);
      }
    }
  }

  saveState(state);

  snapshot.sort((a, b) => a.number - b.number);

  return { snapshot, events, errors };
}

export function startLpTracker(
  config: LpConfig,
  options: {
    state?: LpState;
    saveState?: (state: LpState) => void;
    onTick?: (snapshot: LpSnapshotEntry[]) => void;
  } = {},
): LpTrackerHandle {
  let currentConfig = config;
  const state = options.state ?? loadLpState();
  const saveState = options.saveState ?? saveLpState;
  let snapshot: LpSnapshotEntry[] = [];
  let running = true;
  let timer: NodeJS.Timeout | undefined;

  log(
    `LP tracker started · interval=${config.intervalMs}ms · wallets=${config.wallets.length} · ` +
      `defaults TP +${config.defaultTpPct}% / SL -${config.defaultSlPct}% · ` +
      `max ${config.maxRps} RPS · cooldown ${Math.round(config.alertCooldownMs / 1000)}s`,
  );

  const loop = async (): Promise<void> => {
    const started = Date.now();
    try {
      const result = await trackOnce(currentConfig, state, saveState, { send: true });
      snapshot = result.snapshot;
      for (const error of result.errors) log(`lp: ${error}`);
      if (options.onTick) {
        try {
          options.onTick(result.snapshot);
        } catch (err) {
          log(`lp onTick error: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      log(`lp tick error: ${(err as Error).message}`);
    }

    if (!running) return;
    timer = setTimeout(loop, Math.max(0, currentConfig.intervalMs - (Date.now() - started)));
  };

  void loop();

  return {
    stop: () => {
      running = false;
      if (timer) clearTimeout(timer);
    },
    snapshot: () => snapshot.map((entry) => ({ ...entry })),
    reload: () => {
      currentConfig = {
        ...currentConfig,
        wallets: readLpWallets(),
        targets: readLpTargets(),
      };
      log(
        `LP tracker reloaded · wallets=${currentConfig.wallets.length} · ` +
          `overrides=${Object.keys(currentConfig.targets).length}`,
      );
    },
    setTarget: (position, target) => {
      setLpTarget(position, target);
      currentConfig = { ...currentConfig, targets: readLpTargets() };
    },
    clearTarget: (position) => {
      const removed = clearLpTarget(position);
      currentConfig = { ...currentConfig, targets: readLpTargets() };
      return removed;
    },
  };
}
