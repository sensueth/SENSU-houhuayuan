# AI WALLET CURVE

Local **AI-wallet-only** bonding-curve board for Binance Agentic Wallet platforms:

- **FLAP** agent curve (`FLAP_AGENT`) — trade CA = market (or predictedToken)
- **GANG** LaunchpadV2 / stocks — in-process **aiwb**
- **GANG Soft / LaunchpadU / LaunchpadS** — official **`gang` CLI** (`@gangfun/cli`) quote → buy/sell → execute
- **FOUR** agent template (`1778027615735`)

FLAP/FOUR **near（即将打满）** and **graduated（已开盘）** are backfilled from **GMGN trenches** merged with on-chain agent discovery; near gate uses GMGN `market_cap` (≥ `$NEAR_MIN_MC_USD`, default $10K) or progress ≥ `NEAR_MIN_PCT`. **FOUR 内盘** only keeps agent tags (`fourmeme_agent` / `four_xmode_agent` / `bn_fourmeme`) — classic `fourmeme` curve is not aiwb-tradeable and is filtered out; graduated `fourmeme`/`openfour` route via pancake. **FLAP** keeps classic portal + agent (aiwb `flap` / `flap-agent` / pancake). Cards show **DEV** Agent ID / `.ai` handle (from gang `creatorHandle`) to the right of pad tags. Requires `GMGN_API_KEY` in `%USERPROFILE%\.config\gmgn\.env` (loaded by `start.ps1`). Soft/内盘 curve rows are **shown by default** (trade via gang CLI). Set `GANG_INCLUDE_SOFT=0` to hide them from lists (still tradeable in holdings).

## Run (Windows)

```powershell
$env:HTTP_PROXY='http://127.0.0.1:18081'
$env:HTTPS_PROXY='http://127.0.0.1:18081'
$env:NODE_USE_ENV_PROXY='1'
$env:BOARD_KEY='YOUR_BOARD_KEY'
$env:MAIN_WALLET='0xYOUR_MAIN_WALLET_ADDRESS'
cd "$env:LOCALAPPDATA\ai-wallet-curve-board"
# or: .\start.ps1
node server.mjs
```

Open `http://127.0.0.1:3847/?k=YOUR_BOARD_KEY`.

Requires global `aiwb`, `baw`, and `@gangfun/cli` (`gang`) on PATH. Proxy env is required for baw/gang on this host.

## Routing

| Pad | Detect | Buy / Sell on board |
|-----|--------|---------------------|
| LaunchpadV2 / stocks | aiwb `curves()` on V2 | aiwb engine (check cache → buy/sell) |
| Pancake GANG / graduated V2 | aiwb / pancake | aiwb |
| Soft / LaunchpadU / LaunchpadS | `gang` `resolvePad` / `gang token` | `gang quote` (buy gate) → `gang buy\|sell` → `gang execute` |
| FLAP / FOUR | aiwb handlers | aiwb |

- First **V2/FLAP/FOUR** buy of a CA: `aiwb check` (cached 30 min on pass).
- First **Soft/U/S** buy: **`gang quote`** as safety gate (aiwb check is V2-only and would fail — skipped on purpose).
- Sell Soft/U/S often returns `requireConfirmation` / `pendingConfirmation` → toast **待 App 确认**; confirm in Binance App.
- `POST /api/trade` with `"dry": true` → gang preview only (**no** execute).

## Tradeable vs not

| Platform | Curve (内盘) | Graduated |
|----------|--------------|-----------|
| FLAP agent | yes (`aiwb` flap-agent) | claim then flap/pancake |
| GANG v2/stocks | yes (`aiwb` gang) | gang dex / pancake |
| GANG Soft/U/S | yes (`gang` CLI on board) | pancake if graduated |
| FOUR agent | yes (`aiwb` four-agent) | pancake |

Holdings chips label pad **U / S / soft / v2**. Amounts come only from baw/chain/journal/`gang token` — never invented.

## API

All JSON routes need header `x-board-key` or `?k=`.

- `GET /api/board` → `{ new, near, graduated, updatedAt, platforms, meta }`
- `GET /api/health` → wallet / rpc / `gangCli`
- `GET|POST /api/check?ca=0x…` → safety check (`aiwb check`) — V2 path
- `POST /api/trade` body `{ side, ca|tradeCa, amount, platform?, track?, gangPad?, tradePath?, dry? }`
- `GET /api/holdings` → AI wallet positions
- `GET /api/kline?ca=0x…&resolution=1m&hours=2&platform=gang|flap|four` → OHLCV; **GANG** prefers official `gang.fun/api/.../candles`, else GMGN; FLAP/FOUR have no official K API (GMGN only). On GMGN 429 serves stale cache + Chinese error. Meta `source`: `GMGN`/`GANG`.

Env: `TRADE_TIMEOUT_MS`, `CHECK_TTL_MS`, `BSC_RPC`, `GANG_RPC_URL`, `GANG_INCLUDE_SOFT=1`, `HOLDINGS_TTL_MS`, `NEAR_MIN_MC_USD` (default 10000), `NEAR_MIN_PCT`.

See `GANG-OFFICIAL.md` / `OFFICIAL-FLOWS.md`.

## 买后自动卖出授权

真买单成功后，板子会自动开该币的 **sell approve**（不真卖），下次卖可跳过授权步。U/S/Soft 走 `gang` 预览若已是 `sell` 步则跳过；若要 App 确认会在 toast 提示。

## Holdings value / PnL

`/api/holdings` enriches each item (never invents numbers):

| field | meaning |
|-------|---------|
| `valueUsd` / `valueBnb` | baw USD, else board `priceUsd×amount`, else null |
| `costBnb` / `costUsd` / `costKnown` / `costSource` | `aiwb` journal first; else `baw wallet tx-history` buys (BNB/WBNB/BNCB/NVDAB/GANG→token); null if unknown |
| `pnlUsd` / `pnlBnb` / `pnlPct` | only when both value and cost known |
| `totalValueUsd` | sum of known values (meta notes how many lack a quote) |

Cash (BNB / quote chips) show value only — no fake PnL.

