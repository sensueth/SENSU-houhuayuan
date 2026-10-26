/** FOUR agent-template only: Created logs filtered by template + tokens()/tokenPhase(). */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { card } from './cards.mjs';
import { logsChunked, loadCache, saveCache } from './logs.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(__dirname, '..', 'data', 'four-tokens.json');
const LOOKBACK = Number(process.env.FOUR_LOOKBACK_BLOCKS || 6_000);
const MAX_ENRICH = Number(process.env.FOUR_MAX_ENRICH || 30);
const SALE_ALLOC = 800_000_000n * 10n ** 18n;
const TOTAL_SUPPLY = 1_000_000_000n * 10n ** 18n;

function addrAt(hex, i) {
  return '0x' + hex.slice(2 + i * 64 + 24, 2 + (i + 1) * 64);
}

async function enrichOne(aiwb, rpc, bn, meta) {
  const { FOUR_AGENT, four } = aiwb;
  const raw = await rpc.call(four.reads.record(meta.token));
  const rec = four.parse.record(raw);
  if (!rec || !four.isAgentCoin(rec)) return null;
  const phase = four.parse.uint(await rpc.call(four.reads.phase(meta.token)));
  const graduated = phase === FOUR_AGENT.phase.pool;
  const [name, symbol] = await Promise.all([
    rpc.read(meta.token, 'name()', [], ['string']).catch(() => '?'),
    rpc.read(meta.token, 'symbol()', [], ['string']).catch(() => '?'),
  ]);
  let progressPct = graduated ? 100 : 0;
  if (!graduated) {
    try {
      const vault = addrAt(raw, 10);
      const bal = await rpc.read(meta.token, 'balanceOf(address)', [vault], ['uint256']);
      const leftVault = bal > TOTAL_SUPPLY ? TOTAL_SUPPLY : bal;
      const soldAmt = TOTAL_SUPPLY > leftVault ? TOTAL_SUPPLY - leftVault : 0n;
      progressPct = Math.max(0, Math.min(100, Number((soldAmt * 10000n) / SALE_ALLOC) / 100));
    } catch { progressPct = 0; }
  }
  const ageMin = rec.createdBlock != null
    ? Number(bn - rec.createdBlock) * 0.45 / 60
    : (meta.block != null ? Number(bn - meta.block) * 0.45 / 60 : null);
  return card({
    platform: 'four',
    address: meta.token,
    tradeCa: meta.token,
    name, symbol,
    quote: 'BNB',
    progressPct,
    graduated,
    ageMin,
    tradeable: true, // curve → fouragent; graduated → pancake (aiwb follow)
    extra: {
      phase: phase.toString(),
      targetBnb: rec.target != null ? Number(rec.target) / 1e18 : 13.4,
      creator: rec.creator,
    },
  });
}

export async function fetchFour(aiwb, rpc, { nearMinPct = 50, nearMinMcUsd = 10_000 } = {}) {
  const { FOUR_AGENT, four } = aiwb;
  let bn;
  try {
    bn = await rpc.blockNumber();
  } catch (e) {
    return {
      new: [], near: [], graduated: [], total: 0, scanned: 0,
      error: `four RPC blockNumber failed: ${e.message}`,
    };
  }
  const from = bn > BigInt(LOOKBACK) ? bn - BigInt(LOOKBACK) : 0n;

  const cached = loadCache(CACHE);
  const tokens = new Map();
  for (const t of cached) tokens.set(t.toLowerCase(), { token: t, block: null });

  let logError = null;
  try {
    const logs = await logsChunked(rpc, {
      address: FOUR_AGENT.core,
      topics: FOUR_AGENT.created.topics,
    }, from, bn, { chunk: 1500n, pauseMs: 20, deadlineMs: Number(process.env.FOUR_LOG_MS || 12_000) });
    for (const log of logs) {
      const c = four.parse.created(log);
      tokens.set(c.token.toLowerCase(), c);
    }
    saveCache(CACHE, [...tokens.keys()]);
  } catch (e) {
    logError = e.message;
  }

  if (!tokens.size) {
    return {
      new: [], near: [], graduated: [], total: 0, scanned: 0,
      error: logError
        ? `four logs failed (RPC?): ${logError}`
        : 'no four agent tokens in cache/lookback',
    };
  }

  const tokenList = [...tokens.values()].slice(-MAX_ENRICH);
  const items = [];
  const CONCURRENCY = 6;
  for (let i = 0; i < tokenList.length; i += CONCURRENCY) {
    const batch = tokenList.slice(i, i + CONCURRENCY);
    const got = await Promise.all(batch.map(m => enrichOne(aiwb, rpc, bn, m).catch(() => null)));
    for (const x of got) if (x) items.push(x);
  }

  if (!items.length && logError) {
    return {
      new: [], near: [], graduated: [], total: 0, scanned: tokens.size,
      error: `four enrich empty (RPC?): ${logError}`,
    };
  }

  const curve = items.filter(i => !i.graduated);
  const graduated = items.filter(i => i.graduated).sort((a, b) => (a.ageMin ?? 1e9) - (b.ageMin ?? 1e9));
  const newest = [...curve].sort((a, b) => (a.ageMin ?? 1e9) - (b.ageMin ?? 1e9));
  const mcOf = x => { const v = Number(x?.mcUsd ?? x?.fdvUsd); return Number.isFinite(v) && v > 0 ? v : null; };
  const near = curve.filter(i => {
    const mc = mcOf(i);
    return (mc != null && mc >= nearMinMcUsd) || i.progressPct >= nearMinPct;
  }).sort((a, b) => {
    const mc = x => {
      const v = Number(x?.mcUsd ?? x?.fdvUsd);
      return Number.isFinite(v) && v > 0 ? v : null;
    };
    const ma = mc(a), mb = mc(b);
    if (ma != null && mb != null && ma !== mb) return mb - ma;
    if (ma != null && mb == null) return -1;
    if (ma == null && mb != null) return 1;
    return (b.progressPct || 0) - (a.progressPct || 0);
  });

  return {
    new: newest, near, graduated,
    total: items.length, scanned: tokens.size,
    error: null,
  };
}
