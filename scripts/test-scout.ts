import "dotenv/config";
import { loadScoutConfig, scanOnce, formatPoolAlert } from "../src/scout";

async function main(): Promise<void> {
  const send = process.argv.includes("--send");
  const config = loadScoutConfig();

  console.log(
    `Scanning Meteora DLMM pools · filters: TVL>${config.minTvl} · ` +
      `vol30m>${config.minVolume30m} · fees1h>${config.minFees1h} · ` +
      `MC>${config.minMarketCap}${send ? " · sending alerts" : " · dry-run"}`,
  );

  const matches = await scanOnce(config, { send });

  if (matches.length === 0) {
    console.log("No pools matched the thresholds.");
    return;
  }

  console.log(`\n${matches.length} match(es):\n`);
  for (const match of matches) {
    console.log(`${formatPoolAlert(match)}\n`);
  }
  console.log(send ? "Alerts sent to Telegram." : "Dry-run only; pass --send to deliver.");
}

main().catch((err) => {
  console.error(`test-scout failed: ${(err as Error).message}`);
  process.exit(1);
});
