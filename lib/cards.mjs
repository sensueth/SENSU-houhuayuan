/** Shared card shape for the board UI. */
function normalizeDevName(raw) {
  if (raw == null || raw === '') return null;
  let s = String(raw).trim();
  if (!s) return null;
  // Prefer Agent ID / .ai handle — never a bare 0x wallet
  if (/^0x[a-fA-F0-9]{40}$/.test(s)) return null;
  // Strip leading @; keep .ai suffix
  s = s.replace(/^@+/, '');
  if (!s) return null;
  return s;
}

export function card({
  platform, address, market = null, name, symbol, quote = 'BNB',
  logoUrl = null, progressPct = 0, graduated = false, fdvUsd = null, mcUsd = null,
  priceUsd = null,
  createdAt = null, ageMin = null, pair = null, track = null, extra = null,
  tradeable = true, untradeableReason = null, tradeCa = null,
  creatorHandle = null, creatorAgentId = null, devName = null,
  holderCount = null, volume24hUsd = null,
  taxed = null, taxBps = null, taxDivSplit = null,
  quoteUsd = null,
}) {
  const ca = (address || '').toLowerCase();
  const tca = (tradeCa || address || '').toLowerCase();
  const dev = normalizeDevName(devName)
    || normalizeDevName(creatorHandle)
    || normalizeDevName(creatorAgentId)
    || normalizeDevName(extra?.creatorHandle)
    || normalizeDevName(extra?.creatorAgentId)
    || normalizeDevName(extra?.devName)
    || null;
  return {
    platform, // flap | gang | four
    address: ca,
    /** CA passed to aiwb buy/sell (may differ from display address, e.g. Flap market). */
    tradeCa: tca || ca,
    market: market ? String(market).toLowerCase() : null,
    name: name || symbol || '?',
    symbol: symbol || '?',
    quote: quote || 'BNB',
    logoUrl,
    progressPct: Number.isFinite(progressPct) ? Math.max(0, Math.min(100, Number(progressPct))) : 0,
    graduated: !!graduated,
    fdvUsd: fdvUsd == null ? null : Number(fdvUsd),
    mcUsd: mcUsd == null ? null : Number(mcUsd),
    priceUsd: priceUsd == null || priceUsd === '' ? null : Number(priceUsd),
    createdAt: createdAt == null ? null : Number(createdAt),
    ageMin: ageMin == null ? (createdAt ? Math.floor((Date.now() / 1000 - createdAt) / 60) : null) : ageMin,
    pair,
    track,
    agentOnly: true,
    shortCa: ca ? `${ca.slice(0, 6)}…${ca.slice(-4)}` : '',
    tradeable: tradeable !== false,
    untradeableReason: tradeable === false ? (untradeableReason || '不可交易') : null,
    gangPad: extra?.gangPad || null,
    tradePath: extra?.tradePath || null,
    /** Developer Agent ID / .ai username (e.g. bibi.ai) — not a wallet. */
    creatorHandle: normalizeDevName(creatorHandle) || null,
    creatorAgentId: normalizeDevName(creatorAgentId) || null,
    devName: dev,
    /** Total holder count when known from list/discovery (never invent). */
    holderCount: (() => {
      if (holderCount == null || holderCount === '') return null;
      const n = Number(holderCount);
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
    })(),
    /** 24h trading volume USD when known (never invent). */
    volume24hUsd: (() => {
      if (volume24hUsd == null || volume24hUsd === '') return null;
      const n = Number(volume24hUsd);
      return Number.isFinite(n) && n >= 0 ? n : null;
    })(),
    /** GANG stocks: transfer/buy-sell tax. null = unknown (non-GANG). */
    taxed: taxed == null ? null : !!taxed,
    taxBps: (() => {
      if (taxBps == null || taxBps === '') return null;
      const n = Number(taxBps);
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
    })(),
    /** e.g. "50/50" (holders/platform) or "v4.1-80/20" (protocol fee split). */
    taxDivSplit: taxDivSplit ? String(taxDivSplit) : null,
    /** USD price of the curve quote token when the indexer provided one. */
    quoteUsd: (() => {
      const n = Number(quoteUsd);
      return Number.isFinite(n) && n > 0 ? n : null;
    })(),
    extra,
  };
}

export function shortAge(ageMin) {
  if (ageMin == null || !Number.isFinite(ageMin)) return '—';
  if (ageMin < 60) return `${Math.max(0, Math.floor(ageMin))}m`;
  if (ageMin < 1440) return `${(ageMin / 60).toFixed(1)}h`;
  return `${(ageMin / 1440).toFixed(1)}d`;
}

export function formatUsd(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  if (n >= 1) return `$${n.toFixed(0)}`;
  return `$${n.toFixed(2)}`;
}
