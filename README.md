# tokenWatcher

A Telegram bot that tracks Meteora DLMM LP positions and alerts you on take-profit, stop-loss, and out-of-range. An optional auto-close executor can remove liquidity, claim fees/rewards, and swap everything to SOL when a threshold is hit.

Full LP tracker reference: [`README.lp-tracker.md`](./README.lp-tracker.md).

## Quick start

```bash
npm install
cp .env.example .env          # fill TELEGRAM_BOT_TOKEN (and LP_EXECUTOR_PRIVATE_KEY for /close)
npm run get-chat-id           # message your bot /start first, then copy chat_id into config/app.json
npm run build && npm start    # or: npm run dev
```

Add your wallets to `config/lp-wallets.json`:

```json
[{ "address": "<walletAddress>", "label": "main" }]
```

Every `lp.intervalMs` (default 15s) the tracker calls Meteora's `/portfolio/open` endpoint to auto-detect open DLMM positions, then `/positions/{pool}/pnl` for per-position PnL.

## Commands

| Command | Description |
|---|---|
| `/lp` | List auto-detected LP positions by number (`#1`, `#2` …), PnL and TP/SL thresholds. |
| `/status [number]` | Detailed status for one position or all positions. |
| `/lp set <#\|position> [tp <pct\|price>] [sl <pct\|price>]` | Override TP/SL, e.g. `/lp set 1 tp 20 sl 10` or `/lp set 1 tp 0.0001917`. |
| `/set <tp\|sl> <#\|position> <pct\|price>` | Shorthand, e.g. `/set sl 1 20%` or `/set tp 1 0.0001917`. |
| `/lp unset <#\|position>` | Remove a per-position override. |
| `/lp reload` | Reload wallets + overrides from disk. |
| `/close <#\|position> [tp <pct\|price>] [sl <pct\|price>]` | Arm auto-close, e.g. `/close 1 tp 10 sl 20` or `/close 1 tp 0.0001917`. |
| `/close list` | Show armed auto-close orders. |
| `/close off <#\|position>` | Disarm an auto-close order. |
| `/help` / `/start` | Show commands. |

## Alerts

- **Take profit**: either `pnlPctChange >= tpPct` (PnL %) or `poolActivePrice >= tpPrice` (absolute pool price), depending on which threshold is configured.
- **Stop loss**: either `pnlPctChange <= -slPct` or `poolActivePrice <= slPrice`.
- **Threshold input**: values like `20` or `12.5%` are PnL percentages. A positive value below 1 (e.g. `0.0001917`) is a pool price; use `price:2.5` to force a price and `0.5%` to force a sub-1 percentage.
- Threshold resolution per side: **per-position override → wallet override → `config/app.json` defaults**. A price threshold replaces the percentage for that side.
- **Out of range**: a position transitions to out-of-range.
- **Near range edge**: price comes within `lp.nearRangeWidthPct` percent of the range width from an edge (before OOR). Set `0` to disable.
- **Blacklisted pools**: pools listed in `lp.blacklistedPools` are never detected, tracked, or alerted.

Each position is numbered (`#1`, `#2`, …) in `/lp`. Overrides are stored in `config/lp-targets.json`. All Meteora calls share a process-wide throttle capped at `lp.maxRps` (default 20; official limit is 30 RPS). Tracking uses the Data API only, so no Solana RPC calls are consumed.

## Auto-close executor

Arm a position from Telegram to have the bot close it automatically when a threshold is hit:

```
/close 1 tp 10 sl 20      # close #1 at +10% or -20%
/close 1 tp 0.0001917     # close #1 when pool price reaches 0.0001917
/close 1                  # use the position's current TP/SL
/close list               # show armed orders + retry state
/close off 1              # disarm
```

On trigger the executor removes **100%** of the position's liquidity (claiming fees and LM rewards and closing the position), then swaps every resulting token balance to SOL via Jupiter Router `/build` (Metis routing) with `executor.slippageBps` slippage (default 300 = 3%). Each token/reward balance is swapped in a separate transaction through `tx.jup.ag`, which requires a minimum `0.001 SOL` Jupiter tip per transaction plus normal fees. Failed attempts retry with exponential backoff and resume after a restart via `close-state.json`. Priority fees are capped at `executor.priorityFeeCapLamports`.

Requirements:

- `LP_EXECUTOR_PRIVATE_KEY` in `.env` — base58 secret key of the **same wallet** that owns the positions. `/close` rejects positions owned by a different wallet.
- A dedicated RPC is strongly recommended in `config/app.json` → `executor.rpcUrl` (falls back to `solanaRpcUrl`).
- `JUPITER_API_KEY` in `.env` is required for auto-close swaps via Jupiter Router / `tx.jup.ag`.

Test without broadcasting:

```bash
npm run test-close              # dry run: shows armed orders + current trigger state
npm run test-close -- --execute # real close for orders whose TP/SL is currently hit
```

## Configuration

`.env` — only API keys and tokens:

```dotenv
TELEGRAM_BOT_TOKEN=123456789:AA...
LP_EXECUTOR_PRIVATE_KEY=base58_secret_key   # required to enable /close
JUPITER_API_KEY=your_jupiter_api_key_here   # required for auto-close swaps
```

`config/app.json` — every runtime setting:

```json
{
  "telegramChatId": "123456789",
  "solanaRpcUrl": "https://api.mainnet-beta.solana.com",
  "lp": {
    "enabled": true,
    "intervalMs": 15000,
    "maxRps": 20,
    "defaultTpPct": 20,
    "defaultSlPct": 10,
    "alertCooldownMs": 900000,
    "oorCooldownMs": 3600000,
    "minPositionUsd": 1,
    "nearRangeWidthPct": 10,
    "blacklistedPools": []
  },
  "executor": {
    "enabled": true,
    "rpcUrl": "",
    "slippageBps": 300,
    "priorityFeeCapLamports": 5000000,
    "retryBaseMs": 5000,
    "retryMaxMs": 300000,
    "maxAttempts": 0,
    "computeUnitLimit": 1400000
  }
}
```

`npm run get-chat-id` prints your chat ID; put it in `config/app.json`.

`config/lp-wallets.json` lists the wallets scanned for LP positions (with optional wallet-level `tpPct` / `slPct` or `tpPrice` / `slPrice`), and `config/lp-targets.json` holds per-position TP/SL overrides in the same formats.

## Security notes

- Commands are accepted only from `telegramChatId`. Use a private chat with your own account and never share the bot token or `.env`.
- `LP_EXECUTOR_PRIVATE_KEY` is read from `.env`, is never logged, and must belong to the wallet that owns the positions.
- TP/SL inputs must be finite numbers: prices are positive, percentages are non-negative, and a side cannot mix both modes. Corrupted `close-state.json` orders are marked failed instead of executed.
- State and override files (`close-state.json`, `lp-state.json`, `config/lp-targets.json`) are rewritten with mode `0600` where the filesystem supports it.

## Running

```bash
npm run dev          # tsx watch
npm run build && npm start
```

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
| `npm run get-chat-id` | Find the chat ID for `config/app.json` |
| `npm run test-lp` / `reset-lp` | Dry-run the LP tracker / clear its cooldown state |
| `npm run test-close` | Dry-run the auto-close executor (`-- --execute` to broadcast) |
| `npm run set-commands` | Register the `/` menu |

## Project structure

```
src/
  index.ts         # entry: LP tracker + executor + command loop
  commands.ts      # Telegram command handlers
  settings.ts      # config/app.json loader
  telegram.ts      # sendMessage + long-poll
  format.ts        # price/USD formatting
  meteora.ts       # Meteora DLMM Data API client
  meteora-rate.ts  # shared Meteora throttle (30 RPS limit, 429 backoff)
  lp.ts            # auto-detected DLMM positions + TP/SL/out-of-range alerts
  lp-state.ts      # LP cooldown + out-of-range persistence
  close.ts         # remove liquidity + claim + swap-to-SOL routine
  close-config.ts  # executor config (keypair + config/app.json)
  close-state.ts   # armed auto-close orders persistence
  executor.ts      # auto-close scheduler (TP/SL trigger + retries)
  jupiter.ts       # Jupiter Router /build client
  solana-key.ts    # loads LP_EXECUTOR_PRIVATE_KEY
  solana.ts        # base58 helpers
scripts/           # get-chat-id, set-commands, test-lp, test-close, reset-lp
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `/lp` says tracker not running | Add wallets to `config/lp-wallets.json` and keep `lp.enabled=true` in `config/app.json`. |
| LP alerts not repeating | Wait for `lp.alertCooldownMs` (default 15 min), or `npm run reset-lp`. |
| `Meteora rate-limited until …` | Lower `lp.maxRps` in `config/app.json`; calls pause until the API reset window. |
| `/close` says executor not running | Set `LP_EXECUTOR_PRIVATE_KEY` in `.env` and keep `executor.enabled=true`; restart. |
| `/close` rejects wallet | The executor key must own the position (same wallet as `config/lp-wallets.json`). |
| Auto-close keeps retrying | Check `executor.rpcUrl`, the RPC logs, the fee cap, and that Jupiter has a route; see `/close list` for the last error. |
| Bot ignores commands | Must be running, and message from the chat in `config/app.json` → `telegramChatId`. |

## Notes

- **Read-only by default**: tracking and alerts hold no keys. The optional auto-close executor is the only component that signs transactions, and it is enabled only when `LP_EXECUTOR_PRIVATE_KEY` is set and `/close` is armed for a position.
- `.env` is gitignored — `chmod 600 .env`. It should contain only API keys and tokens; all other settings live in `config/app.json`.
- Not financial advice.
