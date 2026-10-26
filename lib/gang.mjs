/** GANG discovery via gang.fun indexer (LaunchpadV2/stocks = aiwb; Soft/U/S = official gang CLI on board). */
import { card } from './cards.mjs';

const API = (process.env.GANG_API || 'https://gang.fun/api').replace(/\/+$/, '');
const SOFT_GRAD_BNB = 20;
/** Soft/内盘 on by default (official gang.fun curve). Set GANG_INCLUDE_SOFT=0 to hide. */
const INCLUDE_SOFT = process.env.GANG_INCLUDE_SOFT !== '0';
const num = v => (v == null || v === '' ? 0 : Number(v));
const usd = v => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const now = () => Math.floor(Date.now() / 1000);

async function get(path) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15_000);
  try {
    const r = await fetch(`${API}${path}`, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`gang API ${r.status} on ${path}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

function normalize(r) {
  const v2 = r.track === 'stocks';
  const quote = v2 ? (r.quoteSymbol || '?') : 'BNB';
  const raised = v2 ? num(r.raisedQuote) : num(r.raisedBnb);
  const target = v2 ? num(r.gradAmtQuote) : SOFT_GRAD_BNB;
  const remaining = r.graduated ? 0 : (v2 ? num(r.graduationRemainingQuote) : Math.max(0, target - raised));
  const quoteUsd = v2 ? num(r.quoteUsd) : num(r.bnbUsd);
  let logoUrl = r.logoUrl || null;
  if (logoUrl && logoUrl.startsWith('/')) logoUrl = `https://gang.fun${logoUrl}`;
  // gang.fun API name/symbol are swapped vs official UI (big title = API symbol, ticker = API name).
  const apiName = r.name ?? null;
  const apiSymbol = r.symbol ?? null;
  const displayName = (apiSymbol != null && apiSymbol !== '' && apiName != null && apiName !== '')
    ? apiSymbol : (apiName ?? apiSymbol);
  const displaySymbol = (apiSymbol != null && apiSymbol !== '' && apiName != null && apiName !== '')
    ? apiName : (apiSymbol ?? apiName);
  return {
    address: String(r.address).toLowerCase(),
    symbol: displaySymbol, name: displayName,
    apiName, apiSymbol,
    track: v2 ? 'v2' : 'soft',
    quote, quoteAddress: v2 ? r.quoteAddress : null,
    graduated: !!r.graduated, pair: r.pair || null,
    progressPct: num(r.progressPct),
    remainingUsd: quoteUsd ? usd(remaining * quoteUsd) : null,
    priceUsd: r.priceUsd ?? null, fdvUsd: usd(num(r.fdvUsd)),
    createdAt: r.createdAt, ageMin: r.createdAt ? Math.floor((now() - r.createdAt) / 60) : null,
    logoUrl, creatorHandle: r.creatorHandle || null,
    holders: r.holders == null || r.holders === '' ? null : Number(r.holders),
    holdersSource: r.holdersSource || null,
    volume24hUsd: r.volume24hUsd == null || r.volume24hUsd === '' ? null : Number(r.volume24hUsd),
    taxed: v2 ? !!r.taxed : false,
    taxBps: v2 ? (r.taxBps == null || r.taxBps === '' ? (r.taxed ? 100 : 0) : Number(r.taxBps)) : 0,
    taxDivSplit: v2 ? (r.divSplit || (r.taxed ? '50/50' : 'v4.1-80/20')) : 'v4.1-80/20',
  };
}

async function pages(path, maxPages = 3) {
  const rows = [];
  for (let offset = 0, i = 0; i < maxPages; i++) {
    const sep = path.includes('?') ? '&' : '?';
    const page = await get(`${path}${sep}limit=200&offset=${offset}`);
    if (!page) throw new Error(`gang API 404 on ${path}`);
    rows.push(...(page.items || []));
    if (!page.hasMore || page.nextOffset == null) break;
    offset = page.nextOffset;
  }
  return rows;
}

function toCard(t) {
  const soft = t.track === 'soft';
  // Soft curve: board routes via official `gang` CLI (not aiwb). Soft graduated → pancake/aiwb.
  const viaGangCli = soft && !t.graduated;
  return card({
    platform: 'gang',
    address: t.address,
    tradeCa: t.address,
    name: t.name,
    symbol: t.symbol,
    quote: t.quote,
    logoUrl: t.logoUrl,
    progressPct: t.graduated ? 100 : t.progressPct,
    graduated: t.graduated,
    fdvUsd: t.fdvUsd,
    mcUsd: t.fdvUsd,
    priceUsd: t.priceUsd == null || t.priceUsd === '' ? null : Number(t.priceUsd),
    createdAt: t.createdAt,
    ageMin: t.ageMin,
    pair: t.pair,
    track: t.track,
    tradeable: true,
    untradeableReason: null,
    creatorHandle: t.creatorHandle || null,
    devName: t.creatorHandle || null,
    holderCount: Number.isFinite(t.holders) && t.holders >= 0 ? Math.floor(t.holders) : null,
    volume24hUsd: Number.isFinite(t.volume24hUsd) && t.volume24hUsd >= 0 ? t.volume24hUsd : null,
    taxed: t.taxed == null ? null : !!t.taxed,
    taxBps: Number.isFinite(Number(t.taxBps)) ? Number(t.taxBps) : null,
    taxDivSplit: t.taxDivSplit || null,
    extra: {
      gangPad: viaGangCli ? 'soft' : (t.track === 'v2' ? 'v2' : null),
      tradePath: viaGangCli ? 'gang-cli' : 'aiwb',
      creatorHandle: t.creatorHandle || null,
      apiName: t.apiName ?? null,
      apiSymbol: t.apiSymbol ?? null,
      quoteAddress: t.quoteAddress || null,
      holdersSource: t.holdersSource || null,
      taxDivSplit: t.taxDivSplit || null,
    },
  });
}

/** Fetch soft + v2 market and split into board columns. Soft curve included unless GANG_INCLUDE_SOFT=0. */
export async function fetchGang({ nearMinPct = 50, nearMinMcUsd = 10_000, newLimit = 40, nearLimit = 40, gradLimit = 40 } = {}) {
  const [v2rows, softRows] = await Promise.all([
    pages('/stocks/tokens'),
    pages('/tokens?sort=new'),
  ]);
  const seen = new Map();
  for (const r of [...v2rows, ...softRows]) {
    const t = normalize(r);
    if (!seen.has(t.address)) seen.set(t.address, t);
  }
  let tokens = [...seen.values()];
  const softCurveCount = tokens.filter(t => t.track === 'soft' && !t.graduated).length;
  // Soft curve shown by default (gang CLI trade path). GANG_INCLUDE_SOFT=0 to hide.
  if (!INCLUDE_SOFT) {
    tokens = tokens.filter(t => !(t.track === 'soft' && !t.graduated));
  }
  const curve = tokens.filter(t => !t.graduated);
  const graduated = tokens.filter(t => t.graduated)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, gradLimit)
    .map(toCard);
  const mcOf = x => {
    const v = Number(x?.mcUsd ?? x?.fdvUsd);
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const qualifiesNear = t => {
    const mc = mcOf(t);
    if (mc != null && mc >= nearMinMcUsd) return true;
    return (t.progressPct || 0) >= nearMinPct;
  };
  const nearAddrs = new Set();
  const near = curve.filter(qualifiesNear)
    .sort((a, b) => {
      const ma = mcOf(a), mb = mcOf(b);
      if (ma != null && mb != null && ma !== mb) return mb - ma; // high MC first
      if (ma != null && mb == null) return -1;
      if (ma == null && mb != null) return 1;
      return (b.progressPct || 0) - (a.progressPct || 0);
    })
    .slice(0, nearLimit)
    .map(t => { nearAddrs.add(t.address); return toCard(t); });
  // new: exclude already in near
  const newest = [...curve]
    .filter(t => !nearAddrs.has(t.address))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, newLimit)
    .map(toCard);
  return {
    new: newest, near, graduated,
    total: tokens.length,
    softCurveHidden: INCLUDE_SOFT ? 0 : softCurveCount,
    error: null,
  };
}
