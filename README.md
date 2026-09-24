# tokenWatcher

A small long-running bot that watches Solana token prices via the [GMGN OpenAPI](https://gmgn.ai/ai) and sends **Telegram alerts** when a token crosses your target price. Manage everything from Telegram — add mints, set targets, and list what's being tracked — all in one process.

## Quick start

From clone to your first alert in ~2 minutes.

**1. Install**

```bash
cd tokenWatcher
npm install
```

**2. Get a Telegram chat ID** — open Telegram, message your bot and send `/start`, then:

```bash
cp .env.example .env
# fill in GMGN_API_KEY and TELEGRAM_BOT_TOKEN in .env first, then:
npm run get-chat-id
```

Copy the printed `chat_id` into `TELEGRAM_CHAT_ID` in `.env`.

**3. Verify the pipe**

```bash
npm run test-alert
```

You should get a test message on Telegram.

**4. Add a mint and run**

```bash
npm run build
npm start          # or: npm run dev
```

Then send your bot:

```
/add 7ga6rtE9qSb3wdEiDCpTu2kHqoGVfT52jD8ign1rYTvx 2.75 above
```

It now polls every 15s and sends **5 Telegram pings** the moment xHYPE crosses $2.75. Send `/list` anytime to see what's tracked.

> Run it in the background with pm2 instead of `npm start`:
> ```bash
> pm2 start dist/index.js --name tokenWatcher --cwd "$(pwd)"
> pm2 save
> ```

## Features

- Polls GMGN every **15 seconds** (configurable) for the live USD price of every tracked mint.
- Sends **5 Telegram messages** (configurable) the moment a target is hit.
- **Fire-once** per target — persisted to `state.json`, so restarts don't re-alert.
- **Telegram command interface** to add / remove / list mints live, with no restart.
- Tracks **multiple mints together** in a single poll loop.
- Auto-resolves a mint's symbol via GMGN when you add it (and rejects invalid mints).
- Long-poll command listener restricted to your chat ID.
- Runs under **pm2** with auto-restart and (optional) boot persistence.

## How it works

```
                 ┌───────────────────────────────┐
  every 15s      │  price loop                    │
  ───────────►   │  GET openapi.gmgn.ai/v1/       │
                 │      token/info?chain=sol      │
                 └──────────────┬────────────────┘
                                │ price per mint
                                ▼
                 ┌───────────────────────────────┐
                 │  guards:                      │
                 │  hit?  +  not already fired?  │
                 └──────────────┬────────────────┘
                                │ yes
                                ▼
                 ┌───────────────────────────────┐
                 │  send 5 Telegram pings        │
                 │  persist fired → state.json   │
                 └───────────────────────────────┘

  long-poll       ┌───────────────────────────────┐
  ───────────►    │  command loop (getUpdates)    │
                  │  /add /list /remove /clear    │
                  └──────────────┬────────────────┘
                                 │ mutates
                                 ▼
                        config/watchlist.json
                                 │ read every tick
                                 └──────────► price loop
```

Only messages from the chat in `TELEGRAM_CHAT_ID` are accepted; all others are ignored.

## Prerequisites

- Node.js **18+** (built and tested on Node 24)
- A GMGN API key — apply at <https://gmgn.ai/ai>
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))
- Optional: [pm2](https://pm2.keymetrics.io/) for running in the background

## Installation

```bash
cd tokenWatcher
npm install
npm run build
```

## Configuration

### `.env`

Create `.env` in the project root (copy from `.env.example`):

```dotenv
# GMGN OpenAPI key (https://gmgn.ai/ai)
GMGN_API_KEY=gmgn_xxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Telegram bot token and destination chat
TELEGRAM_BOT_TOKEN=123456789:AA...your_bot_token
TELEGRAM_CHAT_ID=123456789

# Polling / alerting
POLL_INTERVAL_MS=15000   # how often to check prices
PING_COUNT=5             # messages sent per target hit
PING_DELAY_MS=1000       # gap between those messages
```

> **Getting `TELEGRAM_CHAT_ID`:** message your bot (`/start`), then run `npm run get-chat-id`. It prints every chat that has talked to the bot. Paste the numeric `chat_id` into `.env`.

> **Secrets:** `.env` is gitignored. Keep permissions tight: `chmod 600 .env`.

### `config/watchlist.json`

The initial list of mints/targets. Managed automatically by the `/add`, `/remove`, and `/clear` commands, but you can also edit it by hand (then send `/reload` or restart).

```json
[
  {
    "address": "7ga6rtE9qSb3wdEiDCpTu2kHqoGVfT52jD8ign1rYTvx",
    "symbol": "xHYPE",
    "target": {
      "price": 2.75,
      "direction": "above"
    },
    "pings": 5
  }
]
```

| Field | Required | Description |
|---|---|---|
| `address` | yes | Solana mint (base58, 32–44 chars) |
| `symbol` | no | Label shown in alerts. Auto-filled when added via Telegram. |
| `target.price` | yes | Target USD price (positive number) |
| `target.direction` | yes | `"above"` (alert when price ≥ target) or `"below"` (alert when price ≤ target) |
| `pings` | no | Messages to send on hit. Defaults to `PING_COUNT`. |

## Telegram commands

Send these to your bot. They are also registered as the bot's **command menu**, so typing `/` in the message bar shows an autocomplete list — re-register with `npm run set-commands` if it ever looks stale:

| Command | Description |
|---|---|
| `/add <mint> <target> [above\|below]` | Start tracking a mint. Direction defaults to `above`. The mint is verified against GMGN and its symbol auto-filled. |
| `/list` | Show every tracked mint with its live price and status (`✅ HIT` / `⏳ waiting`). |
| `/remove <mint>` | Stop tracking a mint (also clears its fired state). |
| `/clear` | Stop tracking everything. |
| `/reload` | Reload `config/watchlist.json` from disk (after manual edits). |
| `/help` | Show the command list. |
| `/start` | Same as `/help`. |

Direction aliases: `above` / `over` / `>` and `below` / `under` / `<`.

### Examples

```
/add 7ga6rtE9qSb3wdEiDCpTu2kHqoGVfT52jD8ign1rYTvx 2.75 above
/add So11111111111111111111111111111111111111112 200 above
/add EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v 0.95 below
/list
/remove So11111111111111111111111111111111111111112
/clear
```

Example `/add` reply:

```
✅ Now tracking xHYPE
7ga6rtE9qSb3wdEiDCpTu2kHqoGVfT52jD8ign1rYTvx
Target: above $2.7500
Current: $2.6683
1 mint(s) tracked together.
```

## Alert message

When a target is hit, you receive `pings` messages that look like this:

```
🚨 TARGET HIT (1/5)
xHYPE  $2.7512
Target: above $2.7500  (+0.04%)
Solana · 24/09/2026, 13:00:00
https://gmgn.ai/sol/token/7ga6rtE9qSb3wdEiDCpTu2kHqoGVfT52jD8ign1rYTvx
```

Each target fires **once**. To re-arm it, use `/remove` then `/add` again, or reset all fired state with `npm run reset`.

## Running

### Foreground (development)

```bash
npm run dev        # tsx watch, auto-reloads on code changes
```

or run the compiled build:

```bash
npm run build
npm start
```

### Background with pm2 (recommended)

```bash
npm run build
pm2 start dist/index.js --name tokenWatcher --cwd /absolute/path/to/tokenWatcher
pm2 save
```

Enable boot persistence (run once, needs sudo — copy the command pm2 prints):

```bash
pm2 startup
```

Useful pm2 commands:

```bash
pm2 logs tokenWatcher      # live logs
pm2 status                 # process status
pm2 restart tokenWatcher   # restart
pm2 stop tokenWatcher      # stop
pm2 delete tokenWatcher    # remove
```

> After editing `.env`, restart with env reload: `pm2 restart tokenWatcher --update-env`.

## npm scripts

| Script | Description |
|---|---|
| `npm run dev` | Run in watch mode via `tsx` |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled bot (`node dist/index.js`) |
| `npm run typecheck` | Type-check without emitting |
| `npm run get-chat-id` | Print chats that have messaged the bot (to find `TELEGRAM_CHAT_ID`) |
| `npm run test-alert` | Send one test message to `TELEGRAM_CHAT_ID` to verify the pipe |
| `npm run set-commands` | Register the `/` command menu with Telegram |
| `npm run reset` | Clear all fired-target state (`state.json`) so targets can fire again |

## Project structure

```
tokenWatcher/
├── config/
│   └── watchlist.json     # tracked mints + targets (managed at runtime)
├── scripts/
│   ├── get-chat-id.ts     # discover your Telegram chat_id
│   ├── reset-state.ts     # clear fired state
│   ├── set-commands.ts    # register the / command menu
│   └── test-alert.ts      # send a test alert
├── src/
│   ├── index.ts           # entry: price loop + command loop
│   ├── config.ts          # env + watchlist parsing/validation
│   ├── store.ts           # WatchStore (load/add/remove/clear, persist)
│   ├── commands.ts        # Telegram command handlers
│   ├── gmgn.ts            # GMGN OpenAPI client (price fetch + retries)
│   ├── telegram.ts        # sendMessage + getUpdates long-poll
│   ├── alerts.ts          # hit detection + message formatting
│   ├── state.ts           # fired-target persistence
│   └── types.ts           # shared types
├── state.json             # runtime fired state (gitignored)
├── .env                   # secrets (gitignored)
└── .env.example
```

## GMGN API notes

- Endpoint: `GET https://openapi.gmgn.ai/v1/token/info?chain=sol&address=<mint>&timestamp=<unix>&client_id=<uuid>`
- Auth: `X-APIKEY` header. Current price is read from `data.price.price`.
- Rate limiting: requests are retried with backoff on `429`/`5xx`. The default 15s poll for a handful of mints stays well within limits.
- **IPv4 only:** if you get `401`/`403` with valid credentials, your machine may be egressing over IPv6. Disable IPv6 on the network interface.

## Troubleshooting

| Symptom | Fix |
|---|---|
| No alerts arriving | Run `npm run test-alert`. If nothing arrives, check `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and that you've sent `/start` to the bot. |
| Bot doesn't respond to commands | Make sure the bot is running (`pm2 status`) and you're messaging from the chat in `TELEGRAM_CHAT_ID`. Only that chat is accepted. |
| `/add` says "Could not fetch mint" | The address is wrong, not a Solana mint, or GMGN had no price. Double-check the mint address. |
| `401` / `403` from GMGN | Disable IPv6, or verify `GMGN_API_KEY`. |
| Target never fires | Check direction: `above` needs price ≥ target, `below` needs price ≤ target. `/list` shows status. |
| Target already fired | It fires once. Use `/remove` + `/add`, or `npm run reset`. |
| `get-chat-id` prints nothing | Message the bot first (send `/start`), then re-run. |

## Security

- `GMGN_API_KEY` and `TELEGRAM_BOT_TOKEN` live in `.env` — never commit it (gitignored). Run `chmod 600 .env`.
- The command listener only accepts messages from `TELEGRAM_CHAT_ID`; everyone else is ignored.
- This bot is **read-only**: it fetches prices and sends messages. It never places trades and holds no wallet keys.

## Disclaimer

Market data is provided by GMGN and may be delayed or inaccurate. This tool is for informational alerts only and is not financial advice. Use at your own risk.
