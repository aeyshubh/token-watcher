import { Keypair } from "@solana/web3.js";
import { base58Decode } from "./solana";

export const EXECUTOR_KEY_ENV = "LP_EXECUTOR_PRIVATE_KEY";

export function executorPrivateKey(): string | null {
  const raw = process.env[EXECUTOR_KEY_ENV];
  if (!raw || !raw.trim()) return null;
  return raw.trim();
}

/**
 * Load the LP executor keypair from `LP_EXECUTOR_PRIVATE_KEY` (base58 secret key).
 * Returns null when the variable is not set.
 */
export function loadExecutorKeypair(): Keypair | null {
  const raw = executorPrivateKey();
  if (!raw) return null;

  let bytes: Uint8Array;
  try {
    bytes = base58Decode(raw);
  } catch (err) {
    throw new Error(`${EXECUTOR_KEY_ENV} is not valid base58: ${(err as Error).message}`);
  }

  if (bytes.length !== 64) {
    throw new Error(
      `${EXECUTOR_KEY_ENV} must decode to a 64-byte secret key (got ${bytes.length} bytes)`,
    );
  }

  return Keypair.fromSecretKey(bytes);
}


