# HawkFi Pool Scout

Scans **Solana** **Meteora DLMM** pools every 15s and Telegram-alerts when a pool clears all your selection criteria. It runs **in-process** with the price bot (see `src/index.ts`) and only **sends** messages, so it shares the same bot token without conflicting. Set `SCOUT_ENABLED=false` to turn it off, or run it standalone with `npm run scout`.

> Price-target bot? See [`README.md`](./README.md).

## Selection criteria — `config/selection.json`

All selection criteria live in **one file**: `config/selection.json`. Nothing in `.env` or the code overrides it. A pool alerts only when it passes **every** check (logical AND).

| Field | Checked by | Meaning |
|---|---|---|
| `chain` | code | Must be `"sol"`. The scout and all GMGN lookups are Solana-only. |
| `quoteMints` | code | Quote-side mints; the other side is the **base token**. Pools where both sides are quote mints are skipped. |
| `minTvlUsd` | Meteora | Pool TVL floor (USD). |
| `minFees` | Meteora | Fees generated in `window` (`5m` `30m` `1h` `2h` `4h` `12h` `24h`). `unit: "SOL"` is converted at the live SOL/USD price each scan; `"USD"` is used as-is. |
| `minFeeTvlRatio1h` | Meteora | `fee_tvl_ratio_1h` as Meteora reports it (percent, `0.05` = 0.05% of TVL per hour). `0` disables. |
| `minPoolAgeSeconds` | Meteora | Minimum pool age. `0` disables. |
| `minMarketCapUsd` | GMGN | Base-token market cap (price × circulating supply). |
| `minVolume5mUsd` | GMGN | Base-token 5m volume — **token-wide across all pools GMGN indexes**, not just this Meteora pool. |
| `sortBy` | Meteora | Sort order, e.g. `fee_24h:desc`. |
| `pageSize` | Meteora | Pools pulled per scan (1–1000). |
| `solUsdPool` | Meteora | SOL-USDC pool used to price SOL for SOL-denominated thresholds. |
| `extraFilters` | Meteora | Extra raw `filter_by` expressions, AND-ed with the rest. |

The file is validated at startup; a bad value stops the bot with a message naming the field.

### Extra filters

`extraFilters` takes single Meteora expressions (`<field><op><value>`, ops `=` `>` `>=` `<` `<=`). Useful ones:

```json
"extraFilters": [
  "is_blacklisted=false",
  "volume_24h>500000",
  "fee_1h>500",
  "bin_step>=80",
  "farm_apy>0"
]
```

Filterable fields: `tvl`, `volume_<w>`, `fee_<w>`, `fee_tvl_ratio_<w>`, `protocol_fee_<w>` (windows `5m` `30m` `1h` `2h` `4h` `12h` `24h`), `fee_pct`, `dynamic_fee_pct`, `bin_step`, `pool_created_at` (milliseconds), `farm_apr`, `farm_apy`, `is_blacklisted`, `pool_address`, `token_x`, `token_y` (mint addresses). `apr_*` is documented by Meteora but rejected by the live API. Market cap is not filterable on Meteora (hence GMGN).

## How a scan works

1. If `minFees.unit` is `SOL`, fetch SOL/USD from `solUsdPool` (cached 60s). If that fails, the scan is skipped — the fee floor is never evaluated against an unknown price.
2. `GET https://dlmm.datapi.meteora.ag/pools` with `filter_by` built from TVL, fees, fee/TVL, pool age and `extraFilters`, e.g.
   `tvl>60000 && fee_24h>5097.96 && fee_tvl_ratio_1h>0.05 && pool_created_at<1793210587160`
3. For each surviving pool, pick the base token and call GMGN `GET /v1/token/info` (uses `GMGN_API_KEY`). One lookup per unique token, cached 30s.
4. Keep pools whose base token passes `minMarketCapUsd` and `minVolume5mUsd`. A failed GMGN lookup rejects the pool (no alert on missing data).

GMGN requests are serialized and spaced by `GMGN_MIN_INTERVAL_MS` (default 1000ms), shared with the price loop. On a `429` the bot stops calling GMGN until the reset time instead of retrying (retries during a GMGN cooldown extend the ban).

## Quick start

```bash
npm install
cp .env.example .env          # fill GMGN_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
$EDITOR config/selection.json # set your criteria
npm run test-scout            # dry-run: prints filter, candidates, rejection reasons; sends nothing
npm run dev                   # run the price bot + scout together
npm run scout                 # ...or run the scout by itself
```

## Runtime settings (`.env`)

Only runtime settings live in `.env`; criteria do not.

```dotenv
GMGN_API_KEY=gmgn_xxx          # required by the scout (5m volume + market cap)
TELEGRAM_BOT_TOKEN=123456789:AA...
TELEGRAM_CHAT_ID=123456789

GMGN_MIN_INTERVAL_MS=1000      # min gap between GMGN calls
SCOUT_ENABLED=true             # run the scout in-process with the price bot (false = off)
SCOUT_INTERVAL_MS=15000        # scan interval (ms)
SCOUT_MIN_ALERT_INTERVAL_MS=60000 # re-alert the same pool after 1 min (0 = once, ever)
```

Re-arm all pools with `npm run reset-scout`.

## Alert format

```
🟢 HawkFi pool match
GTA6-SOL · MC $8.74M
TVL $423.1k · 5m Vol $14.8k (token, GMGN)
24h Fees $37.2k (~365.3 SOL) · Fee/TVL 1h 0.485% · age 62.0d
Pool: xg71xrhn7MEj5akrZGteuYeiTLbBzyNCpBn69bRYd5a
https://www.hawkfi.ag/meteora/xg71xrhn7MEj5akrZGteuYeiTLbBzyNCpBn69bRYd5a?create=true
```

`MC` and `5m Vol` come from GMGN (base token); TVL, fees, fee/TVL and age come from Meteora (this pool).

## npm scripts

| Script | Description |
|---|---|
| `npm run scout` | Run the scout standalone (alerts enabled) |
| `npm run test-scout` | One-shot dry-run with rejection reasons (add `-- --send` to deliver) |
| `npm run reset-scout` | Clear fired-pool state to re-arm |
| `npm run build` / `typecheck` | Compile / type-check |

## Running

```bash
npm run dev                                     # price bot + scout together (Ctrl+C to stop)

npm run build                                   # background via pm2 (single process)
pm2 start dist/index.js --name tokenWatcher --cwd "$(pwd)"
pm2 save && pm2 startup
pm2 restart tokenWatcher --update-env           # after editing .env or config/selection.json
```

Running the scout on its own is still possible: `npm run scout` or `pm2 start dist/scout.js --name hawkfi-scout`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| No matches for a long time | Run `npm run test-scout` — it prints which check rejected each candidate. Loosen that field in `config/selection.json`. |
| `GMGN rate-limited until …` | Free-tier limit hit. Wait for the reset; raise `GMGN_MIN_INTERVAL_MS` or lower `pageSize`. |
| `Missing required environment variable: GMGN_API_KEY` | The scout now needs GMGN for 5m volume + market cap. |
| `config/selection.json: "…" must be …` | Fix the named field. |
| `Meteora HTTP 400: unknown or unfilterable filter field(s)` | An `extraFilters` entry uses a field Meteora doesn't accept. |
| No Telegram messages | Run `npm run test-alert`; check token/chat ID and that you sent `/start`. |
| Pool won't re-alert | Cooldown (`SCOUT_MIN_ALERT_INTERVAL_MS`), or fired once — `npm run reset-scout`. |

## Notes

- Reuses `src/telegram.ts` and `src/gmgn.ts` from the main bot; never touches its `state.json` / `watchlist.json`.
- Read-only: reads public data, sends messages, holds no keys, places no trades.
- Meteora/GMGN data may be delayed/inaccurate and can disagree (different sources and windows). Informational only, not financial advice.
