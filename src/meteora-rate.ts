import { getSettings } from "./settings";

const DEFAULT_MAX_RPS = 20;
const HARD_MAX_RPS = 30;
const DEFAULT_BACKOFF_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let maxRps = DEFAULT_MAX_RPS;
let minIntervalMs = 1000 / maxRps;
let explicitConfig = false;
let blockedUntil = 0;
let lastRequestAt = 0;
let queue: Promise<void> = Promise.resolve();

function refreshFromSettings(): void {
  if (explicitConfig) return;
  try {
    maxRps = Math.min(HARD_MAX_RPS, Math.max(1, getSettings().lp.maxRps));
    minIntervalMs = 1000 / maxRps;
  } catch {
    // Keep the safe default when config/app.json is missing or invalid.
  }
}

export function setMeteoraMaxRps(rps: number): void {
  if (!Number.isFinite(rps) || rps <= 0) return;
  explicitConfig = true;
  maxRps = Math.min(HARD_MAX_RPS, Math.max(1, rps));
  minIntervalMs = 1000 / maxRps;
}

export class MeteoraRateLimitError extends Error {
  constructor(public readonly resetAt: number) {
    super(`Meteora rate-limited until ${new Date(resetAt).toISOString()}`);
  }
}

function assertNotBlocked(): void {
  if (Date.now() < blockedUntil) throw new MeteoraRateLimitError(blockedUntil);
}

/**
 * Process-wide throttle shared by the LP tracker.
 * Requests are serialized and spaced by `1000 / maxRps` ms.
 */
export function acquireMeteoraSlot(): Promise<void> {
  refreshFromSettings();
  const interval = minIntervalMs;
  const turn = queue.then(async () => {
    assertNotBlocked();
    const wait = lastRequestAt + interval - Date.now();
    if (wait > 0) await sleep(wait);
    assertNotBlocked();
    lastRequestAt = Date.now();
  });
  queue = turn.catch(() => undefined);
  return turn;
}

/** Record a 429 and pause every queued Meteora call until the reset time. */
export async function markMeteoraRateLimited(res: Response): Promise<number> {
  const retryAfter = Number(res.headers.get("retry-after"));
  const resetAtSec = Number(res.headers.get("x-ratelimit-reset"));

  let resetAt: number;
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    resetAt = Date.now() + retryAfter * 1000 + 500;
  } else if (Number.isFinite(resetAtSec) && resetAtSec * 1000 > Date.now()) {
    resetAt = resetAtSec * 1000 + 500;
  } else {
    resetAt = Date.now() + DEFAULT_BACKOFF_MS;
  }

  blockedUntil = Math.max(blockedUntil, resetAt);
  return blockedUntil;
}

