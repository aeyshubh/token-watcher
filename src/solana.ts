const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ALPHABET_MAP = new Map<string, number>();
for (let i = 0; i < ALPHABET.length; i += 1) ALPHABET_MAP.set(ALPHABET[i], i);

export const DLMM_PROGRAM_ID = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
export const POSITION_V2_SIZE = 8120;
export const POSITION_V2_DISCRIMINATOR = [117, 176, 212, 199, 245, 180, 133, 182];
const LIQUIDITY_SHARES = 70;

const MAX_ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 30000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isBase58(value: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

export function base58Decode(input: string): Uint8Array {
  if (!input) return new Uint8Array(0);
  const bytes: number[] = [0];
  for (const ch of input) {
    const value = ALPHABET_MAP.get(ch);
    if (value === undefined) throw new Error(`Invalid base58 character "${ch}"`);
    let carry = value;
    for (let i = 0; i < bytes.length; i += 1) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < input.length && input[i] === "1"; i += 1) bytes.push(0);
  return Uint8Array.from(bytes.reverse());
}

export function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  const digits: number[] = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = "";
  for (const byte of bytes) {
    if (byte === 0) out += "1";
    else break;
  }
  for (let i = digits.length - 1; i >= 0; i -= 1) out += ALPHABET[digits[i]];
  return out;
}

export interface RpcAccount {
  owner: string;
  data: Buffer;
}

interface RpcError {
  code?: number;
  message?: string;
}

async function rpcCall<T>(
  rpcUrl: string,
  method: string,
  params: unknown[],
): Promise<T | null> {
  let lastError: Error = new Error(`RPC ${method} failed`);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      const json = (await res.json()) as { result?: T; error?: RpcError };
      if (json.result !== undefined) return json.result;

      const message = json.error?.message ?? `HTTP ${res.status}`;
      // Method disabled / rate-limited / node busy -> retry a couple of times.
      lastError = new Error(message);
      if (/rate|429|busy|disabled|too many/i.test(message) && attempt < MAX_ATTEMPTS) {
        await sleep(attempt * 1200);
        continue;
      }
      return null;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_ATTEMPTS) await sleep(attempt * 1200);
    }
  }

  throw lastError;
}

export async function getAccountInfo(
  rpcUrl: string,
  address: string,
): Promise<RpcAccount | null> {
  const result = await rpcCall<{ value: { owner: string; data: [string, string] } | null }>(
    rpcUrl,
    "getAccountInfo",
    [address, { encoding: "base64" }],
  );
  if (!result?.value) return null;
  return {
    owner: result.value.owner,
    data: Buffer.from(result.value.data[0], "base64"),
  };
}

interface RawProgramAccount {
  pubkey: string;
  account: { owner: string; data: [string, string] };
}

export interface PositionAccount {
  positionAddress: string;
  owner: string;
  pool: string;
  lowerBinId: number;
  upperBinId: number;
  liquidity: bigint;
}

function readU128LE(buf: Buffer, offset: number): bigint {
  const low = buf.readBigUInt64LE(offset);
  const high = buf.readBigUInt64LE(offset + 8);
  return (high << 64n) | low;
}

/**
 * Decode a PositionV2 account. `baseOffset` is the byte where `lb_pair` starts
 * (8 for a full account, 0 when the data slice already starts at lb_pair).
 */
export function decodePositionV2(data: Buffer, baseOffset: number): Omit<PositionAccount, "positionAddress"> {
  const lbPair = base58Encode(data.subarray(baseOffset, baseOffset + 32));
  const owner = base58Encode(data.subarray(baseOffset + 32, baseOffset + 64));
  const sharesOffset = baseOffset + 64;
  let liquidity = 0n;
  for (let i = 0; i < LIQUIDITY_SHARES; i += 1) {
    liquidity += readU128LE(data, sharesOffset + i * 16);
  }
  const lowerBinId = data.readInt32LE(sharesOffset + LIQUIDITY_SHARES * 16);
  const upperBinId = data.readInt32LE(sharesOffset + LIQUIDITY_SHARES * 16 + 4);
  return { owner, pool: lbPair, lowerBinId, upperBinId, liquidity };
}

export function isPositionV2(data: Buffer): boolean {
  if (data.length < POSITION_V2_SIZE) return false;
  for (let i = 0; i < POSITION_V2_DISCRIMINATOR.length; i += 1) {
    if (data[i] !== POSITION_V2_DISCRIMINATOR[i]) return false;
  }
  return true;
}

/** Decode a full PositionV2 account fetched via getAccountInfo. */
export function decodeFullPosition(data: Buffer): Omit<PositionAccount, "positionAddress"> {
  return decodePositionV2(data, 8);
}

export interface PoolLp {
  owner: string;
  liquidity: bigint;
  lowerBinId: number;
  upperBinId: number;
}

/**
 * Enumerate every PositionV2 account for a pool and return the distinct owners
 * with their total liquidity, sorted largest-first.
 */
export async function fetchPoolLps(
  rpcUrl: string,
  pool: string,
  maxOwners = 1200,
): Promise<PoolLp[]> {
  const result = await rpcCall<RawProgramAccount[]>(rpcUrl, "getProgramAccounts", [
    DLMM_PROGRAM_ID,
    {
      encoding: "base64",
      filters: [
        { dataSize: POSITION_V2_SIZE },
        { memcmp: { offset: 8, bytes: pool } },
      ],
      dataSlice: { offset: 8, length: 1192 },
    },
  ]);
  if (!result) return [];

  const byOwner = new Map<string, PoolLp>();
  for (const account of result) {
    const data = Buffer.from(account.account.data[0], "base64");
    if (data.length < 1192) continue;
    let decoded: Omit<PositionAccount, "positionAddress">;
    try {
      decoded = decodePositionV2(data, 0);
    } catch {
      continue;
    }
    if (!decoded.owner || decoded.owner === "11111111111111111111111111111111") continue;
    const existing = byOwner.get(decoded.owner);
    if (existing) {
      existing.liquidity += decoded.liquidity;
      existing.lowerBinId = Math.min(existing.lowerBinId, decoded.lowerBinId);
      existing.upperBinId = Math.max(existing.upperBinId, decoded.upperBinId);
    } else {
      byOwner.set(decoded.owner, {
        owner: decoded.owner,
        liquidity: decoded.liquidity,
        lowerBinId: decoded.lowerBinId,
        upperBinId: decoded.upperBinId,
      });
    }
  }

  return [...byOwner.values()]
    .sort((a, b) => (a.liquidity === b.liquidity ? 0 : a.liquidity > b.liquidity ? -1 : 1))
    .slice(0, maxOwners);
}

/** Run an async mapper over items with bounded concurrency. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
