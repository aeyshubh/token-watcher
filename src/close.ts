import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  closeAccount,
  getAccount,
  getAssociatedTokenAddress,
  NATIVE_MINT,
} from "@solana/spl-token";
import DLMM from "@meteora-ag/dlmm";
import BN from "bn.js";
import { base58Encode } from "./solana";
import {
  type ApiInstruction,
  getSwapBuild,
  type JupiterBuildResponse,
  JUPITER_TIP_LAMPORTS,
  JUPITER_TX_HOST,
} from "./jupiter";

const WSOL = NATIVE_MINT.toBase58();
const BPS_DENOMINATOR = 10_000;
const BASE_FEE_LAMPORTS = 5_000;
const COMPUTE_BUDGET_PROGRAM_BASE58 = "ComputeBudget111111111111111111111111111111";

export interface CloseSwapRecord {
  mint: string;
  inAmount: string;
  outAmount: string;
  minOutAmount: string | null;
  priceImpactPct: string | null;
  routeLabels: string[];
  signature: string;
}

export interface SkippedSwap {
  mint: string;
  amount: string;
  reason: string;
}

export interface CloseResult {
  positionClosed: boolean;
  signatures: string[];
  swaps: CloseSwapRecord[];
  skipped: SkippedSwap[];
  remaining: Array<{ mint: string; amount: string }>;
}

export interface CloseParams {
  connection: Connection;
  keypair: Keypair;
  pool: string;
  position: string;
  slippageBps: number;
  priorityFeeCapLamports: number;
  computeUnitLimit: number;
  log?: (message: string) => void;
}

async function computeBudgetInstructions(
  connection: Connection,
  capLamports: number,
  computeUnitLimit: number,
): Promise<TransactionInstruction[]> {
  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit })];
  if (capLamports <= 0) return instructions;

  let median = 0;
  try {
    const recent = await connection.getRecentPrioritizationFees();
    const prices = recent
      .map((fee) => fee.prioritizationFee)
      .filter((fee) => Number.isFinite(fee) && fee >= 0)
      .sort((a, b) => a - b);
    if (prices.length > 0) median = prices[Math.floor(prices.length / 2)];
  } catch {
    median = 0;
  }

  const maxUnitPrice = Math.floor((capLamports * 1_000_000) / Math.max(1, computeUnitLimit));
  const unitPrice = Math.max(0, Math.min(median, maxUnitPrice));
  if (unitPrice > 0) {
    instructions.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: unitPrice }));
  }
  return instructions;
}

async function buildLegacyTransaction(
  connection: Connection,
  keypair: Keypair,
  instructions: TransactionInstruction[],
  priorityFeeCapLamports: number,
  computeUnitLimit: number,
): Promise<{ tx: Transaction; blockhash: string; lastValidBlockHeight: number }> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction();
  tx.feePayer = keypair.publicKey;
  tx.recentBlockhash = blockhash;

  for (const ix of await computeBudgetInstructions(
    connection,
    priorityFeeCapLamports,
    computeUnitLimit,
  )) {
    tx.add(ix);
  }
  for (const ix of instructions) tx.add(ix);

  tx.sign(keypair);
  return { tx, blockhash, lastValidBlockHeight };
}

async function sendLegacy(
  connection: Connection,
  tx: Transaction,
  blockhash: string,
  lastValidBlockHeight: number,
): Promise<string> {
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 5,
  });
  await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  return signature;
}

function toInstruction(ix: ApiInstruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((acc) => ({
      pubkey: new PublicKey(acc.pubkey),
      isSigner: acc.isSigner,
      isWritable: acc.isWritable,
    })),
    data: Buffer.from(ix.data, "base64"),
  });
}

function transformAltAccounts(raw: Record<string, string[]> | null): AddressLookupTableAccount[] {
  if (!raw) return [];
  return Object.entries(raw).map(([key, addrs]) =>
    new AddressLookupTableAccount({
      key: new PublicKey(key),
      state: {
        deactivationSlot: BigInt("18446744073709551615"),
        lastExtendedSlot: 0,
        lastExtendedSlotStartIndex: 0,
        addresses: addrs.map((addr) => new PublicKey(addr)),
      },
    }),
  );
}

function clampComputeUnitPrice(
  instructions: ApiInstruction[],
  estimatedCU: number,
  capLamports: number,
): TransactionInstruction | null {
  if (capLamports <= 0) return null;
  const maxUnitPrice = Math.floor((capLamports * 1_000_000) / Math.max(1, estimatedCU));
  const computeBudget = COMPUTE_BUDGET_PROGRAM_BASE58;

  for (const ix of instructions) {
    if (ix.programId !== computeBudget) continue;
    const data = Buffer.from(ix.data, "base64");
    if (data.length < 9) continue;
    if (data[0] === 2) continue;
    if (data[0] === 3) {
      const price = Number(data.readBigUInt64LE(1));
      if (!Number.isFinite(price) || price <= 0) continue;
      const clamped = Math.min(price, maxUnitPrice);
      if (clamped <= 0) continue;
      const out = Buffer.alloc(9);
      out.writeUInt8(3, 0);
      out.writeBigUInt64LE(BigInt(clamped), 1);
      return new TransactionInstruction({
        programId: new PublicKey(ix.programId),
        keys: [],
        data: out,
      });
    }
  }

  return null;
}

async function sendVersionedViaJupiter(
  swapConnection: Connection,
  connection: Connection,
  tx: VersionedTransaction,
  lastValidBlockHeight: number,
): Promise<string> {
  const signature = await swapConnection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 0,
  });
  await connection.confirmTransaction(
    { signature, blockhash: tx.message.recentBlockhash, lastValidBlockHeight },
    "confirmed",
  );
  return signature;
}

async function executeSwap(
  connection: Connection,
  swapConnection: Connection,
  keypair: Keypair,
  build: JupiterBuildResponse,
  priorityFeeCapLamports: number,
  computeUnitLimit: number,
): Promise<string> {
  const blockhash = base58Encode(Uint8Array.from(build.blockhashWithMetadata.blockhash));
  const altAccounts = transformAltAccounts(build.addressesByLookupTableAddress);
  const instructions = [
    ...build.setupInstructions.map(toInstruction),
    toInstruction(build.swapInstruction),
    ...(build.cleanupInstruction ? [toInstruction(build.cleanupInstruction)] : []),
    ...build.otherInstructions.map(toInstruction),
    toInstruction(build.tipInstruction!),
  ];

  const simulationMessage = new TransactionMessage({
    payerKey: keypair.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }),
      ...instructions,
    ],
  }).compileToV0Message(altAccounts);

  const simulation = await connection.simulateTransaction(
    new VersionedTransaction(simulationMessage),
    { sigVerify: false, replaceRecentBlockhash: true },
  );

  if (simulation.value.err) {
    throw new Error(
      `Swap simulation failed for ${build.inputMint}->${build.outputMint}: ${String(
        simulation.value.err,
      )}`,
    );
  }

  const unitsConsumed = simulation.value.unitsConsumed;
  const estimatedCU = unitsConsumed
    ? Math.min(Math.ceil(unitsConsumed * 1.2), computeUnitLimit)
    : computeUnitLimit;
  const priceInstruction = clampComputeUnitPrice(
    build.computeBudgetInstructions,
    estimatedCU,
    priorityFeeCapLamports,
  );

  const finalMessage = new TransactionMessage({
    payerKey: keypair.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: estimatedCU }),
      ...(priceInstruction ? [priceInstruction] : []),
      ...instructions,
    ],
  }).compileToV0Message(altAccounts);

  const tx = new VersionedTransaction(finalMessage);
  tx.sign([keypair]);
  return sendVersionedViaJupiter(swapConnection, connection, tx, build.blockhashWithMetadata.lastValidBlockHeight);
}

async function tokenBalance(
  connection: Connection,
  owner: PublicKey,
  mint: string,
): Promise<bigint> {
  const info = await tokenAccountInfo(connection, owner, mint);
  return info?.amount ?? 0n;
}

interface TokenAccountInfo {
  ata: PublicKey;
  amount: bigint;
  programId: PublicKey;
}

async function tokenAccountInfo(
  connection: Connection,
  owner: PublicKey,
  mint: string,
): Promise<TokenAccountInfo | null> {
  const mintPubkey = new PublicKey(mint);
  const mintInfo = await connection.getAccountInfo(mintPubkey);
  if (!mintInfo) return null;

  const programId = mintInfo.owner;
  const ata = await getAssociatedTokenAddress(mintPubkey, owner, false, programId);
  try {
    const account = await getAccount(connection, ata, undefined, programId);
    return { ata, amount: account.amount, programId };
  } catch {
    return null;
  }
}

async function unwrapWsol(connection: Connection, keypair: Keypair): Promise<string | null> {
  const ata = await getAssociatedTokenAddress(NATIVE_MINT, keypair.publicKey);
  try {
    await getAccount(connection, ata);
  } catch {
    return null;
  }

  return closeAccount(connection, keypair, ata, keypair.publicKey, keypair);
}

/**
 * Remove 100% of a DLMM position (claiming fees + rewards and closing it),
 * then swap every resulting token balance to SOL via Jupiter /build (Metis routing)
 * and tx.jup.ag submission.
 */
export async function executeClose(params: CloseParams): Promise<CloseResult> {
  const {
    connection,
    keypair,
    pool,
    position,
    slippageBps,
    priorityFeeCapLamports,
    computeUnitLimit,
  } = params;
  const log = params.log ?? (() => undefined);

  const jupiterApiKey = process.env.JUPITER_API_KEY?.trim();
  if (!jupiterApiKey) {
    throw new Error("Missing required environment variable: JUPITER_API_KEY");
  }
  const swapConnection = new Connection(JUPITER_TX_HOST, {
    httpHeaders: { "x-api-key": jupiterApiKey },
  });

  const poolPubkey = new PublicKey(pool);
  const positionPubkey = new PublicKey(position);
  const signatures: string[] = [];
  const swaps: CloseSwapRecord[] = [];
  const skipped: SkippedSwap[] = [];
  const skippedSet = new Set<string>();

  const dlmm = await DLMM.create(connection, poolPubkey);

  let positionClosed = false;
  const accountInfo = await connection.getAccountInfo(positionPubkey);

  if (accountInfo) {
    const lbPosition = await dlmm.getPosition(positionPubkey);
    const owner = lbPosition.positionData.owner;
    if (!owner.equals(keypair.publicKey)) {
      throw new Error(
        `position ${position} is owned by ${owner.toBase58()}, not executor ${keypair.publicKey.toBase58()}`,
      );
    }

    const fromBinId = lbPosition.positionData.lowerBinId;
    const toBinId = lbPosition.positionData.upperBinId;
    log(`Removing 100% liquidity from ${position} (bins ${fromBinId}…${toBinId})`);

    const txs = await dlmm.removeLiquidity({
      user: keypair.publicKey,
      position: positionPubkey,
      fromBinId,
      toBinId,
      bps: new BN(BPS_DENOMINATOR),
      shouldClaimAndClose: true,
    });

    for (let i = 0; i < txs.length; i += 1) {
      const { tx, blockhash, lastValidBlockHeight } = await buildLegacyTransaction(
        connection,
        keypair,
        txs[i].instructions,
        priorityFeeCapLamports,
        computeUnitLimit,
      );
      const signature = await sendLegacy(connection, tx, blockhash, lastValidBlockHeight);
      signatures.push(signature);
      log(`Removed liquidity tx ${i + 1}/${txs.length}: ${signature}`);
    }
    positionClosed = true;
  } else {
    log(`Position ${position} is already closed; swapping remaining balances`);
    positionClosed = true;
  }

  const mints = new Set<string>();
  mints.add(dlmm.tokenX.mint.address.toBase58());
  mints.add(dlmm.tokenY.mint.address.toBase58());
  for (const reward of dlmm.rewards) {
    if (reward) mints.add(reward.mint.address.toBase58());
  }

  for (const mint of mints) {
    if (mint === WSOL) continue;
    const amount = await tokenBalance(connection, keypair.publicKey, mint);
    if (amount <= 0n) continue;

    log(`Swapping ${amount.toString()} of ${mint} to SOL`);
    const build = await getSwapBuild({
      inputMint: mint,
      outputMint: WSOL,
      amount,
      slippageBps,
      taker: keypair.publicKey.toBase58(),
    });

    if (build.outAmount === "0") {
      log(`No swap route or dust for ${mint}; leaving balance`);
      skippedSet.add(mint);
      skipped.push({ mint, amount: amount.toString(), reason: "no output" });
      continue;
    }

    const outAmount = BigInt(build.outAmount);
    const tipPlusBase = BigInt(JUPITER_TIP_LAMPORTS + BASE_FEE_LAMPORTS);
    if (outAmount <= tipPlusBase) {
      log(`Swap value ${build.outAmount} below tip+fee for ${mint}; leaving balance`);
      skippedSet.add(mint);
      skipped.push({ mint, amount: amount.toString(), reason: "below tip+fee" });
      continue;
    }

    const signature = await executeSwap(
      connection,
      swapConnection,
      keypair,
      build,
      priorityFeeCapLamports,
      computeUnitLimit,
    );
    signatures.push(signature);
    swaps.push({
      mint,
      inAmount: build.inAmount,
      outAmount: build.outAmount,
      minOutAmount: build.otherAmountThreshold ?? null,
      priceImpactPct: build.priceImpactPct ?? null,
      routeLabels: (build.routePlan ?? []).map((route) => route.swapInfo.label),
      signature,
    });
    log(
      `Swapped ${mint}: ${build.inAmount} -> ${build.outAmount} WSOL ` +
        `(min ${build.otherAmountThreshold ?? "n/a"} impact ${build.priceImpactPct ?? "n/a"}) ${signature}`,
    );
  }

  const unwrapSignature = await unwrapWsol(connection, keypair);
  if (unwrapSignature) {
    signatures.push(unwrapSignature);
    log(`Unwrapped WSOL: ${unwrapSignature}`);
  }

  const remaining: Array<{ mint: string; amount: string }> = [];
  for (const mint of mints) {
    if (mint === WSOL || skippedSet.has(mint)) continue;
    const amount = await tokenBalance(connection, keypair.publicKey, mint);
    if (amount > 0n) remaining.push({ mint, amount: amount.toString() });
  }

  if (remaining.length > 0) {
    throw new Error(
      `swap incomplete, leftover balances: ${remaining.map((row) => `${row.mint}=${row.amount}`).join(", ")}`,
    );
  }

  return { positionClosed, signatures, swaps, skipped, remaining };
}
