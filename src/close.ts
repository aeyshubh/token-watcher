import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  closeAccount,
  getAccount,
  getAssociatedTokenAddress,
  NATIVE_MINT,
} from "@solana/spl-token";
import DLMM from "@meteora-ag/dlmm";
import BN from "bn.js";
import { getQuote, getSwapTransaction } from "./jupiter";

const WSOL = NATIVE_MINT.toBase58();
const BPS_DENOMINATOR = 10_000;

export interface CloseSwapRecord {
  mint: string;
  inAmount: string;
  outAmount: string;
  signature: string;
}

export interface CloseResult {
  positionClosed: boolean;
  signatures: string[];
  swaps: CloseSwapRecord[];
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

async function sendVersioned(
  connection: Connection,
  tx: VersionedTransaction,
  lastValidBlockHeight: number,
): Promise<string> {
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 5,
  });
  await connection.confirmTransaction(
    { signature, blockhash: tx.message.recentBlockhash, lastValidBlockHeight },
    "confirmed",
  );
  return signature;
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
 * then swap every resulting token balance to SOL at the configured slippage.
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

  const poolPubkey = new PublicKey(pool);
  const positionPubkey = new PublicKey(position);
  const signatures: string[] = [];
  const swaps: CloseSwapRecord[] = [];

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

  const skipped = new Set<string>();

  for (const mint of mints) {
    if (mint === WSOL) continue;
    const amount = await tokenBalance(connection, keypair.publicKey, mint);
    if (amount <= 0n) continue;

    log(`Swapping ${amount.toString()} of ${mint} to SOL`);
    const quote = await getQuote({ inputMint: mint, outputMint: WSOL, amount, slippageBps });
    if (!quote || quote.outAmount === "0") {
      log(`No swap route or dust for ${mint}; leaving balance`);
      skipped.add(mint);
      continue;
    }

    const swap = await getSwapTransaction({
      quote,
      userPublicKey: keypair.publicKey.toBase58(),
      priorityFeeCapLamports,
    });
    const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, "base64"));
    tx.sign([keypair]);

    const signature = await sendVersioned(connection, tx, swap.lastValidBlockHeight);
    signatures.push(signature);
    swaps.push({
      mint,
      inAmount: quote.inAmount,
      outAmount: quote.outAmount,
      signature,
    });
    log(`Swapped ${mint}: ${quote.inAmount} -> ${quote.outAmount} SOL (${signature})`);
  }

  const unwrapSignature = await unwrapWsol(connection, keypair);
  if (unwrapSignature) {
    signatures.push(unwrapSignature);
    log(`Unwrapped WSOL: ${unwrapSignature}`);
  }

  const remaining: Array<{ mint: string; amount: string }> = [];
  for (const mint of mints) {
    if (mint === WSOL || skipped.has(mint)) continue;
    const amount = await tokenBalance(connection, keypair.publicKey, mint);
    if (amount > 0n) remaining.push({ mint, amount: amount.toString() });
  }

  if (remaining.length > 0) {
    throw new Error(
      `swap incomplete, leftover balances: ${remaining.map((row) => `${row.mint}=${row.amount}`).join(", ")}`,
    );
  }

  return { positionClosed, signatures, swaps, remaining };
}
