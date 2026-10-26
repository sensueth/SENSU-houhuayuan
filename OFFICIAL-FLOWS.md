# Official bonding-curve buy/sell

Board trades:

- **FLAP / FOUR / GANG LaunchpadV2** → same paths as `aiwb buy/sell` (in-process engine).
- **GANG Soft / LaunchpadU / LaunchpadS** → official `@gangfun/cli` only (`lib/gang-cli.mjs`). No invented Soft calldata.

See `GANG-OFFICIAL.md`.

## FLAP Agent (`flap-agent`)

- **Detect**: `marketOf(addr)` — accepts **market** or **predictedToken** (…7777).
- **Buy (BNB quote)**: single tx `portal.buy(market, minShares)` with `value = BNB`.
  - Size via `quoteBuy(market, me, gross)`; shrink to `maxSharesPerWallet` (2%).
- **Buy (other quote)**: PCS V2 `BNB→quote` → `approve(quote→market)` → `buyWithQuote`.
- **Sell**: `portal.sellBps(market, bps, minOut)`; non-BNB quote then PCS back to BNB.
- **Gate**: portal requires Binance Agent ID on `msg.sender`.
- **After launch**: `aiwb claim <market>` then trade launched token on Flap/Pancake.

## GANG LaunchpadV2 / stocks (`gang` aiwb handler)

- **Detect**: `curves(token)` on **LaunchpadV2** `0x1B8F3f69DFa0a7F63d308C7EB0Fd38D8b099966E` only.
- **Buy (WBNB quote)**: wrap BNB → approve WBNB → `buy(coin, quoteAmt, minCoins)`.
- **Buy (other quote)**: if the wallet holds the quote, approve + `buy` (no hop). If not, spend USDT (or another configured stable) via Pancake V2 **direct** `stable→quote`, then approve + `buy`. Native BNB is not used for that hop. A hop whose quote out is worth under 50% of the spend is not broadcast. Cap: `walletRoom` 1%.
- **Sell**: approve coin → `sell`; Binance often rates 3/5 → **App confirm** if abnormal=confirm.
- **Graduated WBNB**: pancake handler; other quotes: two-hop PCS.

## GANG Soft / LaunchpadU / LaunchpadS (`gang` CLI on board)

- **Detect**: official `resolvePad` order `V2 → Soft → U → S` (`lib/gang-cli.mjs`).
- **Buy gate**: `gang quote --token --bnb` (aiwb check skipped — V2-only).
- **Buy/Sell**: `gang buy|sell` preview → auto `gang execute --request-id` (approve/wrap steps loop).
- **Dry**: `dry:true` on `/api/trade` → preview only, no execute.
- **App**: sell often `pendingConfirmation` → UI 「待 App 确认」.
- Soft: `--bnb` = native BNB. U/S/V2 CLI flag `--bnb` = **quote ERC-20 amount**.

## FOUR Agent (`four-agent`)

- **Detect**: `tokens(token)` record with agent template `1778027615735`; `tokenPhase == curve`.
- **Buy**: `core.buy(token, funds, minTokens)` with `value = BNB`. Quote via `eth_simulateV1`.
- **Sell**: approve → `core.sell` (no Agent ID required for sell).
- **Graduated** (`phase == pool`): pancake handler.

## Board latency path

1. V2/FLAP/FOUR first buy: in-process `check` — required; cache 30m + live `info`.
2. Soft/U/S first buy: `gang quote` gate → buy → execute.
3. Prefer absolute amount (no MC wait). Flap `tradeCa` = market.
4. RPC ping before aiwb trades; `GANG_RPC_URL` for gang CLI (defaults to first `BSC_RPC`).
