import "dotenv/config";
import { LP_WALLETS_PATH, loadLpConfig, trackOnce, type LpSnapshotEntry } from "../src/lp";
import { loadLpState, saveLpState } from "../src/lp-state";

function formatUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "n/a";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`;
  return `${sign}$${abs.toFixed(abs < 10 ? 2 : 0)}`;
}

function describe(row: LpSnapshotEntry): string {
  const pnl =
    row.pnlPct === null ? "n/a" : `${row.pnlPct >= 0 ? "+" : ""}${row.pnlPct.toFixed(2)}%`;
  const status =
    row.isOutOfRange === null ? "—" : row.isOutOfRange ? "OUT of range" : "IN range";
  return (
    `#${row.number} · ${row.poolName} · ${row.walletLabel}\n` +
    `  ${row.position}\n` +
    `  PnL ${pnl} (${formatUsd(row.pnlUsd)}) · Bal ${formatUsd(row.balances)} · ` +
    `deposit ${formatUsd(row.deposit)} · ${status}\n` +
    `  TP +${row.tpPct}% / SL -${row.slPct}%`
  );
}

async function main(): Promise<void> {
  const send = process.argv.includes("--send");
  const config = loadLpConfig();

  if (config.wallets.length === 0) {
    console.error(`No wallets configured in ${LP_WALLETS_PATH}.`);
    console.error('Add entries like [{ "address": "<wallet>", "label": "main" }] and retry.');
    process.exit(1);
  }

  console.log(
    `Wallets: ${config.wallets
      .map((wallet) => {
        const thresholds =
          wallet.tpPct !== undefined || wallet.slPct !== undefined
            ? ` [TP ${wallet.tpPct ?? "—"}% / SL ${wallet.slPct ?? "—"}%]`
            : "";
        return `${wallet.label} (${wallet.address})${thresholds}`;
      })
      .join(", ")}`,
  );
  console.log(
    `Global defaults: TP +${config.defaultTpPct}% / SL -${config.defaultSlPct}% · ` +
      `interval ${config.intervalMs}ms · ${config.maxRps} RPS cap`,
  );
  console.log(send ? "Mode: sending alerts\n" : "Mode: dry-run\n");

  const state = send ? loadLpState() : {};
  const result = await trackOnce(config, state, send ? saveLpState : () => undefined, { send });

  for (const error of result.errors) console.error(`[error] ${error}`);

  if (result.snapshot.length === 0) {
    console.log("No open DLMM positions detected for the configured wallets.");
  } else {
    console.log(`Detected ${result.snapshot.length} open position(s):\n`);
    for (const row of result.snapshot) console.log(`${describe(row)}\n`);
  }

  if (result.events.length === 0) {
    console.log("No TP/SL/out-of-range triggers this pass.");
  } else {
    const verb = send ? "Sent" : "Triggered";
    console.log(`${verb} ${result.events.length} alert(s):\n`);
    for (const event of result.events) console.log(`${event.text}\n`);
  }

  if (!send) console.log("Dry-run only; pass --send to deliver alerts to Telegram.");
}

main().catch((err) => {
  console.error(`test-lp failed: ${(err as Error).message}`);
  process.exit(1);
});
