import { randomUUID } from "node:crypto";
import type { TokenInfo } from "./types";

const HOST = "https://openapi.gmgn.ai";
const MAX_ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 15000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface GmgnResponse {
  code: number;
  message?: string;
  data?: {
    address: string;
    symbol: string;
    name: string;
    liquidity: string | number;
    price: { price: string };
  };
}

export async function getTokenInfo(
  apiKey: string,
  chain: string,
  address: string,
): Promise<TokenInfo> {
  let lastError: Error = new Error("GMGN request failed");

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
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

      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : attempt * 2000;
        throw new Error(`GMGN HTTP ${res.status} (retry in ${waitMs}ms)`);
      }

      const json = (await res.json()) as GmgnResponse;
      if (json.code !== 0 || !json.data) {
        throw new Error(`GMGN error code=${json.code}${json.message ? ` ${json.message}` : ""}`);
      }

      const price = Number(json.data.price?.price);
      if (!Number.isFinite(price) || price <= 0) {
        throw new Error("GMGN returned a non-numeric price");
      }

      return {
        address: json.data.address,
        symbol: json.data.symbol,
        name: json.data.name,
        price,
        liquidity: Number(json.data.liquidity),
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_ATTEMPTS) {
        await sleep(attempt * 2000);
      }
    }
  }

  throw lastError;
}
