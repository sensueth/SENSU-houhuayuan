/**
 * AI wallet holdings for the curve board.
 * Sources (no invented numbers):
 *  1) `baw wallet balance` — ERC20 / BNB with USD (may hide dust < $0.01)
 *  2) On-chain balanceOf / Flap sharesOf for coins currently on the board
 *  3) Optional aiwb journal/pnl tokens still held
 * Value / PnL enrichment:
 *  - valueUsd: baw USD, else board priceUsd×amount, else null
 *  - cost*: aiwb journal avgCostBnb×amount when known; else baw tx-history
 *    buys (BNB/WBNB/BNCB/NVDAB/GANG spent → token received); never invented
 *  - pnl*: only when both value and cost are known
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { resolvePad, usesGangCli } from './gang-cli.mjs';

const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const ZERO = '0x0000000000000000000000000000000000000000';
const HOLDINGS_TTL_MS = Number(process.env.HOLDINGS_TTL_MS || 45_000);
const MAX_BOARD_PROBE = Number(process.env.HOLDINGS_MAX_PROBE || 80);
const CONCURRENCY = 8;

function short(a) {
  if (!a || a.length < 12) return a || '';
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function fmtAmt(n, maxFrac = 4) {
  if (n == null || !Number.isFinite(n)) return null;
  if (n === 0) return '0';
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return n.toFixed(2);
  if (n >= 1) return n.toFixed(Math.min(4, maxFrac));
  if (n >= 1e-4) return n.toFixed(6);
  return n.toExponential(2);
}

function fromWei(wei, decimals = 18) {
  const s = String(wei);
  if (!/^\d+$/.test(s)) return 0;
  const d = Number(decimals);
  if (s.length <= d) return Number(`0.${s.padStart(d, '0')}`);
  return Number(`${s.slice(0, s.length - d)}.${s.slice(s.length - d)}`);
}

const GANG_PLATFORM_TOKEN = '0x0c6302401aa5325c2e36f170f52c00b1d220b405';
const NOT_ON_GANG = 'Not on GANG pads (V2/Soft/U/S) and not Pancake GANG — cannot sell via board';

function applyTradeability(item) {
  // Flap pre-grad: trade CA must be the market (shares), not predicted token.
  if (item.platform === 'flap' && item.market && !item.graduated) {
    item.tradeCa = item.market;
  }
  return item;
}

/**
 * Route GANG holdings:
 *  - LaunchpadV2 / pancake GANG → aiwb (tradePath=aiwb)
 *  - Soft / LaunchpadU / LaunchpadS → official gang CLI (tradePath=gang-cli, tradeable)
 */
async function gateGangPads(items, tradeEngine) {
  if (!items?.length) return items;
  const targets = items.filter(it => {
    if (it.platform === 'gang') return true;
    // baw may list archive tokens without platform if not on current board
    const addr = String(it.address || '').toLowerCase();
    return addr && addr !== 'bnb' && addr !== 'bnb' && it.platform == null;
  });
  // Only probe likely GANG / unknown chips (skip native/quote)
  const probe = targets.filter(it => {
    const addr = String(it.address || '').toLowerCase();
    if (!addr || addr === 'bnb' || it.platform === 'native' || it.platform === 'quote') return false;
    if (it.platform && it.platform !== 'gang') return false;
    return true;
  });
  await mapPool(probe, CONCURRENCY, async (it) => {
    const addr = String(it.address || '').toLowerCase();
    if (!addr || addr === 'bnb') return;
    if (addr === GANG_PLATFORM_TOKEN) {
      it.platform = it.platform || 'gang';
      it.gangPhase = 'pancake';
      it.gangPad = 'pancake';
      it.tradePath = 'aiwb';
      it.tradeable = true;
      it.untradeableReason = null;
      return;
    }
    // Prefer aiwb V2 detect when engine available
    if (tradeEngine?.detectFast) {
      const info = await tradeEngine.detectFast(addr, 'gang').catch(() => null);
      if (info?.platform === 'gang' && (info.phase === 'curve' || info.phase === 'dex')) {
        it.platform = 'gang';
        it.gangPhase = info.phase;
        it.gangPad = 'v2';
        it.tradePath = 'aiwb';
        if (info.quoteSymbol) it.quote = info.quoteSymbol;
        it.tradeCa = addr;
        it.tradeable = true;
        it.untradeableReason = null;
        return;
      }
      if (info?.platform === 'pancake-v2') {
        it.platform = it.platform || 'gang';
        it.gangPhase = 'pancake';
        it.gangPad = 'pancake';
        it.tradePath = 'aiwb';
        it.tradeable = true;
        it.untradeableReason = null;
        return;
      }
    }
    // Soft indexer hint or resolvePad for U/S/Soft archive
    if (it.track === 'soft' && !it.graduated) {
      it.platform = 'gang';
      it.gangPad = 'soft';
      it.tradePath = 'gang-cli';
      it.tradeable = true;
      it.untradeableReason = null;
      it.gangPhase = 'curve';
      return;
    }
    try {
      const padInfo = await resolvePad(addr);
      if (padInfo?.pad && usesGangCli(padInfo.pad)) {
        it.platform = 'gang';
        it.gangPad = padInfo.pad;
        it.tradePath = 'gang-cli';
        it.tradeable = !padInfo.graduated; // graduated → pancake elsewhere
        it.gangPhase = padInfo.graduated ? 'dex' : 'curve';
        it.untradeableReason = padInfo.graduated
          ? 'Graduated — sell on Pancake (pair); board gang-cli is curve-only'
          : null;
        if (padInfo.graduated) {
          // still allow aiwb/pancake attempt
          it.tradeable = true;
          it.tradePath = 'aiwb';
          it.gangPad = padInfo.pad;
          it.untradeableReason = null;
        }
        return;
      }
      if (padInfo?.pad === 'v2') {
        it.platform = 'gang';
        it.gangPad = 'v2';
        it.tradePath = 'aiwb';
        it.tradeable = true;
        it.untradeableReason = null;
        it.gangPhase = padInfo.graduated ? 'dex' : 'curve';
        return;
      }
    } catch {
      // not a known GANG pad
    }
    if (it.platform === 'gang') {
      it.tradeable = false;
      it.untradeableReason = NOT_ON_GANG;
      it.gangPhase = null;
      it.tradePath = null;
    }
  });
  return items;
}

/** Prefer board card name/symbol (already official-swapped for GANG) over on-chain/baw. */
function overlayBoardDisplay(it, boardHit) {
  if (!it || !boardHit) return it;
  if (boardHit.name) it.name = boardHit.name;
  if (boardHit.symbol) it.symbol = boardHit.symbol;
  if (boardHit.logoUrl && !it.logoUrl) it.logoUrl = boardHit.logoUrl;
  return it;
}


/** Fill missing logos via gang.fun /api/tokens/:ca (board soft/v2 often omit logoUrl). */

const KNOWN_HOLD_LOGOS = {
  bnb: "https://assets.coingecko.com/coins/images/825/small/bnb-icon2_2x.png",
  "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c": "https://assets.coingecko.com/coins/images/825/small/bnb-icon2_2x.png", // WBNB
  "0x55d398326f99059ff775485246999027b3197955": "https://assets.coingecko.com/coins/images/325/small/Tether.png", // USDT BSC
  "0x4902c5ebc598265ed2212b559b042de8a5eeec3f": null, // BNCB — filled if gang returns
  "0xce24439f2d9c6a2289f741120fe202248b666666": null, // U
};

function knownHoldLogo(it) {
  if (!it) return null;
  if (String(it.address || "").toUpperCase() === "BNB" || it.platform === "native") return KNOWN_HOLD_LOGOS.bnb;
  const a = String(it.address || "").toLowerCase();
  return KNOWN_HOLD_LOGOS[a] || null;
}

async function enrichHoldLogos(itemsOut, { concurrency = 6, limit = 40 } = {}) {
  const need = itemsOut.filter(it => {
    if (it.logoUrl) return false;
    const a = String(it.address || '');
    return /^0x[a-fA-F0-9]{40}$/.test(a);
  }).slice(0, limit);
  if (!need.length) return;
  const API = (process.env.GANG_API || 'https://gang.fun/api').replace(/\/+$/, '');
  let i = 0;
  async function one(it) {
    const ca = String(it.address).toLowerCase();
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 8000);
      const r = await fetch(`${API}/tokens/${ca}`, { signal: ctl.signal, headers: { accept: 'application/json' } });
      clearTimeout(t);
      if (!r.ok) return;
      const j = await r.json();
      let logo = j?.logoUrl || j?.logo || j?.imageUrl || null;
      if (logo && String(logo).startsWith('/')) logo = `https://gang.fun${logo}`;
      if (logo) it.logoUrl = logo;
    } catch { /* ignore */ }
  }
  const workers = Array.from({ length: Math.min(concurrency, need.length) }, async () => {
    while (i < need.length) {
      const it = need[i++];
      await one(it);
    }
  });
  await Promise.all(workers);
}

function collectBoardCandidates(board) {

  const map = new Map();
  if (!board) return map;
  for (const col of ['new', 'near', 'graduated']) {
    for (const c of board[col] || []) {
      const addr = (c.address || '').toLowerCase();
      const tradeCa = (c.tradeCa || addr).toLowerCase();
      const market = (c.market || '').toLowerCase() || null;
      if (!addr && !tradeCa) continue;
      const key = (c.platform === 'flap' && market) ? market : (tradeCa || addr);
      if (!map.has(key)) {
        map.set(key, {
          platform: c.platform,
          address: addr || tradeCa,
          tradeCa: tradeCa || addr,
          market,
          symbol: c.symbol,
          name: c.name,
          track: c.track || null,
          graduated: !!c.graduated,
          tradeable: c.tradeable !== false,
          untradeableReason: c.untradeableReason || null,
          quote: c.quote || 'BNB',
          gangPad: c.gangPad || c.extra?.gangPad || null,
          tradePath: c.tradePath || c.extra?.tradePath || null,
          logoUrl: c.logoUrl || c.logo || c.imageUrl || null,
          priceUsd: c.priceUsd != null && Number.isFinite(Number(c.priceUsd)) ? Number(c.priceUsd) : null,
          fdvUsd: c.fdvUsd != null && Number.isFinite(Number(c.fdvUsd)) ? Number(c.fdvUsd) : null,
          mcUsd: c.mcUsd != null && Number.isFinite(Number(c.mcUsd)) ? Number(c.mcUsd) : null,
        });
      }
    }
  }
  return map;
}

async function readErc20Bal(rpc, token, owner) {
  try {
    const bal = await rpc.read(token, 'balanceOf(address)', [owner], ['uint256']);
    return bal;
  } catch {
    return 0n;
  }
}

async function readFlapShares(rpc, market, owner) {
  try {
    return await rpc.read(market, 'sharesOf(address)', [owner], ['uint256']);
  } catch {
    return 0n;
  }
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}


function finiteOrNull(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : null;
}

function roundMoney(n, digits = 4) {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

const NATIVE_LC = NATIVE.toLowerCase();
const WBNB_LC = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
/** Spend-side quotes used to buy curve tokens (not cost targets themselves). */
const SPEND_CA = new Set([
  NATIVE_LC,
  WBNB_LC,
  '0x4902c5ebc598265ed2212b559b042de8a5eeec3f', // BNCB
  '0x02fca66c1d1afb4e2a7884261eb00f63598a7436', // NVDAB
  '0x0c6302401aa5325c2e36f170f52c00b1d220b405', // GANG
]);
const SPEND_SYM = new Set(['BNB', 'WBNB', 'BNCB', 'NVDAB', 'GANG']);

const TX_COST_TTL_MS = Number(process.env.HOLDINGS_TX_COST_TTL_MS || 180_000);
const TX_COST_PAGES = Number(process.env.HOLDINGS_TX_COST_PAGES || 3);
const TX_COST_SIZE = Number(process.env.HOLDINGS_TX_COST_SIZE || 100);
let txCostCache = { at: 0, map: null, meta: null, building: null };

/** baw tx amounts are usually human-readable; fall back to wei for long integers. */
function parseTxAmount(amount, decimals = 18) {
  if (amount == null || amount === '') return 0;
  if (typeof amount === 'number') return Number.isFinite(amount) ? amount : 0;
  const s = String(amount).trim();
  if (!s) return 0;
  if (s.includes('.') || /e/i.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  }
  if (/^\d+$/.test(s)) {
    const d = Number(decimals);
    if (Number.isFinite(d) && d >= 0 && s.length > d) return fromWei(s, d);
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function isSpendToken(ca, sym) {
  const c = String(ca || '').toLowerCase();
  const s = String(sym || '').toUpperCase();
  if (c && SPEND_CA.has(c)) return true;
  if (s && SPEND_SYM.has(s)) return true;
  return false;
}

function spendToUsdAndBnb(ca, sym, amt, quoteUsd, bnbUsd) {
  if (!(amt > 0)) return { usd: 0, bnb: 0 };
  const c = String(ca || '').toLowerCase();
  const s = String(sym || '').toUpperCase();
  const isBnb = c === NATIVE_LC || c === WBNB_LC || s === 'BNB' || s === 'WBNB';
  if (isBnb) {
    const bnb = amt;
    const usd = bnbUsd != null && bnbUsd > 0 ? bnb * bnbUsd : 0;
    return { usd, bnb };
  }
  const px = quoteUsd.get(c) ?? quoteUsd.get(s);
  if (px != null && px > 0) {
    const usd = amt * px;
    const bnb = bnbUsd != null && bnbUsd > 0 ? usd / bnbUsd : 0;
    return { usd, bnb };
  }
  // Known spend but no price → cannot price this leg (never invent)
  return { usd: 0, bnb: 0 };
}

/**
 * Reconstruct avg cost per token from baw wallet tx-history buys.
 * Buy = send BNB/WBNB/BNCB/NVDAB/GANG + receive a non-spend token.
 * Returns Map<tokenLower, { avgCostBnb, avgCostUsd, boughtTokens, costBnb, costUsd, buys, source }>.
 */
async function loadTxCostBasis(bawJson, { quoteUsd = new Map(), bnbUsd = null } = {}) {
  const now = Date.now();
  if (txCostCache.map && now - txCostCache.at < TX_COST_TTL_MS) {
    return { map: txCostCache.map, meta: txCostCache.meta };
  }
  if (txCostCache.building) return txCostCache.building;

  txCostCache.building = (async () => {
    const agg = new Map(); // token -> { boughtTokens, costUsd, costBnb, buys, pricedBuys }
    let cursor = null;
    let pages = 0;
    let txCount = 0;
    let buyLegs = 0;
    let err = null;
    try {
      while (pages < TX_COST_PAGES) {
        const args = ['wallet', 'tx-history', '--binanceChainId', '56', '--size', String(TX_COST_SIZE)];
        if (cursor) args.push('--nextCursor', String(cursor));
        const j = await bawJson(args);
        const data = j?.data || j;
        const txs = Array.isArray(data?.transactions) ? data.transactions : [];
        txCount += txs.length;
        for (const tx of txs) {
          if (tx?.status && String(tx.status).toLowerCase() !== 'confirmed') continue;
          const hashes = Array.isArray(tx.txHashList) && tx.txHashList.length ? tx.txHashList : [tx];
          for (const h of hashes) {
            const sends = h?.instructions?.send || [];
            const recs = h?.instructions?.receive || [];
            if (!sends.length || !recs.length) continue;
            const spendLegs = [];
            for (const s of sends) {
              const ca = (s.tokenInfo?.contractAddress || '').toLowerCase();
              const sym = s.tokenInfo?.symbol || '';
              if (!isSpendToken(ca, sym)) continue;
              const amt = parseTxAmount(s.amount, s.tokenInfo?.decimals);
              if (!(amt > 0)) continue;
              spendLegs.push({ ca, sym, amt });
            }
            if (!spendLegs.length) continue;
            const recvLegs = [];
            for (const r of recs) {
              const ca = (r.tokenInfo?.contractAddress || '').toLowerCase();
              const sym = r.tokenInfo?.symbol || '';
              if (!ca || isSpendToken(ca, sym)) continue;
              const amt = parseTxAmount(r.amount, r.tokenInfo?.decimals);
              if (!(amt > 0)) continue;
              recvLegs.push({ ca, sym, amt });
            }
            if (!recvLegs.length) continue;

            let spendUsd = 0;
            let spendBnb = 0;
            let anyPriced = false;
            for (const s of spendLegs) {
              const { usd, bnb } = spendToUsdAndBnb(s.ca, s.sym, s.amt, quoteUsd, bnbUsd);
              if (usd > 0 || bnb > 0) anyPriced = true;
              spendUsd += usd;
              spendBnb += bnb;
            }
            if (!anyPriced) continue; // cannot attribute cost without inventing

            const recvTotal = recvLegs.reduce((a, r) => a + r.amt, 0);
            if (!(recvTotal > 0)) continue;
            for (const r of recvLegs) {
              const share = r.amt / recvTotal;
              const e = agg.get(r.ca) || { boughtTokens: 0, costUsd: 0, costBnb: 0, buys: 0, pricedBuys: 0 };
              e.boughtTokens += r.amt;
              e.costUsd += spendUsd * share;
              e.costBnb += spendBnb * share;
              e.buys += 1;
              e.pricedBuys += 1;
              agg.set(r.ca, e);
              buyLegs += 1;
            }
          }
        }
        pages += 1;
        if (!data?.hasMore || data.nextCursor == null || data.nextCursor === '') break;
        cursor = data.nextCursor;
      }
    } catch (e) {
      err = e.message || String(e);
    }

    const map = new Map();
    for (const [token, e] of agg) {
      if (!(e.boughtTokens > 0)) continue;
      if (!(e.costUsd > 0 || e.costBnb > 0)) continue;
      map.set(token, {
        avgCostBnb: e.costBnb > 0 ? e.costBnb / e.boughtTokens : null,
        avgCostUsd: e.costUsd > 0 ? e.costUsd / e.boughtTokens : null,
        boughtTokens: e.boughtTokens,
        costBnb: e.costBnb,
        costUsd: e.costUsd,
        buys: e.buys,
        source: 'baw-tx',
      });
    }
    const meta = {
      txPages: pages,
      txCount,
      buyLegs,
      costTokens: map.size,
      error: err,
      ttlMs: TX_COST_TTL_MS,
    };
    // Keep prior good cache on hard failure with empty map
    if (err && !map.size && txCostCache.map) {
      return { map: txCostCache.map, meta: { ...txCostCache.meta, error: err, stale: true } };
    }
    txCostCache = { at: Date.now(), map, meta, building: null };
    return { map, meta };
  })().catch(e => {
    txCostCache.building = null;
    if (txCostCache.map) {
      return { map: txCostCache.map, meta: { ...txCostCache.meta, error: e.message, stale: true } };
    }
    return { map: new Map(), meta: { error: e.message, costTokens: 0 } };
  });

  const result = await txCostCache.building;
  txCostCache.building = null;
  return result;
}

/**
 * Attach value / cost / PnL without inventing numbers.
 * value: baw USD → board priceUsd×amount → else null
 * cost: aiwb journal first; else baw tx-history avg (scaled to current amount)
 * pnl: only when both value and cost known
 */
function enrichValueAndPnl(items, { boardMap, pnlByToken, txCostByToken, bnbUsd }) {
  const pxBnb = finiteOrNull(bnbUsd);
  let totalValueUsd = 0;
  let totalKnown = 0;
  let totalMissing = 0;

  for (const it of items) {
    const addr = String(it.address || '').toLowerCase();
    const isNative = addr === 'bnb' || it.platform === 'native';
    const boardHit = (!isNative && addr && addr !== 'bnb')
      ? (boardMap.get(addr)
        || boardMap.get(String(it.tradeCa || '').toLowerCase())
        || [...boardMap.values()].find(b => b.address === addr || b.tradeCa === addr || b.market === addr))
      : null;

    // --- value ---
    let valueUsd = null;
    let valueBnb = null;
    let valueSource = null;

    if (it.usd != null && Number.isFinite(Number(it.usd))) {
      valueUsd = Number(it.usd);
      valueSource = 'baw';
    } else if (boardHit?.priceUsd != null && Number.isFinite(boardHit.priceUsd) && Number.isFinite(it.amount)) {
      valueUsd = boardHit.priceUsd * it.amount;
      valueSource = 'board-price';
    }

    if (isNative && Number.isFinite(it.amount)) {
      valueBnb = it.amount;
      if (valueUsd == null && pxBnb != null) {
        valueUsd = it.amount * pxBnb;
        valueSource = valueSource || 'bnbUsd';
      }
    } else if (valueUsd != null && pxBnb != null && pxBnb > 0) {
      valueBnb = valueUsd / pxBnb;
    }

    // --- cost: journal preferred, else baw tx-history ---
    const pnlKey = isNative ? null : (addr && addr !== 'bnb' ? addr : null);
    const pnl = pnlKey ? pnlByToken.get(pnlKey) : null;
    const txCost = pnlKey && txCostByToken ? (txCostByToken.get(pnlKey) || null) : null;
    let costBnb = null;
    let costUsd = null;
    let costKnown = false;
    let avgCostBnb = null;
    let avgCostUsd = null;
    let costSource = null;

    if (pnl && Number.isFinite(it.amount) && it.amount > 0) {
      avgCostBnb = finiteOrNull(pnl.avgCostBnb);
      // Remaining journal cost for still-held tokens; scale if on-chain amount differs.
      if (avgCostBnb != null && avgCostBnb > 0) {
        costBnb = avgCostBnb * it.amount;
        costKnown = true;
        costSource = 'journal';
      } else if (Number(pnl.heldTokens) > 0 && Number(pnl.boughtBnb) > 0) {
        // Fallback: remaining cost = boughtBnb - costOfSold, scaled by amount/heldTokens
        const remain = Number(pnl.boughtBnb) - Number(pnl.costOfSold || 0);
        if (remain > 0) {
          const held = Number(pnl.heldTokens);
          costBnb = remain * (it.amount / held);
          costKnown = true;
          avgCostBnb = remain / held;
          costSource = 'journal';
        }
      }
      if (costKnown && costBnb != null && pxBnb != null) {
        costUsd = costBnb * pxBnb;
      }
    }

    // Reconstruct from baw tx-history when journal has no cost
    if (!costKnown && txCost && Number.isFinite(it.amount) && it.amount > 0) {
      avgCostBnb = finiteOrNull(txCost.avgCostBnb);
      avgCostUsd = finiteOrNull(txCost.avgCostUsd);
      if (avgCostUsd != null && avgCostUsd > 0) {
        costUsd = avgCostUsd * it.amount;
        costKnown = true;
        costSource = 'baw-tx';
        if (pxBnb != null && pxBnb > 0) {
          costBnb = costUsd / pxBnb;
          if (avgCostBnb == null) avgCostBnb = avgCostUsd / pxBnb;
        } else if (avgCostBnb != null && avgCostBnb > 0) {
          costBnb = avgCostBnb * it.amount;
        }
      } else if (avgCostBnb != null && avgCostBnb > 0) {
        costBnb = avgCostBnb * it.amount;
        costKnown = true;
        costSource = 'baw-tx';
        if (pxBnb != null) costUsd = costBnb * pxBnb;
      }
    }

    // Cash / quote chips: value ok, cost/PnL intentionally unknown (no fake basis)
    const cashLike = isNative || it.platform === 'quote';

    let pnlUsd = null;
    let pnlBnb = null;
    let pnlPct = null;
    if (!cashLike && costKnown) {
      if (valueUsd != null && costUsd != null) {
        pnlUsd = valueUsd - costUsd;
        if (costUsd > 0) pnlPct = (pnlUsd / costUsd) * 100;
      } else if (valueBnb != null && costBnb != null) {
        pnlBnb = valueBnb - costBnb;
        if (costBnb > 0) pnlPct = (pnlBnb / costBnb) * 100;
        if (pxBnb != null) pnlUsd = pnlBnb * pxBnb;
      }
    }

    it.valueUsd = valueUsd != null ? roundMoney(valueUsd, 4) : null;
    it.valueBnb = valueBnb != null ? roundMoney(valueBnb, 6) : null;
    it.valueSource = valueSource;
    it.costBnb = costKnown ? roundMoney(costBnb, 6) : null;
    it.costUsd = costKnown && costUsd != null ? roundMoney(costUsd, 4) : null;
    it.costKnown = !!costKnown && !cashLike;
    it.costSource = it.costKnown ? costSource : null;
    it.avgCostBnb = avgCostBnb != null ? avgCostBnb : null;
    it.avgCostUsd = avgCostUsd != null ? avgCostUsd : null;
    it.pnlUsd = pnlUsd != null ? roundMoney(pnlUsd, 4) : null;
    it.pnlBnb = pnlBnb != null ? roundMoney(pnlBnb, 6) : null;
    it.pnlPct = pnlPct != null ? roundMoney(pnlPct, 2) : null;
    // Keep legacy `usd` in sync with value when we have one
    if (it.usd == null && valueUsd != null) it.usd = it.valueUsd;

    if (valueUsd != null) {
      totalValueUsd += valueUsd;
      totalKnown++;
    } else if (!cashLike) {
      totalMissing++;
    }
  }

  // Include cash-like in total when valued
  // (loop already added them when valueUsd set)

  return {
    totalValueUsd: totalKnown ? roundMoney(totalValueUsd, 2) : null,
    valuedCount: totalKnown,
    unvaluedCount: totalMissing,
    bnbUsd: pxBnb,
  };
}

/**
 * @param {object} opts
 * @param {string} opts.owner wallet address
 * @param {object|null} opts.board latest board payload
 * @param {object|null} opts.tradeEngine
 * @param {object|null} opts.aiwb loadAiwb() result (for rpc.read)
 * @param {Function} opts.bawJson
 * @param {Function} [opts.loadPnl] optional () => pnl rows (aiwb journal)
 * @param {number|null} [opts.bnbUsd] BNB/USD for converting journal cost
 */
export async function fetchHoldings({
  owner,
  board,
  tradeEngine,
  aiwb,
  bawJson,
  loadPnl,
  bnbUsd = null,
}) {
  if (!owner || !/^0x[a-fA-F0-9]{40}$/.test(owner)) {
    return { ok: false, error: 'no wallet address', items: [], updatedAt: new Date().toISOString() };
  }
  const rpc = tradeEngine?.rpc || (aiwb ? aiwb.createRpc?.(process.env.BSC_RPC?.split(',')) : null);
  const boardMap = collectBoardCandidates(board);
  const items = new Map(); // key -> holding

  // --- 1) baw wallet balance (trusted amounts + USD) ---
  let bawErr = null;
  let bawRows = [];
  try {
    const j = await bawJson(['wallet', 'balance']);
    bawRows = Array.isArray(j?.data) ? j.data : (Array.isArray(j) ? j : []);
  } catch (e) {
    bawErr = e.message;
  }

  for (const row of bawRows) {
    const chain = String(row.binanceChainId || '');
    if (chain && chain !== '56') continue;
    const addr = String(row.address || '').toLowerCase();
    if (!addr) continue;
    const isNative = addr === NATIVE || /^bnb$/i.test(row.symbol || '');
    const bal = Number(row.balance);
    if (!Number.isFinite(bal) || bal <= 0) continue;

    const boardHit = !isNative && (boardMap.get(addr) || [...boardMap.values()].find(b => b.address === addr || b.tradeCa === addr));
    // Keep every positive baw row (BNB + ERC20). Do NOT drop off-board memes — baw is source of truth for listed bags.
    // (Dust memes missing from baw are recovered via tx-history + chain probe below.)

    const QUOTE_CAS = new Set([
      '0x4902c5ebc598265ed2212b559b042de8a5eeec3f', // BNCB
      '0x02fca66c1d1afb4e2a7884261eb00f63598a7436', // NVDAB
      '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', // WBNB
      '0xce24439f2d9c6a2289f741120fe202248b666666', // U
    ]);
    const platform = boardHit?.platform
      || (/^gang$/i.test(row.symbol || '') || addr === '0x0c6302401aa5325c2e36f170f52c00b1d220b405' ? 'gang' : null)
      || (QUOTE_CAS.has(addr) || /^(bncb|nvdab|wbnb|u)$/i.test(row.symbol || '') ? 'quote' : null)
      || (isNative ? 'native' : null);

    const tradeable = boardHit
      ? boardHit.tradeable !== false
      : (platform === 'gang' || platform === 'flap' || platform === 'four' || platform == null);
    items.set(isNative ? 'bnb' : addr, {
      source: 'baw',
      platform,
      symbol: boardHit?.symbol || row.symbol || '?',
      name: boardHit?.name || row.name || row.symbol || '?',
      address: isNative ? 'BNB' : addr,
      tradeCa: boardHit?.tradeCa || (isNative ? 'BNB' : addr),
      market: boardHit?.market || null,
      amount: bal,
      amountDisplay: fmtAmt(bal),
      usd: row.value != null ? Number(row.value) : null,
      track: boardHit?.track || null,
      graduated: boardHit?.graduated ?? null,
      tradeable: isNative ? false : tradeable,
      untradeableReason: isNative
        ? 'gas / 报价币'
        : (boardHit?.untradeableReason
          || (platform === 'quote' ? '报价币（非曲线仓位）' : null)),
      gangPad: boardHit?.gangPad || null,
      tradePath: boardHit?.tradePath || null,
      logoUrl: boardHit?.logoUrl || row.logoUrl || row.logo || row.imageUrl || row.iconUrl || null,
      unit: 'token',
      shortCa: isNative ? 'BNB' : short(addr),
    });
  }

  // --- 2) On-chain probe of board coins (catches dust + Flap shares) ---
  // Prefer GANG (and known platforms) so meme bags aren't starved by GMGN flood beyond MAX_BOARD_PROBE.
  if (rpc && boardMap.size) {
    const ranked = [...boardMap.values()].sort((a, b) => {
      const rank = p => (p === 'gang' ? 0 : p === 'flap' ? 1 : p === 'four' ? 2 : 3);
      return rank(a.platform) - rank(b.platform);
    });
    const list = ranked.slice(0, MAX_BOARD_PROBE);
    await mapPool(list, CONCURRENCY, async (c) => {
      let raw = 0n;
      let unit = 'token';
      let key = (c.tradeCa || c.address).toLowerCase();
      if (c.platform === 'flap' && c.market && !c.graduated) {
        raw = await readFlapShares(rpc, c.market, owner);
        unit = 'shares';
        key = c.market.toLowerCase();
      } else {
        const token = c.address || c.tradeCa;
        if (!token || token === ZERO) return;
        raw = await readErc20Bal(rpc, token, owner);
        key = token.toLowerCase();
      }
      if (raw <= 0n) return;
      const amount = fromWei(raw, 18);
      if (!(amount > 0)) return;
      const prev = items.get(key);
      // Prefer baw USD when same token already listed; still refresh amount from chain if larger detail needed
      if (prev && prev.source === 'baw') {
        // Keep baw USD; overlay official board name/symbol (GANG swap etc.)
        prev.chainConfirmed = true;
        overlayBoardDisplay(prev, c);
        if (c.gangPad) prev.gangPad = c.gangPad;
        if (c.tradePath) prev.tradePath = c.tradePath;
        if (c.platform) prev.platform = c.platform;
        return;
      }
      items.set(key, {
        source: 'chain',
        platform: c.platform,
        symbol: c.symbol,
        name: c.name,
        address: c.address,
        tradeCa: c.tradeCa || c.address,
        market: c.market,
        amount,
        amountDisplay: fmtAmt(amount),
        usd: null,
        track: c.track,
        graduated: c.graduated,
        tradeable: c.tradeable !== false,
        untradeableReason: c.untradeableReason,
        gangPad: c.gangPad || null,
        tradePath: c.tradePath || null,
        logoUrl: c.logoUrl || null,
        unit,
        shortCa: short(c.address || c.market),
      });
    });
  }

  // --- 2b) Archive bags: tokens bought in baw tx-history but missing from baw balance (dust hide) ---
  // Probe balanceOf for receive CAs from recent buys so off-board memes still show with value+cost.
  if (rpc && typeof bawJson === 'function') {
    try {
      const archiveCas = new Set();
      let cursor = null;
      for (let page = 0; page < Math.min(TX_COST_PAGES, 3); page++) {
        const args = ['wallet', 'tx-history', '--binanceChainId', '56', '--size', String(TX_COST_SIZE)];
        if (cursor) args.push('--nextCursor', String(cursor));
        const j = await bawJson(args);
        const data = j?.data || j;
        const txs = Array.isArray(data?.transactions) ? data.transactions : [];
        for (const tx of txs) {
          if (tx?.status && String(tx.status).toLowerCase() !== 'confirmed') continue;
          const hashes = Array.isArray(tx.txHashList) && tx.txHashList.length ? tx.txHashList : [tx];
          for (const h of hashes) {
            for (const r of (h?.instructions?.receive || [])) {
              const ca = (r.tokenInfo?.contractAddress || '').toLowerCase();
              const sym = r.tokenInfo?.symbol || '';
              if (!ca || isSpendToken(ca, sym)) continue;
              if (items.has(ca)) continue;
              archiveCas.add(ca);
            }
          }
        }
        if (!data?.hasMore || data.nextCursor == null || data.nextCursor === '') break;
        cursor = data.nextCursor;
      }
      const archiveList = [...archiveCas].slice(0, Number(process.env.HOLDINGS_ARCHIVE_PROBE || 60));
      await mapPool(archiveList, CONCURRENCY, async (ca) => {
        if (items.has(ca)) return;
        const raw = await readErc20Bal(rpc, ca, owner);
        if (raw <= 0n) return;
        const amount = fromWei(raw, 18);
        // Skip wei-dust leftovers (e.g. 1e-18 after full sell) — never invent, but don't clutter strip
        if (!(amount > 1e-6)) return;
        const boardHit = boardMap.get(ca) || [...boardMap.values()].find(b => b.address === ca || b.tradeCa === ca);
        let sym = boardHit?.symbol || null;
        let name = boardHit?.name || null;
        // Lightweight symbol() when unknown — best-effort, never invent amount
        if (!sym && rpc.read) {
          try {
            sym = await rpc.read(ca, 'symbol()', [], ['string']);
          } catch { /* ignore */ }
        }
        if (!name && rpc.read) {
          try {
            name = await rpc.read(ca, 'name()', [], ['string']);
          } catch { /* ignore */ }
        }
        items.set(ca, {
          source: 'chain-archive',
          platform: boardHit?.platform || null,
          symbol: sym || '?',
          name: name || sym || '?',
          address: ca,
          tradeCa: boardHit?.tradeCa || ca,
          market: boardHit?.market || null,
          amount,
          amountDisplay: fmtAmt(amount),
          usd: null,
          track: boardHit?.track || null,
          graduated: boardHit?.graduated ?? null,
          tradeable: boardHit ? boardHit.tradeable !== false : true,
          untradeableReason: boardHit?.untradeableReason || null,
          gangPad: boardHit?.gangPad || null,
          tradePath: boardHit?.tradePath || null,
          logoUrl: boardHit?.logoUrl || null,
          unit: 'token',
          shortCa: short(ca),
        });
      });
    } catch (e) {
      console.warn('[holdings] archive probe', e.message);
    }
  }

  // --- 3) journal/pnl: COST ONLY — never invent holdings from stale heldTokens ---
  // Cleared bags (e.g. sold 大肥鱼) still sit in aiwb journal with heldTokens>0; showing them
  // without balanceOf caused ghost rows. Real bags come from baw / board probe / archive probe.

  // Index journal pnl for cost basis only (no orphan journal holdings)
  const pnlByToken = new Map();
  if (typeof loadPnl === 'function') {
    try {
      for (const p of loadPnl() || []) {
        if (p?.token) pnlByToken.set(String(p.token).toLowerCase(), p);
      }
    } catch { /* ignore */ }
  }

  const MIN_HOLD_AMT = Number(process.env.HOLDINGS_MIN_AMT || 1e-6);
  const sorted = [...items.values()]
    .filter(a => {
      if (a.platform === 'native' || a.platform === 'quote') return true;
      if (a.usd != null && a.usd >= 0.01) return true;
      return (a.amount || 0) > MIN_HOLD_AMT;
    })
    .sort((a, b) => {
    const ua = a.usd != null ? a.usd : -1;
    const ub = b.usd != null ? b.usd : -1;
    if (ua !== ub) return ub - ua;
    return (b.amount || 0) - (a.amount || 0);
  });

  let itemsOut = sorted.map(applyTradeability);
  try {
    itemsOut = await gateGangPads(itemsOut, tradeEngine);
  } catch (e) {
    // Non-fatal: leave prior tradeable flags
    console.warn('[holdings] gateGangPads', e.message);
  }

  // Quote USD prices from baw rows (for pricing BNCB/NVDAB/GANG spend legs)
  const quoteUsd = new Map();
  for (const row of bawRows) {
    const addr = String(row.address || '').toLowerCase();
    const sym = String(row.symbol || '').toUpperCase();
    const px = Number(row.price);
    if (!Number.isFinite(px) || px <= 0) continue;
    if (addr && addr !== NATIVE.toLowerCase()) quoteUsd.set(addr, px);
    if (sym) quoteUsd.set(sym, px);
  }
  // Native BNB price hint
  if (bnbUsd != null && Number.isFinite(Number(bnbUsd)) && Number(bnbUsd) > 0) {
    quoteUsd.set('BNB', Number(bnbUsd));
    quoteUsd.set(NATIVE.toLowerCase(), Number(bnbUsd));
    quoteUsd.set(WBNB_LC, Number(bnbUsd));
  }

  let txCostByToken = new Map();
  let txCostMeta = null;
  try {
    const loaded = await loadTxCostBasis(bawJson, { quoteUsd, bnbUsd });
    txCostByToken = loaded.map || new Map();
    txCostMeta = loaded.meta || null;
  } catch (e) {
    txCostMeta = { error: e.message, costTokens: 0 };
  }

  // Final: every holding with a board card uses official card name/symbol (GANG API swap included).
  for (const it of itemsOut) {
    const addr = String(it.address || '').toLowerCase();
    if (!addr || addr === 'bnb') continue;
    const hit = boardMap.get(addr)
      || [...boardMap.values()].find(b => b.address === addr || b.tradeCa === addr);
    overlayBoardDisplay(it, hit);
    if (hit?.logoUrl && !it.logoUrl) it.logoUrl = hit.logoUrl;
  }
  // fill missing logos from board (address / tradeCa)
  for (const it of itemsOut) {
    if (it.logoUrl) continue;
    const addr = String(it.address || '').toLowerCase();
    const hit = boardMap.get(addr)
      || boardMap.get(String(it.tradeCa || '').toLowerCase())
      || [...boardMap.values()].find(b => b.address === addr || b.tradeCa === addr);
    if (hit?.logoUrl) it.logoUrl = hit.logoUrl;
  }

  for (const it of itemsOut) {
    if (!it.logoUrl) {
      const k = knownHoldLogo(it);
      if (k) it.logoUrl = k;
    }
  }
  await enrichHoldLogos(itemsOut);
  for (const it of itemsOut) {
    if (!it.logoUrl) {
      const k = knownHoldLogo(it);
      if (k) it.logoUrl = k;
    }
  }
  const valueMeta = enrichValueAndPnl(itemsOut, { boardMap, pnlByToken, txCostByToken, bnbUsd });

  // Re-sort by valueUsd when available
  itemsOut.sort((a, b) => {
    const ua = a.valueUsd != null ? a.valueUsd : (a.usd != null ? a.usd : -1);
    const ub = b.valueUsd != null ? b.valueUsd : (b.usd != null ? b.usd : -1);
    if (ua !== ub) return ub - ua;
    return (b.amount || 0) - (a.amount || 0);
  });

  const costKnownCount = itemsOut.filter(i => i.costKnown).length;

  return {
    ok: true,
    owner: owner.toLowerCase(),
    items: itemsOut,
    updatedAt: new Date().toISOString(),
    ttlMs: HOLDINGS_TTL_MS,
    totalValueUsd: valueMeta.totalValueUsd,
    meta: {
      bawError: bawErr,
      boardProbed: Math.min(boardMap.size, MAX_BOARD_PROBE),
      boardCandidates: boardMap.size,
      archiveProbed: itemsOut.filter(i => i.source === 'chain-archive').length,
      gangPadGated: true,
      valuedCount: valueMeta.valuedCount,
      unvaluedCount: valueMeta.unvaluedCount,
      bnbUsd: valueMeta.bnbUsd,
      pnlRows: pnlByToken.size,
      costKnownCount,
      txCost: txCostMeta,
    },
  };
}

export { HOLDINGS_TTL_MS };
