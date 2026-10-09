# HawkFi Pool Scout

Scans Solana **Meteora DLMM** pools every 15s and Telegram-alerts when a pool clears all your thresholds. It runs **in-process** with the price bot (see `src/index.ts`) and only **sends** messages, so it shares the same bot token without conflicting. Set `SCOUT_ENABLED=false` to turn it off, or run it standalone with `npm run scout`.

> Price-target bot? See [`README.md`](./README.md).

## What it does

Alerts when **all** of these hold for a pool (logical AND), once per pool:

| Condition | Default |
|---|---|
| Base-token market cap | `> $1,000,000` |
| 1h fees (`fees.1h`) | `> $2,000` |
| TVL | `> $50,000` |
| 30m volume (`volume.30m`) | `> $100,000` |

Defaults are strict, so matches are rare (often 0) — loosen the thresholds to fire more. Fired pools persist to `scout-state.json`, so restarts don't re-alert. "Base token" = whichever side isn't SOL/USDC/USDT.

## Quick start

```bash
npm install
cp .env.example .env          # fill TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
npm run test-scout            # dry-run: prints matches, sends nothing
npm run dev                   # run the price bot + scout together
npm run scout                 # ...or run the scout by itself
```

## Configuration

`.env` (only the two Telegram values are required):

```dotenv
TELEGRAM_BOT_TOKEN=123456789:AA...
TELEGRAM_CHAT_ID=123456789

SCOUT_ENABLED=true             # run the scout in-process with the price bot (false = off)
SCOUT_INTERVAL_MS=15000        # scan interval (ms)
SCOUT_MIN_MARKET_CAP=1000000   # base-token mcap floor (USD)
SCOUT_MIN_FEES_1H=2000         # 1h fees floor (USD)
SCOUT_MIN_TVL=50000            # TVL floor (USD)
SCOUT_MIN_VOLUME_30M=100000    # 30m volume floor (USD)
SCOUT_MIN_ALERT_INTERVAL_MS=60000 # re-alert the same pool after 1 min (0 = once, ever)
SCOUT_MAX_RESULTS=100          # pools pulled per scan
```

Re-arm all pools with `npm run reset-scout`. CLI env overrides win over `.env`, handy for testing:

```bash
SCOUT_MIN_FEES_1H=100 SCOUT_MIN_VOLUME_30M=20000 npm run test-scout
```

## Alert format

```
🟢 HawkFi pool match
PUMPE-SOL · MC $3.37M
TVL $73.2k · 30m Vol $33.8k · 1h Fees $2.5k
Pool: 13Fg7bRPgQVJHUEj1UUueDAaDjUke129k8ULFzRcaCv4
https://app.meteora.ag/dlmm/13Fg7bRPgQVJHUEj1UUueDAaDjUke129k8ULFzRcaCv4
```

`MC` is always the base token's market cap.

## npm scripts

| Script | Description |
|---|---|
| `npm run scout` | Run the scout (alerts enabled, fire-once per pool) |
| `npm run test-scout` | One-shot dry-run (add `-- --send` to deliver) |
| `npm run reset-scout` | Clear fired-pool state to re-arm |
| `npm run build` / `typecheck` | Compile to `dist/scout.js` / type-check |

## Running

```bash
npm run dev                                     # price bot + scout together (Ctrl+C to stop)

npm run build                                   # background via pm2 (single process)
pm2 start dist/index.js --name tokenWatcher --cwd "$(pwd)"
pm2 save && pm2 startup
pm2 restart tokenWatcher --update-env           # after editing .env
```

Running the scout on its own is still possible: `npm run scout` or `pm2 start dist/scout.js --name hawkfi-scout`.

For auto-start on macOS login, use a launchd plist pointing at `dist/scout.js` (working directory = project root).

## API

- `GET https://dlmm.datapi.meteora.ag/pools`
- Filter: `<field><op><value>` joined by ` && `, e.g. `tvl>50000 && volume_30m>100000 && fee_1h>2000`
- Sort `fee_1h:desc`, page size `SCOUT_MAX_RESULTS`. Market cap is filtered client-side.
- Requests retry up to 4× with backoff; a failed scan is logged and skipped.

## Troubleshooting

| Symptom | Fix |
|---|---|
| No matches for a long time | Expected with defaults — try `SCOUT_MIN_FEES_1H=100 SCOUT_MIN_VOLUME_30M=20000 npm run test-scout`. |
| No Telegram messages | Run `npm run test-alert`; check token/chat ID and that you sent `/start`. |
| `Missing required environment variable` | `.env` lacks `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`. |
| Pool won't re-alert | It fires once — `npm run reset-scout`. |
| `Meteora HTTP 4xx/5xx` | Transient; it retries then continues. |

## Notes

- Reuses `src/telegram.ts` from the main bot; never touches its `state.json` / `watchlist.json`.
- Read-only: reads public data, sends messages, holds no keys, places no trades.
- Meteora data may be delayed/inaccurate. Informational only, not financial advice.
