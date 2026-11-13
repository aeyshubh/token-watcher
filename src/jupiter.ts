const BUILD_HOST = "https://api.jup.ag/swap/v2";
const TX_HOST = "https://tx.jup.ag";
const MAX_ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 20000;
export const JUPITER_TIP_LAMPORTS = 1_000_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jupiterApiKey(): string {
  const key = process.env.JUPITER_API_KEY?.trim();
  if (!key) throw new Error("Missing required environment variable: JUPITER_API_KEY");
  return key;
}

function headers(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-api-key": jupiterApiKey(),
  };
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  let lastError: Error = new Error(`Jupiter request failed: ${path}`);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(`${BUILD_HOST}${path}`, {
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

export interface ApiAccount {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

export interface ApiInstruction {
  programId: string;
  accounts: ApiAccount[];
  data: string;
}

export interface JupiterBuildRouteSwapInfo {
  ammKey: string;
  label: string;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
}

export interface JupiterBuildRoute {
  percent: number;
  bps: number;
  swapInfo: JupiterBuildRouteSwapInfo;
}

export interface JupiterBuildBlockhash {
  blockhash: number[];
  lastValidBlockHeight: number;
}

export interface JupiterBuildResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct?: string | null;
  routePlan?: JupiterBuildRoute[];
  computeBudgetInstructions: ApiInstruction[];
  setupInstructions: ApiInstruction[];
  swapInstruction: ApiInstruction;
  cleanupInstruction: ApiInstruction | null;
  otherInstructions: ApiInstruction[];
  tipInstruction: ApiInstruction | null;
  addressesByLookupTableAddress: Record<string, string[]> | null;
  blockhashWithMetadata: JupiterBuildBlockhash;
  transactionVersion?: number;
  [key: string]: unknown;
}

export const JUPITER_TX_HOST = TX_HOST;

export async function getSwapBuild(params: {
  inputMint: string;
  outputMint: string;
  amount: bigint | string | number;
  slippageBps: number;
  taker: string;
}): Promise<JupiterBuildResponse> {
  const amount = String(params.amount);
  if (!/^\d+$/.test(amount)) {
    throw new Error(`Invalid Jupiter build amount "${params.amount}"`);
  }

  const query = new URLSearchParams({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount,
    slippageBps: String(params.slippageBps),
    transactionVersion: "0",
    wrapAndUnwrapSol: "true",
    computeUnitPricePercentile: "high",
    tipAmount: String(JUPITER_TIP_LAMPORTS),
    taker: params.taker,
  });

  const build = await request<JupiterBuildResponse>(`/build?${query.toString()}`, {
    method: "GET",
  });

  if (build.inputMint !== params.inputMint || build.outputMint !== params.outputMint) {
    throw new Error("Jupiter /build returned mismatched input/output mints");
  }

  if (!/^\d+$/.test(build.inAmount) || !/^\d+$/.test(build.outAmount)) {
    throw new Error("Jupiter /build returned invalid amounts");
  }

  const blockhash = build.blockhashWithMetadata.blockhash;
  if (
    !Array.isArray(blockhash) ||
    blockhash.length !== 32 ||
    blockhash.some((byte) => typeof byte !== "number" || byte < 0 || byte > 255)
  ) {
    throw new Error("Jupiter /build returned invalid blockhash");
  }

  if (!Number.isInteger(build.blockhashWithMetadata.lastValidBlockHeight)) {
    throw new Error("Jupiter /build returned invalid lastValidBlockHeight");
  }

  if (build.transactionVersion !== undefined && build.transactionVersion !== 0) {
    throw new Error(`Unsupported Jupiter build transaction version ${build.transactionVersion}`);
  }

  if (build.tipInstruction === null) {
    throw new Error("Jupiter /build did not include a tip instruction");
  }

  return build;
}
