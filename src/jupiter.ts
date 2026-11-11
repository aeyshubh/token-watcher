const MAIN_HOST = "https://api.jup.ag/swap/v1";
const LITE_HOST = "https://lite-api.jup.ag/swap/v1";
const MAX_ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 20000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function host(): string {
  return process.env.JUPITER_API_KEY?.trim() ? MAIN_HOST : LITE_HOST;
}

function headers(): Record<string, string> {
  const key = process.env.JUPITER_API_KEY?.trim();
  return {
    "Content-Type": "application/json",
    ...(key ? { "x-api-key": key } : {}),
  };
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  let lastError: Error = new Error(`Jupiter request failed: ${path}`);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(`${host()}${path}`, {
        ...init,
        headers: { ...headers(), ...(init.headers as Record<string, string> | undefined) },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (res.ok) return (await res.json()) as T;

      const body = await res.text().catch(() => "");
      const message = `Jupiter HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`;
      lastError = new Error(message);

      if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const waitMs =
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : attempt * 1500;
        await sleep(waitMs);
        continue;
      }
      throw lastError;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_ATTEMPTS) await sleep(attempt * 1200);
    }
  }

  throw lastError;
}

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct?: string;
  routePlan?: unknown[];
  [key: string]: unknown;
}

export interface JupiterSwapResult {
  swapTransaction: string;
  lastValidBlockHeight: number;
  [key: string]: unknown;
}

export async function getQuote(params: {
  inputMint: string;
  outputMint: string;
  amount: bigint | string | number;
  slippageBps: number;
}): Promise<JupiterQuote> {
  const query = new URLSearchParams({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: String(params.amount),
    slippageBps: String(params.slippageBps),
    restrictIntermediateTokens: "true",
  });
  return request<JupiterQuote>(`/quote?${query.toString()}`, { method: "GET" });
}

export async function getSwapTransaction(params: {
  quote: JupiterQuote;
  userPublicKey: string;
  priorityFeeCapLamports: number;
}): Promise<JupiterSwapResult> {
  const body: Record<string, unknown> = {
    quoteResponse: params.quote,
    userPublicKey: params.userPublicKey,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    // Let Jupiter size the swap, but never exceed our lamport cap.
    prioritizationFeeLamports: {
      priorityLevelWithMaxLamports: {
        maxLamports: Math.max(0, params.priorityFeeCapLamports),
        priorityLevel: "high",
      },
    },
  };

  return request<JupiterSwapResult>("/swap", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
