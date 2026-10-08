# tokenWatcher

A Telegram bot that watches Solana token prices via the [GMGN OpenAPI](https://gmgn.ai/ai), alerts when a target is hit, and analyses Meteora DLMM LP positions with a `/pos` command.

> The HawkFi pool scout (scans Meteora pools for TVL/fees/volume) now runs **in-process** with the price bot by default — no second process needed. Set `SCOUT_ENABLED=false` to disable. Details: [`README.hawkfi-scout.md`](./README.hawkfi-scout.md).

## Quick start

```bash
npm install
cp .env.example .env          # fill in GMGN_API_KEY + TELEGRAM_BOT_TOKEN
npm run get-chat-id           # message your bot /start first, then copy chat_id into .env
npm run build && npm start    # or: npm run dev
```

Send your bot `/add <mint> <target> [above|below]` and it polls every 15s, pinging you when the price crosses your target.

## Commands

| Command | Description |
|---|---|
| `/pos <position\|pool> [wallet\|pool]` | Analyse a Meteora DLMM LP position + scan the pool's top wallets. |
| `/add <mint> <target> [above\|below]` | Track a mint (direction defaults to `above`). |
| `/list` | Tracked mints with live price + status. |
| `/remove <mint>` | Stop tracking a mint. |
| `/clear` | Stop tracking everything. |
| `/reload` | Reload `config/watchlist.json` from disk. |
| `/help` / `/start` | Show commands. |

Direction aliases: `above`/`over`/`>` and `below`/`under`/`<`.

## Position analysis (`/pos`)

Accepts any of these:

```
/pos <positionAddress> <poolAddress>
/pos <poolAddress> <walletAddress>
/pos <positionAddress>                 # pool + owner derived on-chain
/pos https://app.meteora.ag/dlmm/<pool>
```

Returns three sections:

1. **Pool health** — mcap, TVL, price, bin step, base fee, volume + fees (1h/24h).
2. **Your position** — balance, age, fees + fee-yield %, unclaimed, PnL, deposit, shape, and your bin range in **market-cap terms** — plus a **verdict** (`HOLD`/`DE-RISK`/`CLOSE`) with close triggers.
3. **Top wallets** — the pool's largest LPs (enumerated on-chain, ranked by fees claimed), each with fees claimed, current size, ±PnL, in/out-of-range, shape and age, plus a crowd signal.

```
🏊 Pool AUTON-SOL · MC $3.97M · TVL $342.8k · base fee 1%
📊 Your position — balance $3,850 · age 7.7h · fees $450 (11.7%) · PnL +3.94%
   Range $1.13M–$12.21M mcap · now $3.79M · IN range · 🟢 HOLD
👥 Top 15 wallets (by fees claimed)
 1. Dvw4…PBSK  fees $18.2k | size $0.00 | exited | ❌ out
 2. 7iet…daRk  fees $3.0k | size $2.5k | -$58 (+0.16%) | ✅ in-range | dual | 0h
📈 Crowd: 14 holding / 1 exited · 8 net-positive, 6 net-negative.
```

Pool/position data comes from the Meteora DLMM Data API; the wallet list is read **on-chain** (`getProgramAccounts` → PositionV2 decode) and ranked by fees claimed. Takes **~5–40s** depending on the RPC. Test without Telegram:

```bash
npm run test-pos -- <position|pool> [wallet] [--send]
```

## Configuration

`.env` (copy from `.env.example`):

```dotenv
GMGN_API_KEY=gmgn_xxx
TELEGRAM_BOT_TOKEN=123456789:AA...
TELEGRAM_CHAT_ID=123456789

POLL_INTERVAL_MS=15000   # price poll interval
PING_COUNT=5             # messages per target hit
PING_DELAY_MS=1000       # gap between pings

SOLANA_RPC_URL=https://api.mainnet-beta.solana.com  # dedicated RPC = faster /pos scans
POS_TOP_WALLETS=15                                  # LPs to scan per pool
```

`config/watchlist.json` holds the initial mints (managed by `/add` `/remove` `/clear`, or edit by hand then `/reload`):

```json
[{ "address": "<mint>", "symbol": "xHYPE", "target": { "price": 2.75, "direction": "above" }, "pings": 5 }]
```

## Running

```bash
npm run dev          # tsx watch — runs the price bot AND the HawkFi scout
npm run build && npm start
```

Both loops share one process; disable the scout with `SCOUT_ENABLED=false` or run it alone via `npm run scout`.

Background with pm2:

```bash
pm2 start dist/index.js --name tokenWatcher --cwd "$(pwd)"
pm2 save && pm2 startup
pm2 restart tokenWatcher --update-env   # after editing .env
```

## npm scripts

| Script | Description |
|---|---|
| `npm run dev` / `build` / `start` | Watch mode / compile / run |
| `npm run typecheck` | Type-check only |
| `npm run get-chat-id` | Find `TELEGRAM_CHAT_ID` |
| `npm run test-alert` | Verify the Telegram pipe |
| `npm run test-pos` | Analyse a position/pool from the CLI |
| `npm run set-commands` | Register the `/` menu |
| `npm run reset` | Clear fired-target state |

## Project structure

```
src/
  index.ts      # entry: price loop + command loop
  commands.ts   # Telegram command handlers
  gmgn.ts       # GMGN price client
  meteora.ts    # Meteora DLMM API client
  solana.ts     # Solana RPC + PositionV2 decoding
  position.ts   # /pos analysis engine + top-wallet scan
  hawkfi.ts     # pool scout client
  telegram.ts   # sendMessage + long-poll
  store.ts / state.ts / alerts.ts / config.ts / types.ts
scripts/        # get-chat-id, test-alert, test-pos, set-commands, reset, scout
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| No alerts | Run `npm run test-alert`; check token/chat ID and that you sent `/start`. |
| Bot ignores commands | Must be running, and message from the chat in `TELEGRAM_CHAT_ID`. |
| `/add` "Could not fetch mint" | Bad address or no GMGN price. |
| `401`/`403` from GMGN | Disable IPv6 or verify `GMGN_API_KEY`. |
| `/pos` slow or empty wallets | Use a dedicated `SOLANA_RPC_URL`; large pools take longer. |
| Target won't re-fire | It fires once — `/remove` + `/add`, or `npm run reset`. |

## Notes

- **Read-only**: fetches data and sends messages; holds no keys, places no trades.
- `.env` is gitignored — `chmod 600 .env`. Only `TELEGRAM_CHAT_ID` is accepted.
- GMGN data may be delayed/inaccurate. Informational only, not financial advice.
