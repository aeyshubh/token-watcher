import type { Keypair } from "@solana/web3.js";
import { getSettings, requireTelegramChatId } from "./settings";
import { loadExecutorKeypair } from "./solana-key";

export interface CloseConfig {
  botToken: string;
  chatId: string;
  rpcUrl: string;
  owner: string;
  keypair: Keypair;
  slippageBps: number;
  priorityFeeCapLamports: number;
  retryBaseMs: number;
  retryMaxMs: number;
  maxAttempts: number;
  computeUnitLimit: number;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

/**
 * Resolve the auto-close executor configuration from config/app.json + env.
 * Returns null when the executor is disabled or no private key is configured.
 */
export function loadCloseConfig(
  overrides: Partial<Pick<CloseConfig, "botToken" | "chatId" | "keypair">> = {},
): CloseConfig | null {
  const settings = getSettings();
  if (!settings.executor.enabled) return null;

  const keypair = overrides.keypair ?? loadExecutorKeypair();
  if (!keypair) return null;

  const rpcUrl = settings.executor.rpcUrl.trim() || settings.solanaRpcUrl;

  return {
    botToken: overrides.botToken ?? required("TELEGRAM_BOT_TOKEN"),
    chatId: overrides.chatId ?? requireTelegramChatId(),
    rpcUrl,
    owner: keypair.publicKey.toBase58(),
    keypair,
    slippageBps: settings.executor.slippageBps,
    priorityFeeCapLamports: settings.executor.priorityFeeCapLamports,
    retryBaseMs: settings.executor.retryBaseMs,
    retryMaxMs: settings.executor.retryMaxMs,
    maxAttempts: settings.executor.maxAttempts,
    computeUnitLimit: settings.executor.computeUnitLimit,
  };
}
