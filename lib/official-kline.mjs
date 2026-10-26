/**
 * Official launchpad candle/K-line fallbacks (no invented OHLCV).
 *
 * Verified endpoints (probed 2026-10-26 Asia/Shanghai):
 * - GANG stocks/V2/U (track=stocks): GET https://gang.fun/api/stocks/tokens/{ca}/candles?interval=1m|5m|15m|1h|4h|1d
 * - GANG soft: GET https://gang.fun/api/tokens/{ca}/candles?interval=…
 *   Shape: [{ t, o, h, l, c, v }, …]  (t=unix sec; o/h/l/c quote price; v volume)
 *
 * FLAP: no public candle/OHLCV API in docs.flap.sh (on-chain state + trade events only).
 * FOUR: meme-api/v1 documents search/detail/ranking/create — no kline; CF blocks live probe from this box.
 */
const GANG_API = (process.env.GANG_API || 'https://gang.fun/api').replace(/\/+$/, '');
const TIMEOUT_MS = Number(process.env.OFFICIAL_KLINE_TIMEOUT_MS || 12_000);
const CACHE = new Map(); // key -> { at, payload }
const TTL_MS = Number(process.env.OFFICIAL_KLINE_TTL_MS || 60_000);

const GANG_INTERVALS = new Set(['1m', '5m', '15m', '1h', '4h', '1d']);

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeGangCandle(c) {
  const tRaw = Number(c?.t ?? c?.time);
  const timeSec = Number.isFinite(tRaw) ? (tRaw > 1e12 ? Math.floor(tRaw / 1000) : Math.floor(tRaw)) : null;
  return {
    time: timeSec,
    open: num(c?.o ?? c?.open),
    high: num(c?.h ?? c?.high),
    low: num(c?.l ?? c?.low),
    close: num(c?.c ?? c?.close),
    volume: num(c?.v ?? c?.volume),
    amount: null,
  };
}

function mapGangInterval(resolution) {
  const r = String(resolution || '1m');
  // gang ignores unknown interval (observed 30s → ~5m bars); map 30s → 1m
  if (r === '30s') return '1m';
  if (GANG_INTERVALS.has(r)) return r;
  return null;
}

async function gangGet(path) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${GANG_API}${path}`, {
      signal: ctl.signal,
      headers: { accept: 'application/json' },
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: r.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve which gang candles path works for this CA.
 * Prefer track from token detail; else try stocks then soft.
 */
async function resolveGangCandlesPath(address) {
  const detail = await gangGet(`/tokens/${address}`);
  if (detail.status === 200 && detail.json && !detail.json.error) {
    const track = String(detail.json.track || '').toLowerCase();
    if (track === 'stocks') return `/stocks/tokens/${address}/candles`;
    return `/tokens/${address}/candles`;
  }
  // Fallback probe order: stocks (V2/U/S indexer) then soft
  const stocks = await gangGet(`/stocks/tokens/${address}/candles?interval=1d`);
  if (stocks.status === 200 && Array.isArray(stocks.json)) {
    return `/stocks/tokens/${address}/candles`;
  }
  const soft = await gangGet(`/tokens/${address}/candles?interval=1d`);
  if (soft.status === 200 && Array.isArray(soft.json)) {
    return `/tokens/${address}/candles`;
  }
  return null;
}

/**
 * @param {{ address: string, resolution?: string, fromSec?: number, toSec?: number, hours?: number }} opts
 */
export async function fetchGangKline(opts = {}) {
  const address = String(opts.address || '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(address)) {
    return { ok: false, error: 'invalid ca', candles: [], source: 'GANG' };
  }
  const interval = mapGangInterval(opts.resolution);
  if (!interval) {
    return {
      ok: false,
      error: `GANG 不支持周期 ${opts.resolution}`,
      candles: [],
      source: 'GANG',
      address,
      resolution: String(opts.resolution || ''),
    };
  }
  const hours = Math.min(168, Math.max(0.25, Number(opts.hours) || 2));
  const toSec = Number.isFinite(Number(opts.toSec)) ? Number(opts.toSec) : Math.floor(Date.now() / 1000);
  const fromSec = Number.isFinite(Number(opts.fromSec))
    ? Number(opts.fromSec)
    : toSec - Math.floor(hours * 3600);

  const cacheKey = `gang|${address}|${interval}|${fromSec}|${toSec}`;
  const hit = CACHE.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.payload;

  try {
    const basePath = await resolveGangCandlesPath(address);
    if (!basePath) {
      return {
        ok: false,
        error: 'GANG 无此 CA 的K线（非 gang.fun 代币或暂无数据）',
        candles: [],
        source: 'GANG',
        address,
        resolution: interval,
      };
    }
    const res = await gangGet(`${basePath}?interval=${encodeURIComponent(interval)}`);
    if (res.status === 404) {
      return {
        ok: false,
        error: 'GANG K线 404',
        candles: [],
        source: 'GANG',
        address,
        resolution: interval,
      };
    }
    if (res.status !== 200 || !Array.isArray(res.json)) {
      return {
        ok: false,
        error: `GANG K线 HTTP ${res.status}`,
        candles: [],
        source: 'GANG',
        address,
        resolution: interval,
      };
    }
    const candles = res.json
      .map(normalizeGangCandle)
      .filter(c => c.time != null && c.open != null && c.close != null)
      .filter(c => c.time >= fromSec && c.time <= toSec)
      .sort((a, b) => a.time - b.time);

    const payload = {
      ok: true,
      source: 'GANG',
      address,
      resolution: interval,
      from: fromSec,
      to: toSec,
      count: candles.length,
      candles,
    };
    CACHE.set(cacheKey, { at: Date.now(), payload });
    if (CACHE.size > 40) {
      const oldest = [...CACHE.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 10);
      for (const [k] of oldest) CACHE.delete(k);
    }
    return payload;
  } catch (e) {
    return {
      ok: false,
      error: e.message || String(e),
      candles: [],
      source: 'GANG',
      address,
      resolution: interval,
    };
  }
}

/**
 * Official K-line by platform. Only returns real upstream OHLCV — never invents candles.
 * @param {{ platform: string, address: string, resolution?: string, fromSec?: number, toSec?: number, hours?: number }} opts
 */
export async function fetchOfficialKline(opts = {}) {
  const platform = String(opts.platform || '').toLowerCase().trim();
  if (platform === 'gang') return fetchGangKline(opts);
  if (platform === 'flap') {
    return {
      ok: false,
      error: 'FLAP 官网无公开 K线/OHLCV API（仅链上状态与成交事件）',
      candles: [],
      source: 'FLAP',
      address: String(opts.address || '').toLowerCase(),
    };
  }
  if (platform === 'four' || platform === 'fourmeme') {
    return {
      ok: false,
      error: 'FOUR 官网 meme-api 未公开 K线接口（文档仅有 search/detail/ranking）',
      candles: [],
      source: 'FOUR',
      address: String(opts.address || '').toLowerCase(),
    };
  }
  return {
    ok: false,
    error: `无官方 K线源: ${platform || '(empty)'}`,
    candles: [],
    source: platform ? platform.toUpperCase() : null,
  };
}
