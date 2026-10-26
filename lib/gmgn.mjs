/**
 * GMGN OpenAPI trenches → FLAP / FOUR board columns (near + graduated + new MC backfill).
 * Exist-auth only (X-APIKEY). Soft/GANG untouched.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { card } from './cards.mjs';

const HOST = (process.env.GMGN_API_HOST || 'https://openapi.gmgn.ai').replace(/\/+$/, '');
const UA = process.env.GMGN_USER_AGENT || 'gmgn-cli/1.6.7';
const LIMIT = Math.min(80, Math.max(10, Number(process.env.GMGN_TRENCH_LIMIT || 60)));
const TIMEOUT_MS = Number(process.env.GMGN_TIMEOUT_MS || 18_000);

/** GMGN launchpad tags → board platform */
const FLAP_PLATS = new Set(['flap', 'flap_stocks', 'flap_aioracle']);
/** Curve (内盘): aiwb only has four-agent (template 1778027615735). Classic fourmeme has no handler. */
const FOUR_AGENT_PLATS = new Set(['fourmeme_agent', 'four_xmode_agent', 'bn_fourmeme']);
/** Graduated: classic fourmeme/openfour still trade via aiwb pancake-v2. */
const FOUR_GRAD_PLATS = new Set(['fourmeme', 'openfour', ...FOUR_AGENT_PLATS]);
/** Request all four* tags from GMGN; filter per bucket in toCard/splitPads. */
const FOUR_PLATS = new Set([...FOUR_GRAD_PLATS]);
const ALL_PLATS = [...FLAP_PLATS, ...FOUR_PLATS];

const BSC_QUOTE_TYPES = [6, 7, 1, 16, 8, 3, 9, 10, 2, 17, 18, 0];

function loadApiKey() {
  if (process.env.GMGN_API_KEY) return String(process.env.GMGN_API_KEY).trim();
  const candidates = [
    path.join(os.homedir(), '.config', 'gmgn', '.env'),
    path.join(process.env.APPDATA || '', 'gmgn', '.env'),
    path.join(process.cwd(), '.env.gmgn'),
    path.join(process.cwd(), 'data', '.gmgn-api-key'),
  ];
  for (const f of candidates) {
    if (!f || !fs.existsSync(f)) continue;
    const text = fs.readFileSync(f, 'utf8');
    const m = text.match(/^GMGN_API_KEY=(.+)$/m) || (!text.includes('=') ? [null, text.trim()] : null);
    const v = m?.[1]?.trim().replace(/^["']|["']$/g, '');
    if (v) return v;
  }
  return null;
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Prefer free list-payload holder totals; never invent. */
function holderCountFrom(t) {
  const n = num(t?.holder_count) ?? num(t?.holders) ?? num(t?.holderCount)
    ?? num(t?.unique_holder_count) ?? num(t?.holder_num);
  if (n == null || n < 0) return null;
  return Math.floor(n);
}

/** 24h USD volume from trenches when present. */
function volume24hFrom(t) {
  const n = num(t?.volume_24h) ?? num(t?.volume24h) ?? num(t?.usd_volume_24h)
    ?? num(t?.volume_24h_usd) ?? num(t?.volume);
  if (n == null || n < 0) return null;
  return n;
}

/** GMGN progress is usually 0–1; sometimes already percent. */
function progressPct(t, graduated) {
  if (graduated) return 100;
  const v = num(t?.progress);
  if (v == null) return 0;
  if (v <= 1.5) return Math.max(0, Math.min(100, v * 100));
  return Math.max(0, Math.min(100, v));
}

function mcUsd(t) {
  return num(t?.market_cap) ?? num(t?.usd_market_cap);
}

function boardPlatform(launchpad) {
  const p = String(launchpad || '').toLowerCase();
  if (FLAP_PLATS.has(p) || p.startsWith('flap')) return 'flap';
  if (FOUR_PLATS.has(p) || p.includes('four')) return 'four';
  return null;
}

/** True if GMGN tag is a Four agent-template curve aiwb can buy. */
function isFourAgentLaunchpad(launchpad) {
  const p = String(launchpad || '').toLowerCase();
  if (FOUR_AGENT_PLATS.has(p)) return true;
  // future tags like four_xxx_agent
  return p.includes('four') && p.includes('agent');
}

/**
 * Whether to keep a GMGN four* row on the board.
 * - Curve: agent tags only (classic fourmeme → detect miss / soft toast).
 * - Graduated: classic + openfour + agent (aiwb pancake-v2).
 */
function acceptFourGmgn(launchpad, graduated) {
  const p = String(launchpad || '').toLowerCase();
  if (!p.includes('four') && !FOUR_PLATS.has(p)) return false;
  if (graduated) return FOUR_GRAD_PLATS.has(p) || p.includes('four');
  return isFourAgentLaunchpad(p);
}

function ageMinFrom(t) {
  const ts = num(t?.created_timestamp) ?? num(t?.creation_timestamp);
  if (ts == null || ts <= 0) return null;
  const sec = ts > 1e12 ? ts / 1000 : ts;
  return Math.max(0, (Date.now() / 1000 - sec) / 60);
}

function toCard(t, { graduated }) {
  const platform = boardPlatform(t.launchpad_platform);
  if (!platform || !t.address) return null;
  // FOUR: drop classic fourmeme curve rows — aiwb cannot detect/buy them.
  if (platform === 'four' && !acceptFourGmgn(t.launchpad_platform, graduated)) return null;
  const mc = mcUsd(t);
  const price = num(t.price);
  const prog = progressPct(t, graduated);
  const createdAt = num(t.created_timestamp) ?? num(t.creation_timestamp);
  const createdSec = createdAt != null && createdAt > 1e12 ? Math.floor(createdAt / 1000) : createdAt;
  const lp = t.launchpad_platform || null;
  const fourAgent = platform === 'four' && isFourAgentLaunchpad(lp);
  // Graduated classic four → pancake via aiwb; agent curve → four-agent.
  // FLAP classic portal + agent both tradeable via aiwb (flap / flap-agent / pancake).
  const tradeVia = platform === 'four'
    ? (graduated && !fourAgent ? 'pancake' : 'four-agent')
    : (platform === 'flap' ? (graduated ? 'pancake' : 'flap') : null);
  const creatorHandle = t.creator_username || t.creator_name || t.twitter_username
    || t.creator?.twitter_username || t.creator?.name || null;
  const holders = holderCountFrom(t);
  const vol24 = volume24hFrom(t);
  return card({
    platform,
    address: t.address,
    tradeCa: t.address,
    name: t.name || t.symbol || '?',
    symbol: t.symbol || '?',
    quote: 'BNB',
    logoUrl: t.logo || null,
    progressPct: prog,
    graduated: !!graduated,
    fdvUsd: mc,
    mcUsd: mc,
    priceUsd: price,
    createdAt: createdSec,
    ageMin: ageMinFrom(t),
    tradeable: true,
    creatorHandle,
    devName: creatorHandle,
    holderCount: holders,
    volume24hUsd: vol24,
    extra: {
      source: 'gmgn',
      launchpad: lp,
      openTimestamp: num(t.open_timestamp) || null,
      liquidityUsd: num(t.liquidity),
      tradeVia,
      fourAgent: platform === 'four' ? fourAgent : undefined,
      creatorHandle: creatorHandle || null,
      holdersSource: holders != null ? 'gmgn' : null,
    },
  });
}

function buildBody(types) {
  const section = {
    filters: ['offchain', 'onchain'],
    launchpad_platform_v2: true,
    limit: LIMIT,
    launchpad_platform: ALL_PLATS,
    quote_address_type: BSC_QUOTE_TYPES,
  };
  const body = { version: 'v2' };
  for (const type of types) body[type] = { ...section };
  return body;
}

async function trenchesPost(apiKey, types) {
  const timestamp = Math.floor(Date.now() / 1000);
  const client_id = crypto.randomUUID();
  const qs = new URLSearchParams({
    chain: 'bsc',
    timestamp: String(timestamp),
    client_id,
  });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${HOST}/v1/trenches?${qs}`, {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        'X-APIKEY': apiKey,
        'Content-Type': 'application/json',
        'User-Agent': UA,
        Accept: 'application/json',
      },
      body: JSON.stringify(buildBody(types)),
    });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch {
      throw new Error(`gmgn trenches non-JSON HTTP ${r.status}`);
    }
    if (!r.ok || json.code !== 0) {
      throw new Error(`gmgn trenches ${r.status} code=${json.code} ${json.error || json.message || ''}`.trim());
    }
    return json.data || {};
  } finally {
    clearTimeout(timer);
  }
}

function emptyPad() {
  return { new: [], near: [], graduated: [], total: 0, error: null, source: 'gmgn' };
}

function splitPads(data, { nearMinPct = 50, nearMinMcUsd = 10_000, newLimit = 40, nearLimit = 40, gradLimit = 40 } = {}) {
  const flap = emptyPad();
  const four = emptyPad();
  const buckets = { flap, four };

  const pushUnique = (arr, item, limit) => {
    if (arr.length >= limit) return;
    if (arr.some(x => x.address === item.address)) return;
    arr.push(item);
  };

  const nearRaw = data.near_completion || data.pump || [];
  const completed = data.completed || [];
  const created = data.new_creation || [];

  // Graduated first
  for (const t of completed) {
    const c = toCard(t, { graduated: true });
    if (!c) continue;
    pushUnique(buckets[c.platform].graduated, c, gradLimit);
  }

  // Near-completion + high-MC new on curve
  const curveCandidates = [];
  for (const t of nearRaw) {
    const c = toCard(t, { graduated: false });
    if (c) curveCandidates.push(c);
  }
  for (const t of created) {
    const c = toCard(t, { graduated: false });
    if (c) curveCandidates.push(c);
  }

  const mcOf = x => {
    const v = Number(x?.mcUsd ?? x?.fdvUsd);
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const qualifiesNear = c => {
    const mc = mcOf(c);
    if (mc != null && mc >= nearMinMcUsd) return true;
    return (c.progressPct || 0) >= nearMinPct;
  };

  for (const plat of ['flap', 'four']) {
    const items = curveCandidates.filter(c => c.platform === plat);
    // dedupe preferring higher MC / progress
    const map = new Map();
    for (const c of items) {
      const prev = map.get(c.address);
      if (!prev) { map.set(c.address, c); continue; }
      const pm = mcOf(prev), cm = mcOf(c);
      if ((cm ?? 0) > (pm ?? 0) || (c.progressPct || 0) > (prev.progressPct || 0)) map.set(c.address, c);
    }
    const uniq = [...map.values()];
    const near = uniq.filter(qualifiesNear).sort((a, b) => {
      const ma = mcOf(a), mb = mcOf(b);
      if (ma != null && mb != null && ma !== mb) return mb - ma;
      if (ma != null && mb == null) return -1;
      if (ma == null && mb != null) return 1;
      return (b.progressPct || 0) - (a.progressPct || 0);
    });
    const nearAddrs = new Set(near.slice(0, nearLimit).map(c => c.address));
    buckets[plat].near = near.slice(0, nearLimit);
    buckets[plat].new = uniq
      .filter(c => !nearAddrs.has(c.address))
      .sort((a, b) => (a.ageMin ?? 1e9) - (b.ageMin ?? 1e9))
      .slice(0, newLimit);
    buckets[plat].graduated.sort((a, b) => (a.ageMin ?? 1e9) - (b.ageMin ?? 1e9));
    buckets[plat].total = buckets[plat].new.length + buckets[plat].near.length + buckets[plat].graduated.length;
  }

  return buckets;
}

/**
 * Merge RPC pad result with GMGN pad: dedupe by CA, prefer GMGN mc/price/progress when present.
 */
export function mergeGmgnIntoPad(rpcPad, gmgnPad) {
  const empty = { new: [], near: [], graduated: [], total: 0, error: null };
  const rpc = rpcPad || empty;
  const g = gmgnPad || empty;

  const by = new Map(); // address -> card
  const ingest = (list, preferGmgn) => {
    for (const c of list || []) {
      if (!c?.address) continue;
      const key = String(c.address).toLowerCase();
      const prev = by.get(key);
      if (!prev) {
        by.set(key, { ...c, address: key });
        continue;
      }
      // Prefer GMGN market fields; keep RPC tradeCa/market/extra when useful
      const useG = preferGmgn || c.extra?.source === 'gmgn';
      const next = { ...prev };
      if (useG) {
        if (c.mcUsd != null) next.mcUsd = c.mcUsd;
        if (c.fdvUsd != null) next.fdvUsd = c.fdvUsd;
        if (c.priceUsd != null) next.priceUsd = c.priceUsd;
        if (c.progressPct != null && (c.graduated || c.progressPct > (prev.progressPct || 0))) {
          next.progressPct = c.progressPct;
        }
        if (c.logoUrl && !prev.logoUrl) next.logoUrl = c.logoUrl;
        if (c.name && c.name !== '?') next.name = c.name;
        if (c.symbol && c.symbol !== '?') next.symbol = c.symbol;
        if (c.holderCount != null) next.holderCount = c.holderCount;
        if (c.volume24hUsd != null) next.volume24hUsd = c.volume24hUsd;
        next.extra = { ...(prev.extra || {}), ...(c.extra || {}) };
        if (c.graduated) next.graduated = true;
      } else {
        // RPC overlay: keep tradeCa/market from chain discovery
        if (c.tradeCa) next.tradeCa = c.tradeCa;
        if (c.market) next.market = c.market;
        if (c.extra) next.extra = { ...(next.extra || {}), ...c.extra, source: next.extra?.source || c.extra?.source };
        if (c.graduated) next.graduated = true;
        if (c.progressPct != null && !next.graduated) {
          next.progressPct = Math.max(next.progressPct || 0, c.progressPct || 0);
        }
        if (c.ageMin != null && (next.ageMin == null || c.ageMin < next.ageMin)) next.ageMin = c.ageMin;
        if (c.holderCount != null && next.holderCount == null) next.holderCount = c.holderCount;
        if (c.volume24hUsd != null && next.volume24hUsd == null) next.volume24hUsd = c.volume24hUsd;
      }
      by.set(key, next);
    }
  };

  // RPC first, then GMGN overlays MC / graduated
  ingest(rpc.new, false);
  ingest(rpc.near, false);
  ingest(rpc.graduated, false);
  ingest(g.new, true);
  ingest(g.near, true);
  ingest(g.graduated, true);

  const all = [...by.values()];
  const graduated = all.filter(c => c.graduated);
  const curve = all.filter(c => !c.graduated);
  const mcOf = x => {
    const v = Number(x?.mcUsd ?? x?.fdvUsd);
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const nearMinPct = Number(process.env.NEAR_MIN_PCT || 50);
  const nearMinMcUsd = Number(process.env.NEAR_MIN_MC_USD || 10_000);
  const near = curve.filter(c => {
    const mc = mcOf(c);
    return (mc != null && mc >= nearMinMcUsd) || (c.progressPct || 0) >= nearMinPct;
  }).sort((a, b) => {
    const ma = mcOf(a), mb = mcOf(b);
    if (ma != null && mb != null && ma !== mb) return mb - ma;
    if (ma != null && mb == null) return -1;
    if (ma == null && mb != null) return 1;
    return (b.progressPct || 0) - (a.progressPct || 0);
  });
  const nearAddrs = new Set(near.map(c => c.address));
  const newest = curve
    .filter(c => !nearAddrs.has(c.address))
    .sort((a, b) => (a.ageMin ?? 1e9) - (b.ageMin ?? 1e9));

  const errParts = [rpc.error, g.error].filter(Boolean);
  return {
    new: newest,
    near,
    graduated: graduated.sort((a, b) => (a.ageMin ?? 1e9) - (b.ageMin ?? 1e9)),
    total: all.length,
    error: errParts.length ? errParts.join(' | ') : null,
    gmgn: { new: g.new.length, near: g.near.length, graduated: g.graduated.length },
    rpc: { new: rpc.new?.length || 0, near: rpc.near?.length || 0, graduated: rpc.graduated?.length || 0 },
  };
}

/** Fetch GMGN flap+four columns. Returns { flap, four, error }. */
export async function fetchGmgnPads(opts = {}) {
  const apiKey = loadApiKey();
  if (!apiKey) {
    const miss = emptyPad();
    miss.error = 'GMGN_API_KEY missing';
    return { flap: miss, four: { ...miss }, error: miss.error };
  }
  try {
    const data = await trenchesPost(apiKey, ['new_creation', 'near_completion', 'completed']);
    const pads = splitPads(data, opts);
    return { flap: pads.flap, four: pads.four, error: null };
  } catch (e) {
    const miss = emptyPad();
    miss.error = e.message || String(e);
    return { flap: miss, four: { ...miss }, error: miss.error };
  }
}

const KLINE_TIMEOUT_MS = Number(process.env.GMGN_KLINE_TIMEOUT_MS || 15_000);
const KLINE_CACHE = new Map(); // key -> { at, payload }
/** Longer default TTL (was 20s) — K-line is expensive under GMGN rate limits. */
const KLINE_TTL_MS = Number(process.env.GMGN_KLINE_TTL_MS || 90_000);

function normalizeCandle(c) {
  const tRaw = Number(c?.time);
  // API may return ms or seconds
  const timeSec = Number.isFinite(tRaw) ? (tRaw > 1e12 ? Math.floor(tRaw / 1000) : Math.floor(tRaw)) : null;
  return {
    time: timeSec,
    open: num(c?.open),
    high: num(c?.high),
    low: num(c?.low),
    close: num(c?.close),
    volume: num(c?.volume),
    amount: num(c?.amount),
  };
}

function pruneKlineCache() {
  if (KLINE_CACHE.size <= 40) return;
  const oldest = [...KLINE_CACHE.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 10);
  for (const [k] of oldest) KLINE_CACHE.delete(k);
}

/**
 * Fetch OHLCV candles via GMGN OpenAPI (exist-auth). Does not scrape gmgn.ai.
 * On 429, prefer stale cache (like holders) and set rateLimited + Chinese error.
 * @param {{ address: string, resolution?: string, fromSec?: number, toSec?: number, hours?: number }} opts
 */
export async function fetchKline(opts = {}) {
  const address = String(opts.address || '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(address)) {
    return { ok: false, error: 'invalid ca', candles: [], source: 'GMGN' };
  }
  const resolution = String(opts.resolution || '1m');
  const allowed = new Set(['30s', '1m', '5m', '15m', '1h', '4h', '1d']);
  if (!allowed.has(resolution)) {
    return { ok: false, error: `unsupported resolution ${resolution}`, candles: [], source: 'GMGN' };
  }
  const hours = Math.min(24, Math.max(0.25, Number(opts.hours) || 2));
  const toSec = Number.isFinite(Number(opts.toSec)) ? Number(opts.toSec) : Math.floor(Date.now() / 1000);
  const fromSec = Number.isFinite(Number(opts.fromSec))
    ? Number(opts.fromSec)
    : toSec - Math.floor(hours * 3600);

  const cacheKey = `${address}|${resolution}|${fromSec}|${toSec}`;
  const hit = KLINE_CACHE.get(cacheKey);
  if (hit && Date.now() - hit.at < KLINE_TTL_MS) return hit.payload;

  const apiKey = loadApiKey();
  if (!apiKey) {
    return { ok: false, error: 'GMGN_API_KEY missing', candles: [], address, resolution, source: 'GMGN' };
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const client_id = crypto.randomUUID();
  const qs = new URLSearchParams({
    chain: 'bsc',
    address,
    resolution,
    from: String(fromSec * 1000),
    to: String(toSec * 1000),
    timestamp: String(timestamp),
    client_id,
  });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), KLINE_TIMEOUT_MS);
  try {
    const r = await fetch(`${HOST}/v1/market/token_kline?${qs}`, {
      method: 'GET',
      signal: ctl.signal,
      headers: {
        'X-APIKEY': apiKey,
        Accept: 'application/json',
        'User-Agent': UA,
      },
    });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch {
      return {
        ok: false,
        error: `GMGN K线非 JSON（HTTP ${r.status}）`,
        candles: [],
        address,
        resolution,
        source: 'GMGN',
      };
    }
    if (!r.ok || (json.code != null && json.code !== 0)) {
      if (isHoldersRateLimited(r.status, json)) {
        const resetHint = parseResetAt(json);
        if (hit?.payload?.candles?.length) {
          return {
            ...hit.payload,
            ok: true,
            source: hit.payload.source || 'GMGN',
            stale: true,
            rateLimited: true,
            ...(resetHint != null ? { resetHint } : {}),
          };
        }
        return {
          ok: false,
          rateLimited: true,
          error: 'GMGN K线接口限频，请稍后再试',
          candles: [],
          address,
          resolution,
          source: 'GMGN',
          ...(resetHint != null ? { resetHint } : {}),
        };
      }
      return {
        ok: false,
        error: `GMGN K线失败 HTTP ${r.status} ${json.error || json.message || ''}`.trim(),
        candles: [],
        address,
        resolution,
        source: 'GMGN',
      };
    }
    const raw = json.data?.list || json.list || (Array.isArray(json.data) ? json.data : []) || [];
    const candles = (Array.isArray(raw) ? raw : [])
      .map(normalizeCandle)
      .filter(c => c.time != null && c.open != null && c.close != null)
      .sort((a, b) => a.time - b.time);
    const payload = {
      ok: true,
      source: 'GMGN',
      address,
      resolution,
      from: fromSec,
      to: toSec,
      count: candles.length,
      candles,
    };
    KLINE_CACHE.set(cacheKey, { at: Date.now(), payload });
    pruneKlineCache();
    return payload;
  } catch (e) {
    if (hit?.payload?.candles?.length) {
      return { ...hit.payload, ok: true, source: hit.payload.source || 'GMGN', stale: true };
    }
    return {
      ok: false,
      error: e.message || String(e),
      candles: [],
      address,
      resolution,
      source: 'GMGN',
    };
  } finally {
    clearTimeout(timer);
  }
}

const HOLDERS_TIMEOUT_MS = Number(process.env.GMGN_HOLDERS_TIMEOUT_MS || 15_000);
const HOLDERS_CACHE = new Map(); // key -> { at, payload }
const HOLDERS_TTL_MS = Number(process.env.GMGN_HOLDERS_TTL_MS || 300_000);

function holderDisplayTags(h) {
  const tags = [];
  const seen = new Set();
  const add = (t) => {
    const k = String(t || '').toLowerCase();
    if (!k || seen.has(k)) return;
    seen.add(k);
    tags.push(k);
  };
  const raw = [
    ...(Array.isArray(h?.tags) ? h.tags : []),
    ...(Array.isArray(h?.maker_token_tags) ? h.maker_token_tags : []),
  ].map(t => String(t || '').toLowerCase());
  if (Number(h?.addr_type) === 2 || h?.exchange) add('pool');
  if (raw.some(t => t === 'dev' || t === 'dev_team' || t === 'creator')) add('dev');
  if (raw.some(t => t === 'kol' || t === 'renowned')) add('kol');
  if (raw.some(t => t === 'smart_degen' || t === 'pump_smart' || t === 'smart')) add('smart');
  return tags;
}

function normalizeHolder(h) {
  const address = String(h?.address || h?.account_address || '').trim().toLowerCase();
  const pctRaw = num(h?.amount_percentage);
  // GMGN returns fraction 0–1 (sometimes already percent); never invent.
  let holdPct = null;
  if (pctRaw != null) {
    holdPct = pctRaw <= 1.5 ? pctRaw * 100 : pctRaw;
    if (!Number.isFinite(holdPct)) holdPct = null;
  }
  const name =
    h?.name ||
    h?.twitter_name ||
    (h?.twitter_username ? `@${String(h.twitter_username).replace(/^@/, '')}` : null) ||
    null;
  const isPool = Number(h?.addr_type) === 2 || !!h?.exchange;
  return {
    address,
    name: name ? String(name) : null,
    holdPct,
    balance: num(h?.balance) ?? num(h?.amount_cur),
    usdValue: num(h?.usd_value),
    tags: holderDisplayTags(h),
    isPool,
    walletTag: h?.wallet_tag_v2 != null ? String(h.wallet_tag_v2) : null,
  };
}

/**
 * Fetch top token holders via GMGN OpenAPI (exist-auth). Mirrors fetchKline style.
 * @param {{ address: string, chain?: string, limit?: number }} opts
 */
function isHoldersRateLimited(status, json) {
  if (Number(status) === 429) return true;
  const code = json?.code;
  const msg = String(json?.error || json?.message || json?.msg || '').toUpperCase();
  if (code === 429 || code === '429') return true;
  if (msg.includes('RATE_LIMIT_EXCEEDED') || msg.includes('RATE_LIMIT_BANNED')) return true;
  if (msg.includes('RATE LIMIT') || msg.includes('TOO MANY REQUESTS')) return true;
  return false;
}

function parseResetAt(json) {
  const candidates = [
    json?.reset_at,
    json?.data?.reset_at,
    json?.resetAt,
    json?.data?.resetAt,
    json?.rate_limit?.reset_at,
  ];
  for (const v of candidates) {
    if (v == null || v === '') continue;
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    // accept unix sec or ms
    return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
  }
  return undefined;
}

function pruneHoldersCache() {
  if (HOLDERS_CACHE.size <= 40) return;
  const oldest = [...HOLDERS_CACHE.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 10);
  for (const [k] of oldest) HOLDERS_CACHE.delete(k);
}

/**
 * Fetch top token holders via GMGN OpenAPI (exist-auth). Mirrors fetchKline style.
 * On 429, prefer stale cache over dumping raw rate-limit text.
 * @param {{ address: string, chain?: string, limit?: number }} opts
 */
export async function fetchHolders(opts = {}) {
  const address = String(opts.address || '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(address)) {
    return { ok: false, error: 'invalid ca', holders: [], count: 0 };
  }
  const chain = String(opts.chain || 'bsc').toLowerCase();
  const limit = Math.min(100, Math.max(1, Number(opts.limit) || 20));

  const cacheKey = `${chain}|${address}|${limit}`;
  const hit = HOLDERS_CACHE.get(cacheKey);
  if (hit && Date.now() - hit.at < HOLDERS_TTL_MS) return hit.payload;

  const apiKey = loadApiKey();
  if (!apiKey) {
    return { ok: false, error: 'GMGN_API_KEY missing', holders: [], count: 0, address, chain };
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const client_id = crypto.randomUUID();
  const qs = new URLSearchParams({
    chain,
    address,
    limit: String(limit),
    order_by: 'amount_percentage',
    direction: 'desc',
    timestamp: String(timestamp),
    client_id,
  });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), HOLDERS_TIMEOUT_MS);
  try {
    const r = await fetch(`${HOST}/v1/market/token_top_holders?${qs}`, {
      method: 'GET',
      signal: ctl.signal,
      headers: {
        'X-APIKEY': apiKey,
        Accept: 'application/json',
        'User-Agent': UA,
      },
    });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch {
      return { ok: false, error: `gmgn holders non-JSON HTTP ${r.status}`, holders: [], count: 0, address, chain };
    }
    if (!r.ok || (json.code != null && json.code !== 0)) {
      if (isHoldersRateLimited(r.status, json)) {
        const resetHint = parseResetAt(json);
        // Prefer any stale cache (even past TTL) so UI can still show holders.
        if (hit?.payload?.holders?.length) {
          return {
            ...hit.payload,
            ok: true,
            stale: true,
            rateLimited: true,
            ...(resetHint != null ? { resetHint } : {}),
          };
        }
        return {
          ok: false,
          rateLimited: true,
          error: 'GMGN 持有人接口限频，请稍后再试',
          holders: [],
          count: 0,
          address,
          chain,
          ...(resetHint != null ? { resetHint } : {}),
        };
      }
      return {
        ok: false,
        error: `gmgn holders ${r.status} code=${json.code} ${json.error || json.message || ''}`.trim(),
        holders: [],
        count: 0,
        address,
        chain,
      };
    }
    const raw = json.data?.list || json.list || (Array.isArray(json.data) ? json.data : []) || [];
    const holders = (Array.isArray(raw) ? raw : [])
      .map(normalizeHolder)
      .filter(h => /^0x[a-f0-9]{40}$/.test(h.address));
    const payload = {
      ok: true,
      address,
      chain,
      count: holders.length,
      holders,
    };
    HOLDERS_CACHE.set(cacheKey, { at: Date.now(), payload });
    pruneHoldersCache();
    return payload;
  } catch (e) {
    return { ok: false, error: e.message || String(e), holders: [], count: 0, address, chain };
  } finally {
    clearTimeout(timer);
  }
}
