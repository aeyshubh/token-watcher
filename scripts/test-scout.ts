import "dotenv/config";
import { loadScoutConfig, scanOnce, formatPoolAlert } from "../src/scout";
import { describeSelection, SELECTION_PATH } from "../src/selection";

async function main(): Promise<void> {
  const send = process.argv.includes("--send");
  const config = loadScoutConfig();

  console.log(`Criteria (${SELECTION_PATH}):\n  ${describeSelection(config.selection)}`);
  console.log(send ? "Mode: sending alerts\n" : "Mode: dry-run\n");

  const { matches, candidates } = await scanOnce(config, { send, verbose: true });

  if (matches.length === 0) {
    console.log(`\nNo pools matched (${candidates} passed Meteora filters, 0 passed GMGN checks).`);
    return;
  }

  console.log(`\n${matches.length} match(es):\n`);
  for (const match of matches) {
    console.log(`${formatPoolAlert(match, config.selection)}\n`);
  }
  console.log(send ? "Alerts sent to Telegram." : "Dry-run only; pass --send to deliver.");
}

main().catch((err) => {
  console.error(`test-scout failed: ${(err as Error).message}`);
  process.exit(1);
});
