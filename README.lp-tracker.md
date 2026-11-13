# Meteora DLMM LP Tracker

Auto-detects your **Meteora DLMM** positions and Telegram-alerts when take-profit, stop-loss, or out-of-range conditions hit. It runs **in-process** with the auto-close executor (see `src/index.ts`). Set `lp.enabled=false` in `config/app.json` to disable.

> Tracking uses the **Meteora Data API only** — no Solana RPC calls.

The optional **auto-close executor** can close a position on TP/SL, swap everything to SOL, and retry until it succeeds. It is armed per-position with `/close` and needs `LP_EXECUTOR_PRIVATE_KEY` in `.env`. See [Auto-close executor](#auto-close-executor).

## Quick start

```bash
npm install
cp .env.example .env          # fill TELEGRAM_BOT_TOKEN (and LP_EXECUTOR_PRIVATE_KEY for /close)
# set telegramChatId in config/app.json (use: npm run get-chat-id)

# Add your wallets:
cat > config/lp-wallets.json <<'JSON'
[{ "address": "<walletAddress>", "label": "main", "tpPct": 10, "slPct": 10 }]
JSON

npm run test-lp               # dry run: prints detected positions + triggers
npm run test-lp -- --send     # deliver any due alerts to Telegram
npm run dev                   # run everything together
```

## How it works

Every `lp.intervalMs` (default 15s):

1. `GET /portfolio/open?user=<wallet>` — auto-discovers every open DLMM position and its pool.
2. `GET /positions/{pool}/pnl?user=<wallet>&status=open` — per-position PnL, range and fees.
3. Evaluates:
   - **Take profit**: `pnlPctChange >= tpPct` (PnL mode) or `poolActivePrice >= tpPrice` (price mode)
   - **Stop loss**: `pnlPctChange <= -slPct` or `poolActivePrice <= slPrice`
   - **Out of range**: position transitions from in-range to out-of-range
4. Applies cooldowns, persists to `lp-state.json`, sends Telegram.
5. Positions no longer returned by `/portfolio/open` are pruned automatically.

Each open position gets a stable number (`#1`, `#2`, …) while it remains open. Use that number in `/lp list`, `/lp set`, and `/lp unset`.

On first discovery, the out-of-range state is seeded from the current value, so positions that are already out of range do not alert immediately. TP/SL still evaluate on the first tick.

Dust positions below `lp.minPositionUsd` are tracked but never trigger alerts.

## Configuration files

### `config/lp-wallets.json`

```json
[
  { "address": "<walletAddress>", "label": "main", "tpPct": 10, "slPct": 10 },
  { "address": "<walletAddress>", "label": "price-mode", "tpPrice": 0.0001917, "slPrice": 0.0001620 },
  { "address": "<walletAddress>", "label": "degen" }
]
```

Plain address strings are also accepted. `tpPct` / `slPct` are optional PnL-percentage thresholds; `tpPrice` / `slPrice` are optional absolute pool-price thresholds (quote per base token). Do not set both modes for the same side in one object. Every configured wallet is scanned each tick.

### `config/lp-targets.json`

Per-position overrides. Managed automatically by `/lp set` and `/lp unset`:

```json
{
  "<positionAddress>": { "tpPct": 35, "slPct": 12 },
  "<anotherPosition>": { "tpPrice": 0.0001917, "slPrice": 0.0001620 }
}
```

Threshold resolution order per side: **per-position override → wallet override → `config/app.json` defaults**. A configured price replaces the percentage for that side. Via Telegram, `/set` auto-detects: `20` / `12.5%` → PnL percent, `0.0001917` → pool price. Use `price:2.5` to force a price target ≥ 1 and `0.5%` to force a sub-1 percentage.

## Runtime settings (`config/app.json`)

```json
{
  "lp": {
    "enabled": true,
    "intervalMs": 15000,
    "maxRps": 20,
    "defaultTpPct": 20,
    "defaultSlPct": 10,
    "alertCooldownMs": 900000,
    "oorCooldownMs": 3600000,
    "minPositionUsd": 1,
    "nearRangeWidthPct": 10
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

`lp.maxRps` is a **process-wide** throttle for all Meteora calls. It spaces requests by `1000 / maxRps` ms and, on a `429`, pauses all queued calls until the API reset window.

### Executor settings

| Key | Meaning |
|---|---|
| `enabled` | Turn the auto-close executor on/off |
| `rpcUrl` | Dedicated Solana RPC (falls back to `solanaRpcUrl`) |
| `slippageBps` | Jupiter swap slippage in bps (300 = 3%) |
| `priorityFeeCapLamports` | Max priority fee per transaction (5,000,000 = 0.005 SOL) |
| `retryBaseMs` / `retryMaxMs` | Exponential retry backoff bounds |
| `maxAttempts` | Give up after N attempts (`0` = retry forever) |
| `computeUnitLimit` | Compute budget for DLMM remove transactions |

## Auto-close executor

Arm a position to have it closed automatically when a threshold is hit:

```
/close 1 tp 10 sl 20   # close #1 at +10% or -20%
/close 1 tp 0.0001917  # close #1 when pool price reaches 0.0001917
/close 1               # use the position's current TP/SL
/close list            # status, attempts, next retry, last error
/close off 1           # disarm
```

When triggered, the executor:

1. Removes **100%** of the position's liquidity and claims fees + LM rewards, closing the position.
2. Reads every resulting token balance (including reward tokens) and swaps it to SOL through Jupiter Router `/build` and `tx.jup.ag` at `executor.slippageBps`. Each swap transaction requires a minimum `0.001 SOL` Jupiter tip.
3. Unwraps any WSOL and verifies no token balances remain.
4. Sends a Telegram receipt with transaction links.

Orders may use PnL percentages or absolute pool-price thresholds (the same auto-detection as `/set`), and both modes are persisted in `close-state.json`. Failures are retried with exponential backoff, so a crash or restart resumes armed orders automatically. If a position disappears (closed manually), the order is marked done after a few ticks.

**Safety rules:**

- `LP_EXECUTOR_PRIVATE_KEY` must be the base58 secret key of the wallet that owns the position. `/close` refuses positions owned by another wallet.
- The executor only acts on positions that were explicitly armed with `/close`.
- Use a dedicated RPC (`executor.rpcUrl`) — liquidity removal is heavier than the read-only tracker.

```bash
npm run test-close               # dry run: armed orders + trigger state
npm run test-close -- --execute  # real close for orders currently in TP/SL
```

## Telegram commands

| Command | Description |
|---|---|
| `/lp` or `/lp list` | List detected positions with numbers (`#1`, `#2` …), PnL, thresholds, range status |
| `/status [number]` or `/lp status [number]` | Detailed status for one position, or all positions when the number is omitted |
| `/lp set <#\|position> [tp <pct\|price>] [sl <pct\|price>]` | Set per-position overrides, e.g. `/lp set 1 tp 20 sl 10` or `/lp set 1 tp 0.0001917` |
| `/lp set <tp\|sl> <#\|position> <pct\|price>` | Alternate order, e.g. `/lp set sl 1 20%` |
| `/set <tp\|sl> <#\|position> <pct\|price>` | Shorthand, e.g. `/set sl 1 20%` or `/set tp 1 0.0001917` |
| `/lp unset <#\|position>` | Remove an override; wallet/default thresholds apply |
| `/lp reload` | Reload wallets + overrides from disk |
| `/close <#\|position> [tp <pct\|price>] [sl <pct\|price>]` | Arm auto-close, e.g. `/close 1 tp 10 sl 20` or `/close 1 tp 0.0001917` |
| `/close list` | Show armed orders, attempts, next retry, last error |
| `/close off <#\|position>` | Disarm an auto-close order |

## Alert format

```
🎯 LP TAKE PROFIT
TOKEN-SOL · main
PnL +24.30% ($312)
Bal $1.6k · deposit $1.3k · fees $42
Thresholds TP +20% / SL -10%
https://www.meteora.ag/dlmm/<pool>
```

Stop-loss uses `🛑 LP STOP LOSS` and out-of-range uses `⚠️ LP OUT OF RANGE` with a direction line (`price above range (100% quote)` or `price below range (100% base)`).

A near-range warning (`⚠️ LP NEAR RANGE EDGE`) fires when the active price comes within `lp.nearRangeWidthPct` percent of the range **width** from an edge, before the position goes out of range. Set it to `0` to disable.

Alerts repeat while the condition stays breached, at most once per cooldown window. TP/SL and out-of-range have independent cooldowns; near-range reuses `oorCooldownMs`.

## Status output

`/status 1` (or `/lp status 1`) returns a detailed snapshot of one position:

```
#1 · ANSEM-SOL · main
Status: OUT of range · below range (100% base)
PnL: -13.54% (-$198)
Bal: $1.2k · Deposit: $1.5k · Fees: $0 · Unclaimed: $0
Bins: -887…-840
Range price: 0.00123–0.00145 · now 0.00110
Age: 2.3d · Fee/TVL 24h: 12.40%
TP +10% (23.54 pts away) · SL -10% (breached)
Position: ANLrT…
Wallet: ELaHM…
https://www.meteora.ag/dlmm/<pool>
https://solscan.io/account/<position>
```

`/status` without a number prints every open position, separated by dividers.

## npm scripts

| Script | Description |
|---|---|
| `npm run test-lp` | One-shot dry run; prints detected positions + triggers |
| `npm run test-lp -- --send` | One-shot run that delivers due alerts |
| `npm run test-close` | Dry-run armed auto-close orders |
| `npm run test-close -- --execute` | Broadcast a close for orders currently in TP/SL |
| `npm run reset-lp` | Clear `lp-state.json` to re-arm cooldowns |

## Troubleshooting

| Symptom | Fix |
|---|---|
| `/lp` says tracker not running | Add wallets to `config/lp-wallets.json` and keep `lp.enabled=true` in `config/app.json`. |
| No positions detected | Check wallet addresses in `config/lp-wallets.json`; run `npm run test-lp`. |
| Alerts not repeating | Wait for `lp.alertCooldownMs`, or `npm run reset-lp`. |
| `Meteora rate-limited until …` | Lower `lp.maxRps`; queued calls resume after the reset window. |
| `config/lp-wallets.json ...` validation error | Fix the named entry (bad base58 address). |
| Override not applied | Run `/lp reload`, or restart; thresholds resolve from disk each tick. |
| Position number changed | Numbers are stable while open; a closed position frees its number for reuse. Run `/lp` before setting. |
| `/close` says executor not running | Set `LP_EXECUTOR_PRIVATE_KEY` in `.env`, keep `executor.enabled=true`, restart. |
| `/close` rejects wallet | The executor key must own the position (same wallet as `config/lp-wallets.json`). |
| Auto-close keeps retrying | Check `executor.rpcUrl`, `/close list` last error, the fee cap, and Jupiter route availability. |
| Auto-close marked done unexpectedly | The position was no longer detected for several ticks (likely closed manually). |
