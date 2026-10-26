/** FLAP agent-curve only: MarketCreated logs on factory + marketCards reader. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { card } from './cards.mjs';
import { logsChunked, loadCache, saveCache } from './logs.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(__dirname, '..', 'data', 'flap-markets.json');
const LOOKBACK = Number(process.env.FLAP_LOOKBACK_BLOCKS || 12_000);
const ZERO = '0x0000000000000000000000000000000000000000';
const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

export async function fetchFlap(aiwb, rpc, { nearMinPct = 50, nearMinMcUsd = 10_000 } = {}) {
  const { FLAP_AGENT, flapAgent } = aiwb;
  const bn = await rpc.blockNumber();
  const from = bn > BigInt(LOOKBACK) ? bn - BigInt(LOOKBACK) : 0n;

  const cached = loadCache(CACHE);
  const markets = new Map();
  for (const m of cached) markets.set(m.toLowerCase(), { market: m, block: null });

  let logError = null;
  try {
    const logs = await logsChunked(rpc, {
      address: FLAP_AGENT.factory,
      topics: FLAP_AGENT.created.topics,
    }, from, bn, { chunk: 1200n, pauseMs: 30, deadlineMs: Number(process.env.FLAP_LOG_MS || 15_000) });
    for (const log of logs) {
      const c = flapAgent.parse.created(log);
      markets.set(c.market.toLowerCase(), { ...c, block: c.block != null ? Number(c.block) : null });
    }
    saveCache(CACHE, [...markets.keys()]);
  } catch (e) {
    logError = e.message;
  }
  if (!markets.size) {
    return {
      new: [], near: [], graduated: [], total: 0, scanned: 0,
      error: logError
        ? `flap logs failed (RPC?): ${logError}`
        : 'no flap agent markets in cache/lookback',
    };
  }

  const list = [...markets.values()];
  const cards = [];
  for (let i = 0; i < list.length; i += 15) {
    const batch = list.slice(i, i + 15).map(m => m.market);
    try {
      const raw = await rpc.call(flapAgent.reads.cards(batch));
      const parsed = flapAgent.parse.cards(raw);
      for (let j = 0; j < parsed.length; j++) {
        cards.push({ ...parsed[j], createdBlock: list[i + j]?.block });
      }
    } catch {
      for (let j = 0; j < batch.length; j++) {
        try {
          const raw = await rpc.call(flapAgent.reads.cards([batch[j]]));
          cards.push({ ...flapAgent.parse.cards(raw)[0], createdBlock: list[i + j]?.block });
        } catch { /* skip */ }
      }
    }
  }

  const blockAgeMin = (createdBlock) => {
    if (createdBlock == null) return null;
    return Math.max(0, Number(bn - BigInt(createdBlock)) * 0.45 / 60);
  };

  const outNew = [], outNear = [], outGrad = [];
  for (const c of cards) {
    if (!c?.market) continue;
    const progress = Number(c.progress) || 0;
    const open = c.open === true || Number(c.phase) === FLAP_AGENT.phaseOpen;
    const quote = same(c.quote, ZERO) ? 'BNB' : (c.quote ? `${String(c.quote).slice(0, 6)}…` : '?');
    const launched = c.token && !same(c.token, ZERO);
    // Display: predictedToken (…7777) when on curve; real token after launch.
    const addr = launched ? c.token : (c.predictedToken || c.market);
    // Trade: aiwb accepts market OR predictedToken; prefer market on curve (always has code).
    const tradeCa = open ? c.market : (launched ? c.token : c.market);
    const item = card({
      platform: 'flap',
      address: addr,
      tradeCa,
      market: c.market,
      name: c.name,
      symbol: c.symbol,
      quote,
      progressPct: open ? progress : 100,
      graduated: !open,
      ageMin: blockAgeMin(c.createdBlock),
      tradeable: open || launched,
      untradeableReason: (!open && !launched) ? 'Flap 市场已关闭且尚未发射 token' : null,
      extra: { phase: c.phase, predictedToken: c.predictedToken },
    });
    if (!open) outGrad.push(item);
    else {
      outNew.push(item);
      const mcV = Number(item.mcUsd ?? item.fdvUsd);
      const mcOk = Number.isFinite(mcV) && mcV >= nearMinMcUsd;
      if (mcOk || progress >= nearMinPct) outNear.push(item);
    }
  }

  outNew.sort((a, b) => (a.ageMin ?? 1e9) - (b.ageMin ?? 1e9));
  outNear.sort((a, b) => {
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
  outGrad.sort((a, b) => (a.ageMin ?? 1e9) - (b.ageMin ?? 1e9));

  return {
    new: outNew, near: outNear, graduated: outGrad,
    total: cards.length, scanned: list.length,
    error: logError && !cards.length ? `flap enrich empty after RPC log error: ${logError}` : null,
  };
}
