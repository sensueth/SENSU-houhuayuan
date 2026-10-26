# GANG 官方流程（学习笔记 · gang-launchpad + @gangfun/cli）

来源：https://github.com/gangfun/gang-launchpad · skill `@gangfun/cli` ≥0.4.1 · 本机对照 2026-10-25 Asia/Shanghai

## 一句话

- **新发币 / stocks 主盘 = LaunchpadV2 only**
- **Soft / LaunchpadU / LaunchpadS = 存量 archive**：官方 CLI 仍可 **buy / sell / claim**，**禁止 create**
- 内盘仅 **Binance Agentic Wallet + .ai Agent ID**；每钱包曲线仓位硬顶 **1%**；买卖手续费 **1%**
- V2 毕业 ≈ **15 BNB**；Soft 链上仍约 **20 BNB**
- 毕业前不可转账，只能曲线买卖；毕业后走 Pancake `pair`

## 主网合约

| 名称 | 地址 | 角色 |
|---|---|---|
| **LaunchpadV2** | `0x1B8F3f69DFa0a7F63d308C7EB0Fd38D8b099966E` | 当前发币 + stocks 曲线（aiwb / 本看板支持） |
| MigratorV2 | `0x2D54351657647824c92a36c309A8ed40715968F6` | V2 毕业迁移 |
| QuoteRegistry | `0x053C2868e54921afEd7742bbb4c4fDA99a12060D` | 非 WBNB quote 毕业额 |
| Soft (archive) | `0x4E6f13c8A453c1b8b4E20b590082bb233a5b80d7` | 旧 BNB-payable 曲线 |
| **LaunchpadU** | `0xF81C4E51c48466c6025B0165b1Ea0F6978c712cb` | 旧 U 盘（V2-ABI 形状，quote ERC-20） |
| LaunchpadS | `0x60aee38576035E757deD30fF8db8A8DA476430C1` | 旧 S 盘 |
| GANG | `0x0c6302401aa5325C2E36F170f52C00B1d220B405` | 平台币 |
| WBNB | `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c` | Soft 报价 / V2 默认 quote |

官方 CLI `resolvePad(token)` 顺序探测：`V2 → Soft → U → S`，看 `curves(token).creator != 0`。

## Soft vs U/S vs V2

| | Soft | LaunchpadU / S | LaunchpadV2 (stocks) |
|---|---|---|---|
| Create | ❌ CLI 拒绝 | ❌ | ✅ `gang create` |
| Buy/Sell 存量 | ✅ payable BNB | ✅ quote ERC-20 | ✅ quote ERC-20 |
| 毕业目标 | ~20 BNB | 按 curve `gradAmt` | ~15 BNB |
| 报价 | 原生 BNB | quote token（常为 GANG / BNCB / …） | 同左；`--bnb` 旗标 = **quote 数量** |
| aiwb detect | ❌ | ❌ | ✅ V2 `curves()` |
| 本看板交易 | ✅ gang CLI | ✅ gang CLI | ✅ aiwb |

## 官方 CLI 命令（English）

```bash
npm i -g @gangfun/cli@latest   # 或 github:gangfun/cli
gang preflight                 # Agent ID / DevMode / tradeAllTokens
gang hot | new | near-grad | watch [<addr>]
gang token --token 0x…
gang quote --token 0x… --bnb 0.05
gang buy  --token 0x… --bnb 0.05   # → show → gang execute --request-id …
gang sell --token 0x… --all|--amount N
gang execute --request-id …
gang create --name … --symbol … [--logo …] [--taxed] [--quote 0x… --ref-pool 0x…]
gang upload-logo --file ./a.png
gang tx --hash 0x…
```

硬规则：**preview → 用户确认 → execute**。卖出常需 App 确认（`pendingConfirmation` / `requireConfirmation`）。

## 买卖步骤（V2 / U / S）

1. `gang token` 确认 `pad`（`v2`|`soft`|`u`|`s`）与 `graduated`
2. Buy：可能先 `wrap-bnb` → `approve-quote` → `buy`；每步 execute 后再跑同一条 buy
3. Sell：可能先 token `approve` → `sell`；然后 `gang execute`
4. 已毕业：用 `pair` 走 Pancake（看板 / aiwb pancake handler）

Soft：`buy` 直接 `value=BNB`；`sell` 回 BNB。

## 与本看板 / aiwb 的映射（2026-10-25 接线后）

| 能力 | 官方 `gang` CLI | aiwb `gang` handler | 看板 |
|---|---|---|---|
| Detect V2 stocks | ✅ | ✅ LaunchpadV2 only | ✅ aiwb 快路径 |
| Detect Soft / U / S | ✅ `resolvePad` | ❌ | ✅ `lib/gang-cli.mjs` → `tradeable` + pad 标签 |
| Buy/Sell Soft/U/S | ✅ buy/sell → execute | ❌ | ✅ `/api/trade` 调官方 CLI（不发明 Soft 引擎） |
| Buy gate Soft/U/S | `gang quote` | aiwb check 不适用 | ✅ quote 门禁；跳过 aiwb check |
| Create | V2 only | — | — |

### 路由表

| 链上 pad | 看板 `tradePath` | 下单 |
|---|---|---|
| `v2` | `aiwb` | in-process aiwb（check 缓存 → buy/sell） |
| `u` / `s` / `soft` | `gang-cli` | `gang quote?` → `gang buy\|sell` → `gang execute` |
| graduated / pancake GANG | `aiwb` | pancake / aiwb dex |

### 四个 LaunchpadU 持仓（实测 pad=`u`）

| 符号 | CA | 看板 |
|---|---|---|
| 帮派 | `0xf0ead829802f25df9b3aefd58d543d3185b0cc41` | 可卖 · pad **U** · gang-cli |
| GSTOCK | `0x4a8fb3757678214aea93e5903732c65ea260caa9` | 同上 |
| GDOG | `0x990b243a544bc334f35a764a85038ecafc43b663` | 同上 |
| .AI | `0xded2ba684462022dc10c704cf20ba22c52eabf9e` | 同上 |

indexer 可能把 U 标成 `track=stocks/v2`；`gateGangPads` 用 `resolvePad` 纠正。

### 看板卖出 / App 确认 UX

1. `POST /api/trade` `{ side:"sell", ca, amount:"50%", platform:"gang", dry?:true }`
2. 服务端 `gang sell --amount| --all` 拿 `requestId`
3. `dry:true` → **只预览**，返回 preview，**不** execute
4. 实盘 → `gang execute --request-id`；若 `pendingConfirmation` / `requireConfirmation` → JSON `needsAppConfirm:true`，前端 toast **待 App 确认**
5. 用户在币安 App 确认；可选 `gang tx --hash`

Buy Soft/U/S：先 `gang quote`（失败则拒买）；再 buy→execute。U/S 的 `--bnb` 按官方语义是 **quote 数量**（非一定是原生 BNB）。

## 环境变量

`GANG_LAUNCHPAD`（默认 V2）、`GANG_RPC_URL`、`GANG_API`（默认 https://gang.fun/api）、`GANG_LOGO_API`

## Windows 备注

`@gangfun/cli` 用 `execFileSync('baw')`；在部分 Windows + npm shim 下会 `ENOENT`。本机可将 `baw.js` 改为经 `cmd.exe /c baw.cmd` 调用（已在 `%APPDATA%\npm\node_modules\@gangfun\cli\src\baw.js` 做过兼容；升级 CLI 可能覆盖）。
