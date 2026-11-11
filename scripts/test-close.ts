import "dotenv/config";
import { Connection } from "@solana/web3.js";
import { loadCloseConfig } from "../src/close-config";
import { loadCloseState, saveCloseState } from "../src/close-state";
import { executeClose } from "../src/close";
import { loadLpConfig, trackOnce } from "../src/lp";

function formatPct(value: number | null): string {
  if (value === null) return "n/a";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function rpcLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "custom";
  }
}

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  const config = loadCloseConfig();

  if (!config) {
    console.error(
      "Auto-close executor is disabled or LP_EXECUTOR_PRIVATE_KEY is not set.\n" +
        "Set the key in .env and keep executor.enabled=true in config/app.json.",
    );
    process.exit(1);
  }

  console.log(`Owner: ${config.owner}`);
  console.log(`RPC: ${rpcLabel(config.rpcUrl)}`);
  console.log(
    `Slippage: ${config.slippageBps} bps · fee cap: ${config.priorityFeeCapLamports} lamports · ` +
      `CU limit: ${config.computeUnitLimit}`,
  );
  console.log(
    `Retry: base ${config.retryBaseMs}ms · max ${config.retryMaxMs}ms · ` +
      `maxAttempts ${config.maxAttempts || "unlimited"}`,
  );
  console.log(execute ? "Mode: EXECUTE (real transactions)\n" : "Mode: dry-run\n");

  const state = loadCloseState();
  const orders = Object.values(state).filter((order) => order.status !== "done");
  if (orders.length === 0) {
    console.log("No armed close orders in close-state.json.");
    console.log("Arm one from Telegram with /close <#> [tp <pct>] [sl <pct>].");
    return;
  }

  const lpConfig = loadLpConfig();
  const result = await trackOnce(lpConfig, {}, () => undefined, { send: false });
  for (const error of result.errors) console.error(`[error] ${error}`);

  const byPosition = new Map(result.snapshot.map((row) => [row.position, row]));
  const connection = execute ? new Connection(config.rpcUrl, "confirmed") : null;

  for (const order of orders) {
    const ref = order.number ? `#${order.number}` : order.position;
    console.log(`Order ${ref}`);
    console.log(`  position: ${order.position}`);
    console.log(`  status: ${order.status} · attempts ${order.attempts}`);

    const row = byPosition.get(order.position);
    if (!row) {
      console.log("  not in latest snapshot (closed or not detected)\n");
      continue;
    }

    const tpPct = order.tpPct ?? row.tpPct;
    const slPct = order.slPct ?? row.slPct;
    const pnl = row.pnlPct;
    const tpHit = pnl !== null && tpPct > 0 && pnl >= tpPct;
    const slHit = pnl !== null && slPct > 0 && pnl <= -slPct;

    console.log(`  ${row.poolName} · PnL ${formatPct(pnl)}`);
    console.log(
      `  trigger TP +${tpPct}% / SL -${slPct}% -> ` +
        (tpHit ? "TP HIT" : slHit ? "SL HIT" : "waiting"),
    );

    if (!execute || (!tpHit && !slHit)) {
      console.log();
      continue;
    }

    console.log("  executing close...");
    try {
      const res = await executeClose({
        connection: connection as Connection,
        keypair: config.keypair,
        pool: order.pool,
        position: order.position,
        slippageBps: config.slippageBps,
        priorityFeeCapLamports: config.priorityFeeCapLamports,
        computeUnitLimit: config.computeUnitLimit,
        log: (message) => console.log(`    ${message}`),
      });

      order.status = "done";
      order.closedAt = new Date().toISOString();
      order.signatures = res.signatures;
      order.lastError = undefined;
      saveCloseState(state);

      console.log(
        `  done: ${res.signatures.length} tx(s), ${res.swaps.length} swap(s)\n`,
      );
    } catch (err) {
      order.lastError = (err as Error).message;
      saveCloseState(state);
      console.error(`  failed: ${(err as Error).message}\n`);
    }
  }

  if (!execute) {
    console.log("Dry-run only; pass --execute to close triggered orders for real.");
  }
}

main().catch((err) => {
  console.error(`test-close failed: ${(err as Error).message}`);
  process.exit(1);
});
