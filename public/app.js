// AI WALLET CURVE — client. Polls /api/board. Buy/sell via POST /api/trade (aiwb + gang CLI for Soft/U/S).
const KEY = (() => {
  const m = location.search.match(/[?&]k=([a-f0-9]+)/i);
  if (m) {
    sessionStorage.setItem('curve-board-key', m[1]);
    history.replaceState(null, '', location.pathname);
    return m[1];
  }
  return sessionStorage.getItem('curve-board-key');
})();

const PAY_TOKEN_MAP = {
  BNB: 'BNB',
  GANG: '0x0c6302401aa5325c2e36f170f52c00b1d220b405',
  BNCB: '0x4902C5ebc598265Ed2212b559B042De8a5Eeec3f',
  NVDAB: '0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436',
  USDT: '0x55d398326f99059fF775485246999027B3197955',
};

const S = {
  filter: 'all',
  quoteFilter: 'all', // 底池筛选: all | BNB | GANG | BNCB | ...
  search: '',         // ticker / name / CA substring
  /** 已开盘 only: mc | holders | volume (high→low). */
  gradSort: (typeof localStorage !== 'undefined' && localStorage.getItem('curve-board-grad-sort')) || 'mc',
  newSort: (typeof localStorage !== 'undefined' && localStorage.getItem('curve-board-new-sort')) || 'created',
  nearSort: (typeof localStorage !== 'undefined' && localStorage.getItem('curve-board-near-sort')) || 'mc',
  board: null,
  timer: null,
  sellPct: '50',
  payKey: 'BNB', // symbol key or 'custom'
  payToken: 'BNB', // value sent to API: "BNB" | "0x..."
  buyMode: 'abs', // 'abs' (pay-token amount) | 'pct' (optional MC %)
  buyAmt: 0.05,   // absolute spend (BNB units for aiwb)
  buyPct: 0,      // optional; 0 = not using %
  busy: new Set(),
  holdings: null,
  holdPlat: (typeof localStorage !== 'undefined' && localStorage.getItem('curve-hold-plat')) || 'all',
  holdVal: (typeof localStorage !== 'undefined' && localStorage.getItem('curve-hold-val')) || 'all',
  holdPnl: (typeof localStorage !== 'undefined' && localStorage.getItem('curve-hold-pnl')) || 'all',
  holdSort: (typeof localStorage !== 'undefined' && localStorage.getItem('curve-hold-sort')) || 'value-desc',
  detail: null,       // coin object currently in drawer
  detailRes: '1m',
  detailHours: 2,
  detailCandles: null,
  detailKlineBusy: false,
  detailHoldersBusy: false,
  holdersByCa: {}, // ca -> { holders, count, at }
  xferPct: 100,   // default 转主钱包 %
  mainWallet: '',
  mainWalletShort: '',
};

/** User AI wallet — highlight in 持有人 list when present. Filled from /api/health. */
const USER_WALLET = '';
function myWalletAddr() {
  const live = S.board?.meta?.wallet?.address;
  return String(live || USER_WALLET || '').trim().toLowerCase();
}
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

function fmtUsd(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  if (n >= 1) return `$${n.toFixed(0)}`;
  return `$${n.toFixed(2)}`;
}
function fmtAge(m) {
  if (m == null || !Number.isFinite(m)) return '—';
  if (m < 60) return `${Math.max(0, Math.floor(m))}m`;
  if (m < 1440) return `${(m / 60).toFixed(1)}h`;
  return `${(m / 1440).toFixed(1)}d`;
}
/** Compact holder total for card title row — hide when unknown. */
function fmtHolders(n) {
  if (n == null || n === '' || !Number.isFinite(Number(n))) return null;
  const v = Math.floor(Number(n));
  if (v < 0) return null;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1).replace(/\.0$/, '')}m`;
  if (v >= 10_000) return `${(v / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
  if (v >= 1000) return `${(v / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
  return String(v);
}
function holdersHtml(c) {
  const s = fmtHolders(c?.holderCount);
  if (s == null) return '';
  return `<span class="hc" title="持有人 ${esc(String(Math.floor(Number(c.holderCount))))}">持有 ${esc(s)}</span>`;
}

/** GANG tax badge: 税1%·分红 / 无税. Title explains who gets it. */
function taxHtml(c) {
  if (!c || String(c.platform || '').toLowerCase() !== 'gang') return '';
  const taxed = c.taxed === true;
  const bps = Number(c.taxBps);
  const pct = Number.isFinite(bps) && bps > 0 ? (bps / 100) : (taxed ? 1 : 0);
  const split = c.taxDivSplit || c.extra?.taxDivSplit || '';
  if (taxed || pct > 0) {
    const title = [
      `买卖税 ${pct}%（有分红）`,
      '去向：50% 持有人分红（DividendVault，持仓可领）',
      '另 50%：80% 回购销毁平台 GANG + 20% feeVault',
      split ? `split=${split}` : '',
    ].filter(Boolean).join('\n');
    return `<span class="tax taxed" title="${esc(title)}">税${pct}%·分红</span>`;
  }
  const title = [
    '无买卖/转账分红税',
    '内盘仍有 1% 平台费：80% 回购销毁 GANG + 20% feeVault（0x3464…1Af4）',
    '毕业后该平台费为 0；亦无持有人分红',
    split ? `feeSplit=${split}` : '',
  ].filter(Boolean).join('\n');
  return `<span class="tax none" title="${esc(title)}">无税</span>`;
}


function isHexCa(s) {
  return typeof s === 'string' && /^0x[a-fA-F0-9]{40}$/.test(s.trim());
}

function shortCa(a) {
  if (!a || typeof a !== 'string') return '';
  if (a === 'BNB') return 'BNB';
  if (a.length < 12) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

async function api(path, opts = {}) {
  if (!KEY) throw new Error('缺少访问密钥 — 请用启动时打印的 URL 打开');
  const headers = { 'x-board-key': KEY, ...(opts.headers || {}) };
  const r = await fetch(path, { ...opts, headers });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(j.error || j.reason || r.statusText);
    err.body = j;
    err.status = r.status;
    throw err;
  }
  return j;
}

function logoEl(c) {
  if (c.logoUrl) {
    const img = document.createElement('img');
    img.className = 'logo';
    img.src = c.logoUrl;
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.onerror = () => { img.replaceWith(ph(c)); };
    return img;
  }
  return ph(c);
}
function ph(c) {
  const d = document.createElement('div');
  d.className = 'logo ph';
  d.textContent = (c.symbol || '?').slice(0, 2).toUpperCase();
  return d;
}

/** Resolve pay token from chip selection or custom CA/symbol input. */
function resolvePayToken() {
  const input = ($('#pay-ca')?.value || '').trim();
  if (input) {
    if (isHexCa(input)) {
      const lower = input.toLowerCase();
      for (const [sym, addr] of Object.entries(PAY_TOKEN_MAP)) {
        if (typeof addr === 'string' && addr.toLowerCase() === lower) {
          return { key: sym, token: addr === 'BNB' ? 'BNB' : addr, label: sym };
        }
      }
      return { key: 'custom', token: input, label: shortCa(input) };
    }
    const up = input.toUpperCase();
    if (Object.prototype.hasOwnProperty.call(PAY_TOKEN_MAP, up)) {
      const tok = PAY_TOKEN_MAP[up];
      return { key: up, token: tok, label: up };
    }
    // invalid custom — fall through to chip
  }
  const key = S.payKey && S.payKey !== 'custom' ? S.payKey : 'BNB';
  const tok = PAY_TOKEN_MAP[key] || 'BNB';
  return { key, token: tok, label: key };
}

function getPayToken() {
  const r = resolvePayToken();
  S.payToken = r.token;
  return r;
}

/** Known quote pay keys we can spend directly (must exist in PAY_TOKEN_MAP). */
const QUOTE_PAY_KEYS = ['GANG', 'BNCB', 'NVDAB'];

function holdingForPayKey(key) {
  const tok = PAY_TOKEN_MAP[key];
  if (!tok || !S.holdings?.items) return null;
  const low = String(tok).toLowerCase();
  if (key === 'BNB') {
    return S.holdings.items.find(it => {
      const a = String(it.address || '').toLowerCase();
      const sym = String(it.symbol || '').toUpperCase();
      return it.platform === 'native' || a === 'bnb' || sym === 'BNB';
    }) || null;
  }
  // Quote pay tokens: match by CA only — memes often reuse $GANG / $BNCB tickers.
  return S.holdings.items.find(it => String(it.address || '').toLowerCase() === low) || null;
}

function payKeyUsdPrice(key) {
  const it = holdingForPayKey(key);
  if (!it) return null;
  const amt = Number(it.amount);
  const usd = it.valueUsd != null ? Number(it.valueUsd) : (it.usd != null ? Number(it.usd) : null);
  if (!(Number.isFinite(amt) && amt > 0 && Number.isFinite(usd) && usd > 0)) return null;
  return usd / amt;
}

function quotePayKeyForCard(coin) {
  if (!coin) return null;
  const q = String(coin.quote || '').trim().toUpperCase();
  if (QUOTE_PAY_KEYS.includes(q) && PAY_TOKEN_MAP[q]) return q;
  const qa = String(coin.extra?.quoteAddress || coin.quoteAddress || '').toLowerCase();
  if (qa && /^0x[a-f0-9]{40}$/.test(qa)) {
    for (const k of QUOTE_PAY_KEYS) {
      if (String(PAY_TOKEN_MAP[k]).toLowerCase() === qa) return k;
    }
  }
  return null;
}

/**
 * Prefer paying with the card's quote token when wallet balance covers the buy.
 * Converts abs amount BNB→quote via holdings USD; falls back to BNB if short.
 */
function preferPayTokenForCard(coin) {
  const qKey = quotePayKeyForCard(coin);
  if (!qKey) return { switched: false, key: getPayToken().key, reason: 'quote-not-payabled' };

  const hold = holdingForPayKey(qKey);
  const bal = hold ? Number(hold.amount) : 0;
  if (!(bal > 0)) return { switched: false, key: getPayToken().key, reason: `no-${qKey}-balance` };

  const size = getBuySize();
  const qPx = payKeyUsdPrice(qKey);
  let need = null;

  if (size.mode === 'pct') {
    const mc = Number(coin?.mcUsd ?? coin?.fdvUsd);
    if (Number.isFinite(mc) && mc > 0 && qPx) need = (size.pct / 100) * mc / qPx;
  } else {
    const amt = Number(size.amount);
    const cur = getPayToken();
    if (cur.key === qKey) need = amt;
    else if (cur.key === 'BNB' || cur.key === 'WBNB') {
      const bnbPx = payKeyUsdPrice('BNB') || payKeyUsdPrice('WBNB');
      if (Number.isFinite(amt) && amt > 0 && bnbPx && qPx) need = (amt * bnbPx) / qPx;
    } else {
      const curPx = payKeyUsdPrice(cur.key);
      if (Number.isFinite(amt) && amt > 0 && curPx && qPx) need = (amt * curPx) / qPx;
    }
  }

  if (!(Number.isFinite(need) && need > 0)) {
    need = Math.min(bal, Math.max(bal * 0.05, 1));
  }
  if (bal + 1e-12 < need) {
    // Quote too small. Prefer user's explicit pay CA (USDT etc.) — NEVER clear it or force BNB.
    const payCaEl = $('#pay-ca');
    const explicit = (payCaEl?.value || '').trim();
    const cur = getPayToken();
    if (explicit && /^0x[a-fA-F0-9]{40}$/i.test(explicit)) {
      const isUsdt = explicit.toLowerCase() === String(PAY_TOKEN_MAP.USDT || '').toLowerCase();
      if (isUsdt || S.payKey === 'USDT') {
        S.payKey = 'USDT';
        const size0 = getBuySize();
        const mc = Number(coin?.mcUsd ?? coin?.fdvUsd);
        let usdtAmt = null;
        if (size0.mode === 'pct' && Number.isFinite(mc) && mc > 0) usdtAmt = (size0.pct / 100) * mc;
        else if (Number.isFinite(need) && need > 0 && Number.isFinite(qPx) && qPx > 0) usdtAmt = need * qPx;
        if (Number.isFinite(usdtAmt) && usdtAmt > 0) {
          S.buyMode = 'abs';
          S.buyAmt = Math.round(usdtAmt * 100) / 100;
          S.buyPct = 0;
          const amtEl = $('#buy-amt');
          if (amtEl) amtEl.value = String(S.buyAmt);
          const pctEl = $('#buy-pct');
          if (pctEl) pctEl.value = '';
        }
        syncPayUI();
        syncBuyUI();
        syncBuyButtons();
        return { switched: true, key: 'USDT', reason: `insufficient-${qKey}-keep-USDT`, bal, need, fallback: true, usdtAmt };
      }
      return { switched: false, key: cur.key, reason: `insufficient-${qKey}-keep-payCa`, bal, need, fallback: false, keepPay: explicit };
    }
    // No explicit pay CA: if wallet has USDT, switch pay to USDT instead of BNB
    const usdtHold = holdingForPayKey('USDT');
    const usdtBal = usdtHold ? Number(usdtHold.amount) : 0;
    if (usdtBal > 0) {
      S.payKey = 'USDT';
      if (payCaEl) payCaEl.value = '';
      const size0 = getBuySize();
      const mc = Number(coin?.mcUsd ?? coin?.fdvUsd);
      let usdtAmt = null;
      if (size0.mode === 'pct' && Number.isFinite(mc) && mc > 0) usdtAmt = (size0.pct / 100) * mc;
      else if (Number.isFinite(need) && need > 0 && Number.isFinite(qPx) && qPx > 0) usdtAmt = need * qPx;
      if (Number.isFinite(usdtAmt) && usdtAmt > 0) {
        S.buyMode = 'abs';
        S.buyAmt = Math.round(usdtAmt * 100) / 100;
        S.buyPct = 0;
        const amtEl = $('#buy-amt');
        if (amtEl) amtEl.value = String(S.buyAmt);
        const pctEl = $('#buy-pct');
        if (pctEl) pctEl.value = '';
      }
      syncPayUI();
      syncBuyUI();
      syncBuyButtons();
      return { switched: true, key: 'USDT', reason: `insufficient-${qKey}-use-USDT`, bal, need, fallback: true, usdtAmt };
    }
    return { switched: false, key: cur.key, reason: `insufficient-${qKey}`, bal, need, fallback: false };
  }

  const prevKey = S.payKey;
  S.payKey = qKey;
  const payCa = $('#pay-ca');
  if (payCa) payCa.value = '';

  // Quote-direct needs absolute quote units. Convert both abs and % → abs once we know `need`.
  if (Number.isFinite(need) && need > 0 && (size.mode !== 'pct' ? prevKey !== qKey : true)) {
    let rounded = need;
    if (need >= 1000) rounded = Math.round(need);
    else if (need >= 10) rounded = Math.round(need * 100) / 100;
    else rounded = Math.round(need * 1e4) / 1e4;
    S.buyMode = 'abs';
    S.buyAmt = rounded;
    S.buyPct = 0;
    const amtEl = $('#buy-amt');
    if (amtEl) amtEl.value = String(rounded);
    const pctEl = $('#buy-pct');
    if (pctEl) pctEl.value = '';
    $$('#amt-chips .amt-chip').forEach(b => b.classList.toggle('on', Number(b.dataset.amt) === rounded));
    $$('#size-chips .size-chip').forEach(b => b.classList.remove('on'));
  }

  syncPayUI();
  syncBuyUI();
  syncBuyButtons();
  return { switched: prevKey !== qKey, key: qKey, reason: 'ok', need, bal };
}

function getBuySize() {
  // Prefer explicit custom inputs; abs and pct are mutually exclusive.
  const amtEl = $('#buy-amt');
  const pctEl = $('#buy-pct');
  const customAmt = amtEl ? Number(amtEl.value) : NaN;
  const customPct = pctEl ? Number(pctEl.value) : NaN;
  if (S.buyMode === 'pct' || (Number.isFinite(customPct) && customPct > 0 && document.activeElement === pctEl)) {
    let pct = S.buyPct;
    if (Number.isFinite(customPct) && customPct > 0) pct = customPct;
    if (Number.isFinite(pct) && pct > 0) return { mode: 'pct', pct, label: `${pct}%` };
  }
  let amt = S.buyAmt;
  if (Number.isFinite(customAmt) && customAmt > 0) amt = customAmt;
  if (Number.isFinite(amt) && amt > 0) {
    const pay = getPayToken().label || 'BNB';
    return { mode: 'abs', amount: String(amt), label: `${amt} ${pay}` };
  }
  // fall back to pct if abs empty but pct set
  let pct = S.buyPct;
  if (Number.isFinite(customPct) && customPct > 0) pct = customPct;
  if (Number.isFinite(pct) && pct > 0) return { mode: 'pct', pct, label: `${pct}%` };
  return { mode: 'abs', amount: '', label: '' };
}

function getSellAmount() {
  return `${S.sellPct}%`;
}

function shortHash(h) {
  if (!h || typeof h !== 'string') return '';
  if (h.length < 12) return h;
  return `${h.slice(0, 8)}…${h.slice(-4)}`;
}

let toastTimer = null;
function toast(msg, kind = '') {
  const el = $('#toast');
  if (!el) return;
  el.hidden = false;
  el.className = `toast ${kind}`.trim();
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 6000);
}

/** Clipboard with LAN-http fallback (clipboard API needs secure context). */
async function copyText(text) {
  const t = String(text || '');
  if (!t) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(t);
      return true;
    }
  } catch (_) { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return !!ok;
  } catch (_) {
    return false;
  }
}

async function copyCa(ca) {
  if (!ca) return;
  const ok = await copyText(ca);
  toast(ok ? '已复制 CA' : '复制失败', ok ? 'ok' : 'err');
}

function setCardStatus(el, text, kind = '') {
  let st = el.querySelector('.trade-status');
  if (!st) {
    st = document.createElement('div');
    st.className = 'trade-status';
    el.append(st);
  }
  st.className = `trade-status ${kind}`.trim();
  st.textContent = text || '';
  st.hidden = !text;
}

function syncBuyButtons() {
  const size = getBuySize();
  const sizeOk = size.mode === 'pct' ? size.pct > 0 : Number(size.amount) > 0;
  $$('.btn-buy').forEach(b => {
    if (b.dataset.busy === '1') return;
    const card = b.closest('.card');
    const ca = card?.dataset?.ca;
    const coin = findCoin(ca);
    const canTrade = !coin || coin.tradeable !== false;
    const ok = sizeOk && canTrade;
    b.disabled = !ok;
    b.textContent = !canTrade ? '不可买' : (sizeOk ? `买 ${size.label}` : '买');
    b.title = !canTrade
      ? (coin?.untradeableReason || 'aiwb 不支持')
      : (sizeOk
        ? `买入 ${size.label}（支付 ${getPayToken().label}）`
        : '请先选支付币后面的数量（或可选 %）');
  });
}

function findCoin(ca) {
  if (!ca || !S.board) return null;
  const low = ca.toLowerCase();
  for (const col of ['new', 'near', 'graduated']) {
    const hit = (S.board[col] || []).find(c => (c.address || '').toLowerCase() === low || (c.tradeCa || '').toLowerCase() === low);
    if (hit) return hit;
  }
  return null;
}

function syncPayUI() {
  const r = getPayToken();
  const hasCustom = !!($('#pay-ca')?.value || '').trim();
  $$('#pay-chips .pay-chip').forEach(b => {
    const on = !hasCustom && b.dataset.pay === r.key;
    b.classList.toggle('on', on);
  });
  const hint = $('#pay-picked');
  if (hint) hint.textContent = r.label || '未选';
  sessionStorage.setItem('curve-pay-token', r.key === 'custom' ? 'custom' : r.key);
  sessionStorage.setItem('curve-pay-ca', ($('#pay-ca')?.value || '').trim());
}

function syncBuyUI() {
  const amtEl = $('#buy-amt');
  const pctEl = $('#buy-pct');
  const customAmt = amtEl ? Number(amtEl.value) : NaN;
  const customPct = pctEl ? Number(pctEl.value) : NaN;
  const usingCustomAmt = Number.isFinite(customAmt) && customAmt > 0;
  const usingCustomPct = Number.isFinite(customPct) && customPct > 0;

  if (S.buyMode === 'abs') {
    if (usingCustomAmt) S.buyAmt = customAmt;
    S.buyPct = 0;
    if (pctEl && pctEl.value) pctEl.value = '';
  } else {
    if (usingCustomPct) S.buyPct = customPct;
    if (amtEl && amtEl.value) amtEl.value = '';
  }

  $$('#amt-chips .amt-chip').forEach(b => {
    const bn = Number(b.dataset.amt);
    b.classList.toggle(
      'on',
      S.buyMode === 'abs' && !usingCustomAmt && Number.isFinite(S.buyAmt) && bn === S.buyAmt,
    );
  });
  $$('#size-chips .size-chip').forEach(b => {
    const bn = Number(b.dataset.pct);
    b.classList.toggle(
      'on',
      S.buyMode === 'pct' && !usingCustomPct && Number.isFinite(S.buyPct) && bn === S.buyPct,
    );
  });

  const size = getBuySize();
  const hint = $('#buy-picked');
  if (hint) hint.textContent = size.label || '未选';
  sessionStorage.setItem('curve-buy-mode', S.buyMode);
  sessionStorage.setItem('curve-buy-amt', S.buyMode === 'abs' && S.buyAmt > 0 ? String(S.buyAmt) : '');
  sessionStorage.setItem('curve-buy-pct', S.buyMode === 'pct' && S.buyPct > 0 ? String(S.buyPct) : '');
  syncBuyButtons();
}

async function doTrade(side, card, ca, btn, coin = null) {
  const tradeCa = (coin?.tradeCa || ca || '').trim();
  const key = `${side}:${tradeCa.toLowerCase()}`;
  if (S.busy.has(key)) return;

  if (coin && coin.tradeable === false) {
    const why = coin.untradeableReason || '此币不可用 aiwb 交易';
    toast(why, 'err');
    setCardStatus(card, why, 'err');
    return;
  }

  let amount;
  let payToken;
  let payLabel;
  if (side === 'buy') {
    // Prefer card quote (GANG/BNCB/…) when wallet holds enough — avoid BNB→quote hop.
    const pref = preferPayTokenForCard(coin);
    if (pref.switched) {
      toast(`支付已切到 ${pref.key}（底池报价币）`, 'ok');
    } else if (pref.reason && String(pref.reason).startsWith('insufficient-')) {
      const qk = quotePayKeyForCard(coin) || '';
      if (pref.fallback || pref.key === 'BNB') {
        const balS = Number.isFinite(pref.bal) ? pref.bal.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '?';
        const needS = Number.isFinite(pref.need) ? pref.need.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '?';
        toast(`${qk} 不足（有 ${balS} / 需 ${needS}），请用 USDT 支付（勿花 BNB）`, 'pending');
      } else {
        toast(`钱包 ${qk} 不足本次买入，仍用 ${getPayToken().label}（可能先换报价币）`, 'pending');
      }
    }
    const size = getBuySize();
    const ok = size.mode === 'pct' ? size.pct > 0 : Number(size.amount) > 0;
    if (!ok) {
      toast('请先选支付币后面的数量（或可选 %）', 'err');
      return;
    }
    amount = size.mode === 'pct' ? `${size.pct}%` : size.amount;
    const pay = getPayToken();
    payToken = pay.token;
    payLabel = pay.label;
  } else {
    amount = getSellAmount();
  }

  S.busy.add(key);
  btn.dataset.busy = '1';
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = '…';
  setCardStatus(card, side === 'buy' ? '检查中…' : '下单中…', 'pending');
  toast(
    side === 'buy'
      ? `检查并买入 ${amount}（付 ${payLabel}）…`
      : `卖出 ${amount}…`,
    'pending',
  );
  try {
    if (side === 'buy') setCardStatus(card, '检查中 / 下单中…', 'pending');
    const body = { side, ca: tradeCa, tradeCa, amount };
    if (coin?.platform) body.platform = coin.platform;
    if (coin?.track) body.track = coin.track;
    if (coin?.graduated != null) body.graduated = !!coin.graduated;
    if (coin?.market) body.market = coin.market;
    if (coin?.gangPad) body.gangPad = coin.gangPad;
    if (coin?.tradePath) body.tradePath = coin.tradePath;
    if (side === 'buy') {
      body.payToken = payToken;
      const mc = coin?.mcUsd ?? coin?.fdvUsd;
      if (mc != null && Number.isFinite(Number(mc))) body.mcUsd = Number(mc);
      const bnb = S.board?.meta?.bnbUsd;
      if (bnb != null && Number.isFinite(Number(bnb))) body.bnbUsd = Number(bnb);
      const qKey = quotePayKeyForCard(coin);
      const payIsQuote = qKey && String(payToken).toLowerCase() === String(PAY_TOKEN_MAP[qKey] || '').toLowerCase();
      if (payIsQuote) {
        let qpx = payKeyUsdPrice(qKey);
        // Soft curves quote in BNB — board bnbUsd is the quote USD price.
        if (!qpx && (qKey === 'BNB' || qKey === 'WBNB') && body.bnbUsd) qpx = body.bnbUsd;
        if (!qpx && coin?.quoteUsd != null && Number.isFinite(Number(coin.quoteUsd))) qpx = Number(coin.quoteUsd);
        if (qpx) body.quoteUsd = qpx;
        body.quoteSymbol = qKey;
      }
      // % buy needs card MC for any pay token (BNB/USDT/quote).
      if (getBuySize().mode === 'pct' && !(body.mcUsd > 0)) {
        toast('按 % 买入需要卡片市值；请改填绝对数量（如 100），或等市值刷新后再试', 'err');
        S.busy.delete(key);
        btn.dataset.busy = '';
        btn.disabled = false;
        btn.textContent = label;
        return;
      }
      // % + quote-direct without quote price cannot size.
      if (getBuySize().mode === 'pct' && payIsQuote && !body.quoteUsd) {
        toast('报价币按 % 买入需要报价币价格（持仓估值）。可改填绝对数量，或等持仓加载后再试', 'err');
        S.busy.delete(key);
        btn.dataset.busy = '';
        btn.disabled = false;
        btn.textContent = label;
        return;
      }
    }
    const j = await api('/api/trade', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const hash = j.result?.hash || j.result?.txHash || j.result?.execute?.txHash || '';
    const padLabel = j.pad ? `pad=${j.pad}` : '';
    let msg;
    if (j.needsAppConfirm || j.pendingConfirmation) {
      msg = `待 App 确认${hash ? ' ' + shortHash(hash) : ''} — 打开币安 App 确认卖出/交易`;
    } else if (j.dry || j.result?.dry) {
      msg = `预览 OK（未广播）${padLabel ? ' · ' + padLabel : ''}`;
      const out = j.result?.expectOut || j.result?.preview?.expectOut;
      const rid = j.result?.requestId || j.result?.preview?.requestId;
      if (out) msg += ` · out ${out}`;
      if (rid) msg += ` · req ${String(rid).slice(0, 8)}…`;
    } else if (hash) {
      msg = `${side === 'buy' ? '买成' : '卖成'} ${shortHash(hash)}`;
    } else if (j.result?.dryRun) {
      msg = 'dry-run 成功';
    } else {
      msg = '成功';
    }
    if (padLabel && !msg.includes(padLabel)) msg += ` · ${padLabel}`;
    if (j.tradePath) msg += ` · ${j.tradePath}`;
    if (j.note) msg += ` · ${j.note}`;
    if (j.bnbSpend) msg += ` · ~${j.bnbSpend} BNB`;
    if (j.sellApprove) {
      const sa = j.sellApprove;
      if (sa.needsAppConfirm || sa.pendingConfirmation) msg += ' · 卖出授权待 App 确认';
      else if (sa.approved) msg += sa.hash ? ` · 已开卖出授权 ${shortHash(sa.hash)}` : ' · 已开卖出授权';
      else if (sa.skipped) msg += ' · 卖出授权已就绪';
      else if (sa.ok === false) msg += ` · 卖出授权失败`;
    }
    if (j.checkMs != null || j.buyMs != null) {
      const parts = [];
      if (j.cachedCheck) parts.push('check缓存');
      if (j.checkMs != null) parts.push(`check ${j.checkMs}ms`);
      if (j.buyMs != null) parts.push(`buy ${j.buyMs}ms`);
      if (j.tookMs != null) parts.push(`总 ${j.tookMs}ms`);
      if (parts.length) msg += ` · ${parts.join(' / ')}`;
    }
    const kind = (j.needsAppConfirm || j.pendingConfirmation) ? 'pending' : 'ok';
    setCardStatus(card, msg, kind);
    toast(msg, kind === 'pending' ? 'pending' : 'ok');
    if (side === 'buy' || side === 'sell') refreshHoldings(true);
  } catch (e) {
    const detail = e.body?.error || e.body?.reason || e.message || '失败';
    const short = String(detail).slice(0, 120);
    setCardStatus(card, short, 'err');
    toast(short, 'err');
  } finally {
    S.busy.delete(key);
    btn.dataset.busy = '0';
    btn.textContent = label;
    if (side === 'buy') syncBuyButtons();
    else btn.disabled = false;
  }
}


function holdingAmountForCa(ca) {
  const it = findHoldingForCa(ca);
  if (!it) return 0;
  const n = Number(it.amount);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function updateXferDestHint() {
  const el = $('#xfer-dest');
  if (!el) return;
  const short = S.mainWalletShort || shortCa(S.mainWallet) || '主钱包';
  el.textContent = `转账→${short}`;
  el.title = `转主钱包固定收款：${S.mainWallet || ''}`;
}

/** Build compact 转主钱包 row (chips + optional amount + button). */
function buildXferRow({ ca, coin = null, idPrefix = '' }) {
  const row = document.createElement('div');
  row.className = 'xfer-row';
  row.dataset.ca = ca || '';

  const chips = document.createElement('div');
  chips.className = 'xfer-chips';
  chips.setAttribute('role', 'group');
  chips.setAttribute('aria-label', '转主钱包比例');
  for (const pct of [25, 50, 100]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'xfer-chip' + (Number(S.xferPct) === pct ? ' on' : '');
    b.dataset.pct = String(pct);
    b.textContent = `${pct}%`;
    b.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      S.xferPct = pct;
      row.querySelectorAll('.xfer-chip').forEach(c => c.classList.toggle('on', Number(c.dataset.pct) === pct));
      const inp = row.querySelector('.xfer-amt');
      if (inp) inp.value = '';
      // keep detail chips in sync
      $$('#detail-xfer .xfer-chip').forEach(c => c.classList.toggle('on', Number(c.dataset.pct) === pct));
    });
    chips.append(b);
  }

  const wrap = document.createElement('label');
  wrap.className = 'xfer-amt-wrap';
  const inp = document.createElement('input');
  inp.type = 'number';
  inp.className = 'xfer-amt';
  inp.step = 'any';
  inp.min = '0';
  inp.placeholder = '数量';
  inp.inputMode = 'decimal';
  if (idPrefix) inp.id = `${idPrefix}-xfer-amt`;
  inp.addEventListener('click', e => e.stopPropagation());
  inp.addEventListener('input', () => {
    if (inp.value && Number(inp.value) > 0) {
      row.querySelectorAll('.xfer-chip').forEach(c => c.classList.remove('on'));
    }
  });
  wrap.append(inp);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn-xfer';
  btn.textContent = '转主钱包';
  btn.title = `转到主钱包 ${S.mainWalletShort || shortCa(S.mainWallet)}`;
  btn.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    const abs = (inp.value || '').trim();
    let opts;
    if (abs && Number(abs) > 0) opts = { amount: abs };
    else {
      const on = row.querySelector('.xfer-chip.on');
      const pct = on ? Number(on.dataset.pct) : Number(S.xferPct) || 100;
      opts = pct >= 100 ? { max: true, percent: 100 } : { percent: pct };
    }
    doTransfer(ca, btn, coin, opts, row.closest('.card') || row);
  });

  row.append(chips, wrap, btn);
  return row;
}

function syncCardXferRows() {
  $$('.card[data-ca]').forEach(el => {
    const ca = el.dataset.tradeCa || el.dataset.ca || '';
    const side = el.querySelector('.side');
    if (!side) return;
    let row = side.querySelector('.xfer-row');
    const amt = holdingAmountForCa(ca) || holdingAmountForCa(el.dataset.ca);
    if (!(amt > 0)) {
      row?.remove();
      return;
    }
    if (!row) {
      row = buildXferRow({ ca, coin: { address: el.dataset.ca, tradeCa: el.dataset.tradeCa, platform: el.dataset.platform } });
      side.append(row);
    } else {
      row.dataset.ca = ca;
    }
  });
  syncDetailXfer();
}

function syncDetailXfer() {
  const box = $('#detail-xfer');
  if (!box) return;
  const c = S.detail;
  if (!c) { box.hidden = true; return; }
  const ca = c.tradeCa || c.address || '';
  const it = findHoldingForCa(c.address) || findHoldingForCa(c.tradeCa);
  const amt = it && Number(it.amount) > 0 ? Number(it.amount) : 0;
  // Hide for native / zero; show for ERC20 holdings (incl. pre-grad — send may fail with clear error)
  const isNative = !ca || ca === 'BNB' || /^BNB$/i.test(ca);
  box.hidden = !(amt > 0 && !isNative);
  if (!box.hidden) {
    box.dataset.ca = ca;
    const btn = $('#detail-xfer-btn');
    if (btn) btn.title = `转到主钱包 ${S.mainWalletShort || shortCa(S.mainWallet)} · 持仓 ${fmtCardHoldAmt(it) || amt}`;
  }
}

async function doTransfer(ca, btn, coin = null, opts = {}, cardEl = null) {
  const tradeCa = String(coin?.tradeCa || ca || '').trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(tradeCa)) {
    toast('无效 CA，无法转账', 'err');
    return;
  }
  const key = `xfer:${tradeCa.toLowerCase()}`;
  if (S.busy.has(key)) return;

  const body = { ca: tradeCa, tradeCa };
  if (opts.max) body.max = true;
  else if (opts.percent != null) body.percent = opts.percent;
  else if (opts.amount != null) body.amount = String(opts.amount);
  else body.max = true;

  // Soft warn for ungraduated — still allow click (send may fail)
  if (coin && coin.graduated === false) {
    toast('曲线未毕业代币可能无法转账，正在尝试…', 'pending');
  }

  S.busy.add(key);
  if (btn) {
    btn.dataset.busy = '1';
    btn.disabled = true;
  }
  const label = btn?.textContent || '转主钱包';
  if (btn) btn.textContent = '…';
  const sizeHint = body.max ? '全部' : (body.percent != null ? `${body.percent}%` : body.amount);
  toast(`转主钱包 ${sizeHint} → ${S.mainWalletShort || '主钱包'}…`, 'pending');
  if (cardEl && typeof setCardStatus === 'function') {
    setCardStatus(cardEl, `转账中 ${sizeHint}…`, 'pending');
  }
  setDetailTradeStatus(`转账中 ${sizeHint}…`, 'pending');

  try {
    const j = await api('/api/transfer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const hash = j.txHash || '';
    let msg;
    if (j.needsAppConfirm || j.pendingConfirmation) {
      msg = `转账待 App 确认${hash ? ' ' + shortHash(hash) : ''} — 打开币安 App 确认`;
    } else if (hash) {
      msg = `已转出 ${shortHash(hash)} → ${S.mainWalletShort || shortCa(j.recipient)}`;
    } else {
      msg = j.note || '转账已提交';
    }
    if (j.note && !msg.includes(j.note)) msg += ` · ${j.note}`;
    const kind = (j.needsAppConfirm || j.pendingConfirmation) ? 'pending' : 'ok';
    toast(msg, kind === 'pending' ? 'pending' : 'ok');
    if (cardEl && typeof setCardStatus === 'function') setCardStatus(cardEl, msg, kind);
    setDetailTradeStatus(msg, kind);
    refreshHoldings(true);
  } catch (e) {
    const detail = e.body?.error || e.body?.reason || e.message || '转账失败';
    const short = String(detail).slice(0, 160);
    toast(short, 'err');
    if (cardEl && typeof setCardStatus === 'function') setCardStatus(cardEl, short, 'err');
    setDetailTradeStatus(short, 'err');
  } finally {
    S.busy.delete(key);
    if (btn) {
      btn.dataset.busy = '0';
      btn.disabled = false;
      btn.textContent = label;
    }
  }
}

/** DEV Agent ID / .ai username — right of pad tags (e.g. BIBI.AI). */
function formatDevName(c) {
  const raw = c?.devName || c?.creatorHandle || c?.creatorAgentId || c?.extra?.creatorHandle || '';
  const s = String(raw || '').trim().replace(/^@+/, '');
  if (!s || /^0x[a-fA-F0-9]{40}$/i.test(s)) return '';
  return s.toUpperCase();
}
function devTagHtml(c) {
  const name = formatDevName(c);
  if (!name) return '';
  return `<span class="tag dev" title="DEV ${esc(name)}">${esc(name)}</span>`;
}

function padTagHtml(c) {
  const pad = (c.gangPad || (c.track === 'soft' ? 'soft' : (c.track === 'v2' ? 'v2' : '')) || '').toLowerCase();
  if (!pad) return '';
  const label = pad === 'u' ? 'U' : pad === 's' ? 'S' : pad;
  const cls = pad === 'soft' ? 'soft' : (pad === 'v2' ? 'v2' : 'pad');
  const path = c.tradePath === 'gang-cli' ? ' · gang CLI' : '';
  return `<span class="tag ${cls}" title="GANG pad ${esc(pad)}${esc(path)}">${esc(label)}</span>`;
}

function findHoldingForCa(ca) {
  const addr = String(ca || '').toLowerCase();
  if (!addr || addr === 'bnb') return null;
  const items = S.holdings?.items;
  if (!items || !items.length) return null;
  for (const it of items) {
    const a = String(it.address || '').toLowerCase();
    const t = String(it.tradeCa || '').toLowerCase();
    if ((a && a === addr) || (t && t === addr)) return it;
  }
  return null;
}

function fmtCardHoldAmt(it) {
  if (!it) return '';
  if (it.amountDisplay) return String(it.amountDisplay);
  const n = Number(it.amount);
  if (!Number.isFinite(n)) return '';
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`.replace(/\.00M$/, 'M');
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`.replace(/\.0K$/, 'K');
  return fmtAmtHold(n);
}

/** Holding chip left of DEV (margin-left:auto creates the gap). Hidden when zero / no match. */
function holdTagHtml(c) {
  const cas = [c?.address, c?.tradeCa].filter(Boolean);
  let it = null;
  for (const ca of cas) {
    it = findHoldingForCa(ca);
    if (it) break;
  }
  if (!it) return '';
  const amt = Number(it.amount);
  if (!(Number.isFinite(amt) && amt > 0)) return '';
  const qty = fmtCardHoldAmt(it) + (it.unit === 'shares' ? ' 份' : '');
  const valN = holdItemValueUsd(it);
  const val = valN != null ? ` · ${fmtHoldUsd(valN)}` : '';
  const title = `持仓 ${qty}${valN != null ? ` · 价值 ${fmtHoldUsd(valN)}` : ''} · ${(it.address || c.address || '')}`;
  return `<span class="tag hold" title="${esc(title)}">持仓 ${esc(qty)}${esc(val)}</span>`;
}

function syncCardHoldings() {
  $$('.card[data-ca]').forEach(el => {
    const tags = el.querySelector('.tags');
    if (!tags) return;
    const ca = el.dataset.ca || el.dataset.tradeCa || '';
    const tradeCa = el.dataset.tradeCa || ca;
    const html = holdTagHtml({ address: ca, tradeCa });
    const prev = tags.querySelector('.tag.hold');
    if (!html) {
      prev?.remove();
    } else {
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      const next = tmp.firstElementChild;
      if (prev) prev.replaceWith(next);
      else {
        const dev = tags.querySelector('.tag.dev');
        if (dev) tags.insertBefore(next, dev);
        else tags.append(next);
      }
    }
  });
  syncCardXferRows();
}

function cardEl(c) {
  const el = document.createElement('article');
  el.className = 'card' + (c.tradeable === false ? ' untradeable' : '');
  el.dataset.platform = c.platform;
  el.dataset.ca = c.address || '';
  el.dataset.tradeCa = c.tradeCa || c.address || '';
  const mc = c.mcUsd ?? c.fdvUsd;
  const pct = Math.max(0, Math.min(100, c.progressPct || 0));

  el.append(logoEl(c));

  const info = document.createElement('div');
  info.className = 'info';
  info.innerHTML = `
    <div class="row1"><span class="name" title="${esc(c.name)}">${esc(c.name)}</span><span class="sym">$${esc(c.symbol)}</span>${taxHtml(c)}${holdersHtml(c)}</div>
    <div class="tags">
      <span class="tag ${c.platform}">${c.platform.toUpperCase()}</span>
      <span class="tag agent">Agent 专属</span>
      <span class="tag">${esc(c.quote || 'BNB')}</span>
      ${padTagHtml(c)}
      ${c.tradeable === false ? `<span class="tag blocked" title="${esc(c.untradeableReason || '')}">不可买</span>` : ''}
      ${holdTagHtml(c)}
      ${devTagHtml(c)}
    </div>
    <div class="stats">
      <span>MC <b>${fmtUsd(mc)}</b></span>
      <span>${pct.toFixed(1)}%</span>
      <span>${fmtAge(c.ageMin)}</span>
      <span class="ca" data-ca="${esc(c.address || c.tradeCa || '')}" title="${esc(c.address || c.tradeCa || '')}（点击复制）">${esc(c.shortCa || shortCa(c.address || c.tradeCa || '') || '')}</span>
    </div>`;
  el.append(info);

  const caEl = info.querySelector('.stats .ca');
  if (caEl) {
    caEl.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      const ca = caEl.dataset.ca || c.address || c.tradeCa || '';
      if (!ca) return;
      copyCa(ca);
    });
  }

  const side = document.createElement('div');
  side.className = 'side';

  const actions = document.createElement('div');
  actions.className = 'actions';

  const buyBtn = document.createElement('button');
  buyBtn.type = 'button';
  buyBtn.className = 'btn-buy';
  const size = getBuySize();
  const sizeOk = size.mode === 'pct' ? size.pct > 0 : Number(size.amount) > 0;
  const canTrade = c.tradeable !== false;
  const buyOk = sizeOk && canTrade;
  buyBtn.textContent = !canTrade ? '不可买' : (sizeOk ? `买 ${size.label}` : '买');
  buyBtn.disabled = !buyOk;
  buyBtn.title = !canTrade
    ? (c.untradeableReason || 'aiwb 不支持')
    : (sizeOk
      ? `买入 ${size.label}（支付 ${getPayToken().label}；CA ${c.tradeCa || c.address}）`
      : '请先选支付币后面的数量（或可选 %）');
  buyBtn.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    doTrade('buy', el, c.tradeCa || c.address, buyBtn, c);
  });

  const sellBtn = document.createElement('button');
  sellBtn.type = 'button';
  sellBtn.className = 'btn-sell';
  sellBtn.textContent = canTrade ? `卖 ${getSellAmount()}` : '不可卖';
  sellBtn.disabled = !canTrade;
  sellBtn.title = !canTrade
    ? (c.untradeableReason || 'aiwb 不支持')
    : `卖出 ${getSellAmount()}（未毕业曲线可能需 App 确认或等毕业）`;
  sellBtn.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    doTrade('sell', el, c.tradeCa || c.address, sellBtn, c);
  });

  actions.append(buyBtn, sellBtn);
  side.append(actions);
  // 转主钱包 row under 买/卖 — only when holding > 0
  {
    const holdAmt = (() => {
      const it = findHoldingForCa(c.address) || findHoldingForCa(c.tradeCa);
      const n = it ? Number(it.amount) : 0;
      return Number.isFinite(n) && n > 0 ? n : 0;
    })();
    if (holdAmt > 0) {
      side.append(buildXferRow({ ca: c.tradeCa || c.address, coin: c }));
    }
  }
  el.append(side);

  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.innerHTML = `<i style="width:${pct}%"></i>`;
  el.append(bar);

  el.addEventListener('click', e => {
    if (e.target.closest('.btn-buy, .btn-sell, .btn-xfer, .xfer-row, .ca, .actions')) return;
    openDetail(c);
  });
  el.title = (el.title || '') || '点击查看 K线 / 买卖 / 持仓';
  return el;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}



function fmtHoldUsd(n) {
  if (n == null || !Number.isFinite(n)) return null;
  const a = Math.abs(n);
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  if (a >= 10) return `$${n.toFixed(1)}`;
  if (a >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(3)}`;
}

function fmtHoldCost(it) {
  if (it.platform === 'native' || it.platform === 'quote') return null;
  if (it.costKnown && it.costUsd != null) {
    return {
      cls: '',
      text: `成本 ${fmtHoldUsd(Number(it.costUsd))}`,
      title: [
        it.costSource ? `来源 ${it.costSource}` : null,
        it.costBnb != null ? `${Number(it.costBnb).toFixed(4)} BNB` : null,
      ].filter(Boolean).join(' · '),
    };
  }
  if (it.costKnown && it.costBnb != null) {
    return {
      cls: '',
      text: `成本 ${Number(it.costBnb).toFixed(4)} BNB`,
      title: it.costSource ? `来源 ${it.costSource}` : '',
    };
  }
  if (it.valueUsd != null) {
    return { cls: 'unk', text: '成本?', title: '有估值但无 journal/tx-history 成本' };
  }
  return null;
}

function fmtHoldPnl(it) {
  if (it.pnlUsd == null && it.pnlBnb == null) {
    if (it.platform === 'native' || it.platform === 'quote') return null;
    if (it.valueUsd != null && !it.costKnown) return null; // cost chip already shows 成本?
    if (it.valueUsd == null && it.costKnown) return { cls: 'unk', text: '价值?', title: '有成本但无可靠估值，盈亏未知' };
    return null;
  }
  const pct = it.pnlPct != null && Number.isFinite(it.pnlPct)
    ? ` (${it.pnlPct >= 0 ? '+' : ''}${it.pnlPct.toFixed(1)}%)`
    : '';
  let text;
  if (it.pnlUsd != null) {
    const sign = it.pnlUsd > 0 ? '+' : '';
    text = `${sign}${fmtHoldUsd(it.pnlUsd)}${pct}`;
  } else {
    const sign = it.pnlBnb > 0 ? '+' : '';
    text = `${sign}${Number(it.pnlBnb).toFixed(4)} BNB${pct}`;
  }
  const up = (it.pnlUsd != null ? it.pnlUsd : it.pnlBnb) >= 0;
  const title = [
    it.costUsd != null ? `成本 $${Number(it.costUsd).toFixed(2)}` : (it.costBnb != null ? `成本 ${Number(it.costBnb).toFixed(4)} BNB` : null),
    it.valueUsd != null ? `价值 $${Number(it.valueUsd).toFixed(2)}` : null,
    it.valueSource ? `估值来源 ${it.valueSource}` : null,
  ].filter(Boolean).join(' · ');
  return { cls: up ? 'up' : 'down', text, title };
}

/** Platform-category buckets for holdings strip (order matters). */
const HOLD_GROUPS = [
  { key: 'quote', label: '报价币', platClass: 'quote' },
  { key: 'gang', label: 'GANG', platClass: 'gang' },
  { key: 'flap', label: 'FLAP', platClass: 'flap' },
  { key: 'four', label: 'FOUR', platClass: 'four' },
  { key: 'other', label: '其他', platClass: 'other' },
];

function holdGroupKey(it) {
  const p = String(it?.platform || '').toLowerCase();
  if (p === 'native' || p === 'quote') return 'quote';
  if (p === 'gang') return 'gang';
  if (p === 'flap') return 'flap';
  if (p === 'four') return 'four';
  return 'other'; // pancake / unknown / null
}

function holdItemPnlUsd(it) {
  if (it?.pnlUsd != null && Number.isFinite(Number(it.pnlUsd))) return Number(it.pnlUsd);
  return null;
}

function holdItemPnlPct(it) {
  if (it?.pnlPct != null && Number.isFinite(Number(it.pnlPct))) return Number(it.pnlPct);
  return null;
}

function filterHoldItems(items) {
  let out = items.slice();
  const plat = S.holdPlat || 'all';
  if (plat !== 'all') out = out.filter(it => holdGroupKey(it) === plat);
  const vf = S.holdVal || 'all';
  if (vf === 'valued') out = out.filter(it => holdItemValueUsd(it) != null);
  else if (vf === 'unvalued') out = out.filter(it => holdItemValueUsd(it) == null);
  else if (vf !== 'all') {
    const min = Number(vf);
    if (Number.isFinite(min)) out = out.filter(it => {
      const v = holdItemValueUsd(it);
      return v != null && v >= min;
    });
  }
  const pf = S.holdPnl || 'all';
  if (pf === 'profit') out = out.filter(it => {
    const p = holdItemPnlUsd(it);
    return p != null ? p > 0 : (it.pnlBnb != null && Number(it.pnlBnb) > 0);
  });
  else if (pf === 'loss') out = out.filter(it => {
    const p = holdItemPnlUsd(it);
    return p != null ? p < 0 : (it.pnlBnb != null && Number(it.pnlBnb) < 0);
  });
  else if (pf === 'known') out = out.filter(it => it.pnlUsd != null || it.pnlBnb != null);
  else if (pf === 'unk') out = out.filter(it => it.pnlUsd == null && it.pnlBnb == null
    && it.platform !== 'native' && it.platform !== 'quote');
  return out;
}

function sortHoldItems(items, forceMode) {
  const mode = forceMode || S.holdSort || 'value-desc';
  if (mode === 'group') return sortHoldItems(items, 'value-desc');
  const arr = items.slice();
  const keyNum = (it, kind) => {
    if (kind === 'value') {
      const v = holdItemValueUsd(it);
      return v == null ? -Infinity : v;
    }
    if (kind === 'pnl') {
      const p = holdItemPnlUsd(it);
      if (p != null) return p;
      if (it.pnlBnb != null && Number.isFinite(Number(it.pnlBnb))) {
        return Number(it.pnlBnb) * (S.holdings?.meta?.bnbUsd || 0);
      }
      return -Infinity;
    }
    if (kind === 'pnlpct') {
      const p = holdItemPnlPct(it);
      return p == null ? -Infinity : p;
    }
    return 0;
  };
  const [kind, dir] = mode.split('-');
  const mul = dir === 'asc' ? 1 : -1;
  arr.sort((a, b) => {
    const av = keyNum(a, kind);
    const bv = keyNum(b, kind);
    if (av === bv) return String(a.symbol || '').localeCompare(String(b.symbol || ''));
    if (av === -Infinity && bv !== -Infinity) return 1;
    if (bv === -Infinity && av !== -Infinity) return -1;
    return (av - bv) * mul;
  });
  return arr;
}

function makeHoldRow(it) {
  const tr = document.createElement('tr');
  tr.className = 'hold-row' + (it.tradeable === false ? ' blocked' : '');
  const plat = it.platform || '?';
  const pad = (it.gangPad || '').toLowerCase();
  const padLbl = pad === 'u' ? 'U' : pad === 's' ? 'S' : pad;
  const valN = holdItemValueUsd(it);
  const valHtml = valN != null
    ? `<span class="h-usd" title="价值 · ${esc(it.valueSource || 'usd')}">${esc(fmtHoldUsd(valN))}</span>`
    : `<span class="h-usd unk" title="无可靠估值">价值?</span>`;
  const cost = fmtHoldCost(it);
  const costHtml = cost
    ? `<span class="h-cost ${cost.cls}" title="${esc(cost.title || '')}">${esc(cost.text)}</span>`
    : '—';
  const pnl = fmtHoldPnl(it);
  const pnlHtml = pnl
    ? `<span class="h-pnl ${pnl.cls}" title="${esc(pnl.title || '')}">${esc(pnl.text)}</span>`
    : '—';
  const nameHtml = it.name && it.symbol && String(it.name) !== String(it.symbol)
    ? `<span class="h-name" title="${esc(it.name)}">${esc(it.name)}</span> <span class="h-sym">${esc(it.symbol)}</span>`
    : `<span class="h-sym" title="${esc(it.name || '')}">${esc(it.symbol || '?')}</span>`;
  tr.innerHTML = `
    <td class="col-plat"><span class="h-plat ${esc(plat)}">${esc(String(plat).toUpperCase())}</span>${padLbl ? ` <span class="h-pad">${esc(padLbl)}</span>` : ''}</td>
    <td class="col-name">${nameHtml}</td>
    <td class="col-amt"><span class="h-amt">${esc(it.amountDisplay || fmtAmtHold(it.amount))}${it.unit === 'shares' ? ' 份' : ''}</span></td>
    <td class="col-val num">${valHtml}</td>
    <td class="col-cost num">${costHtml}</td>
    <td class="col-pnl num">${pnlHtml}</td>
    <td class="col-ca"><button type="button" class="h-ca" title="${esc(it.address || '')}">${esc(it.shortCa || '—')}</button></td>
    <td class="col-act"></td>
  `;
  const caBtn = tr.querySelector('.h-ca');
  caBtn?.addEventListener('click', e => {
    e.stopPropagation();
    const copy = it.tradeCa || it.address;
    if (copy && copy !== 'BNB') copyCa(copy);
  });
  const act = tr.querySelector('.col-act');
  if (it.address && it.address !== 'BNB' && plat !== 'native' && plat !== 'quote') {
    const sell = document.createElement('button');
    sell.type = 'button';
    sell.className = 'h-sell';
    const can = it.tradeable !== false;
    sell.textContent = can ? `卖 ${getSellAmount()}` : '不可卖';
    sell.disabled = !can;
    const sellCaHint = (it.platform === 'flap' && it.market && !it.graduated) ? it.market : (it.tradeCa || it.address);
    const pathHint = it.tradePath === 'gang-cli' ? ` · gang CLI (${it.gangPad || '?'})` : '';
    sell.title = can
      ? `卖出 ${getSellAmount()} · ${sellCaHint}${pathHint}`
      : (it.untradeableReason || '不可交易');
    sell.addEventListener('click', async e => {
      e.preventDefault();
      e.stopPropagation();
      if (!can) { toast(it.untradeableReason || '不可卖', 'err'); return; }
      const fakeCard = document.createElement('div');
      fakeCard.className = 'card';
      const sellCa = (it.platform === 'flap' && it.market && !it.graduated)
        ? it.market
        : (it.tradeCa || it.address);
      await doTrade('sell', fakeCard, sellCa, sell, {
        platform: it.platform, track: it.track, graduated: it.graduated,
        market: it.market, tradeCa: sellCa, address: it.address,
        tradeable: it.tradeable, untradeableReason: it.untradeableReason,
        symbol: it.symbol, gangPad: it.gangPad, tradePath: it.tradePath,
      });
      refreshHoldings(true);
    });
    act.append(sell);
    if (Number(it.amount) > 0) {
      const xfer = document.createElement('button');
      xfer.type = 'button';
      xfer.className = 'h-xfer';
      xfer.textContent = '转';
      xfer.title = `转全部到主钱包 ${S.mainWalletShort || shortCa(S.mainWallet)}`;
      xfer.addEventListener('click', async e => {
        e.preventDefault();
        e.stopPropagation();
        const xferCa = it.tradeCa || it.address;
        await doTransfer(xferCa, xfer, {
          platform: it.platform, track: it.track, graduated: it.graduated,
          tradeCa: xferCa, address: it.address, symbol: it.symbol,
        }, { max: true, percent: 100 });
      });
      act.append(xfer);
    }
  }
  tr.addEventListener('click', e => {
    if (e.target.closest('.h-sell, .h-xfer, .h-ca, .col-act')) return;
    if (!it.address || it.address === 'BNB' || it.platform === 'native' || it.platform === 'quote') return;
    openDetailFromHolding(it);
  });
  return tr;
}


function resolveHoldLogo(it) {
  if (it?.logoUrl) return it.logoUrl;
  const ca = String(it?.tradeCa || it?.address || '').toLowerCase();
  if (!ca || ca === 'bnb') return null;
  const cols = [S?.board?.new, S?.board?.near, S?.board?.graduated].filter(Boolean);
  for (const col of cols) {
    for (const c of col) {
      const a = String(c.address || '').toLowerCase();
      const t = String(c.tradeCa || '').toLowerCase();
      const m = String(c.market || '').toLowerCase();
      if (a === ca || t === ca || m === ca) return c.logoUrl || c.logo || null;
    }
  }
  return null;
}
function holdCardEl(it) {
  const el = document.createElement('article');
  el.className = 'card hold-card' + (it.tradeable === false ? ' untradeable' : '');
  el.dataset.platform = it.platform || '';
  el.dataset.ca = it.address || '';
  el.dataset.tradeCa = it.tradeCa || it.address || '';

  const plat = it.platform || '?';
  const pad = (it.gangPad || '').toLowerCase();
  const padLbl = pad === 'u' ? 'U' : pad === 's' ? 'S' : pad;
  const valN = holdItemValueUsd(it);
  const cost = fmtHoldCost(it);
  const pnl = fmtHoldPnl(it);
  const qty = esc(it.amountDisplay || fmtAmtHold(it.amount)) + (it.unit === 'shares' ? ' 份' : '');
  const name = it.name || it.symbol || '?';
  const sym = it.symbol || '?';

  // Compact row: logo | metrics+name | actions (fills full card width)
  const logoIt = { ...it, logoUrl: resolveHoldLogo(it) };
  el.append(logoEl(logoIt));

  const info = document.createElement('div');
  info.className = 'info';
  info.innerHTML = `
    <div class="row1">
      <span class="name" title="${esc(name)}">${esc(name)}</span>
      <span class="sym">$${esc(sym)}</span>
      <span class="tag ${esc(plat)}">${esc(String(plat).toUpperCase())}</span>
      ${padLbl ? `<span class="tag pad">${esc(padLbl)}</span>` : ''}
      ${it.tradeable === false ? `<span class="tag blocked" title="${esc(it.untradeableReason || '')}">不可卖</span>` : ''}
    </div>
    <div class="stats hold-stats">
      <span class="hold-metric">数量 <b>${qty}</b></span>
      <span class="hold-sep">·</span>
      <span class="hold-metric">价值 <b class="${valN == null ? 'unk' : ''}">${valN != null ? esc(fmtHoldUsd(valN)) : '?'}</b></span>
      ${cost ? `<span class="hold-sep">·</span><span class="hold-metric hold-cost-stat ${esc(cost.cls)}" title="${esc(cost.title || '')}">${esc(cost.text)}</span>` : ''}
      <span class="hold-pnl-stat ${pnl ? esc(pnl.cls) : 'unk'}" title="${pnl ? esc(pnl.title || '') : ''}">${pnl ? esc(pnl.text) : '盈亏?'}</span>
      <span class="ca" data-ca="${esc(it.tradeCa || it.address || '')}" title="${esc(it.address || '')}（点击复制）">${esc(it.shortCa || shortCa(it.address || '') || '—')}</span>
    </div>`;
  el.append(info);

  const caEl = info.querySelector('.stats .ca');
  if (caEl) {
    caEl.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      const ca = caEl.dataset.ca || it.tradeCa || it.address || '';
      if (ca && ca !== 'BNB') copyCa(ca);
    });
  }

  const side = document.createElement('div');
  side.className = 'side';
  const actions = document.createElement('div');
  actions.className = 'actions';

  if (it.address && it.address !== 'BNB' && plat !== 'native' && plat !== 'quote') {
    const sell = document.createElement('button');
    sell.type = 'button';
    sell.className = 'btn-sell h-sell';
    const can = it.tradeable !== false;
    sell.textContent = can ? `卖 ${getSellAmount()}` : '不可卖';
    sell.disabled = !can;
    const sellCaHint = (it.platform === 'flap' && it.market && !it.graduated) ? it.market : (it.tradeCa || it.address);
    sell.title = can ? `卖出 ${getSellAmount()} · ${sellCaHint}` : (it.untradeableReason || '不可交易');
    sell.addEventListener('click', async e => {
      e.preventDefault();
      e.stopPropagation();
      if (!can) { toast(it.untradeableReason || '不可卖', 'err'); return; }
      const sellCa = (it.platform === 'flap' && it.market && !it.graduated)
        ? it.market
        : (it.tradeCa || it.address);
      await doTrade('sell', el, sellCa, sell, {
        platform: it.platform, track: it.track, graduated: it.graduated,
        market: it.market, tradeCa: sellCa, address: it.address,
        tradeable: it.tradeable, untradeableReason: it.untradeableReason,
        symbol: it.symbol, gangPad: it.gangPad, tradePath: it.tradePath,
      });
      refreshHoldings(true);
    });
    actions.append(sell);

    if (Number(it.amount) > 0) {
      const xfer = document.createElement('button');
      xfer.type = 'button';
      xfer.className = 'btn-xfer h-xfer';
      xfer.textContent = '转';
      xfer.title = `转全部到主钱包 ${S.mainWalletShort || shortCa(S.mainWallet)}`;
      xfer.addEventListener('click', async e => {
        e.preventDefault();
        e.stopPropagation();
        const xferCa = it.tradeCa || it.address;
        await doTransfer(xferCa, xfer, {
          platform: it.platform, track: it.track, graduated: it.graduated,
          tradeCa: xferCa, address: it.address, symbol: it.symbol,
        }, { max: true, percent: 100 });
      });
      actions.append(xfer);
    }
  }
  side.append(actions);
  el.append(side);

  el.addEventListener('click', e => {
    if (e.target.closest('.btn-sell, .btn-xfer, .h-sell, .h-xfer, .ca, .actions, .xfer-row')) return;
    if (!it.address || it.address === 'BNB' || it.platform === 'native' || it.platform === 'quote') return;
    openDetailFromHolding(it);
  });
  return el;
}

function holdItemValueUsd(it) {
  const n = it?.valueUsd != null ? it.valueUsd : it?.usd;
  return n != null && Number.isFinite(Number(n)) ? Number(n) : null;
}

function makeHoldChip(it) {
  const chip = document.createElement('div');
  chip.className = 'hold-chip' + (it.tradeable === false ? ' blocked' : '');
  const plat = it.platform || '?';
  const pad = (it.gangPad || '').toLowerCase();
  const padLbl = pad === 'u' ? 'U' : pad === 's' ? 'S' : pad;
  const valN = holdItemValueUsd(it);
  const valHtml = valN != null
    ? `<span class="h-usd" title="价值 · ${esc(it.valueSource || 'usd')}">${esc(fmtHoldUsd(valN))}</span>`
    : `<span class="h-usd unk" title="无可靠估值">价值?</span>`;
  const cost = fmtHoldCost(it);
  const costHtml = cost
    ? `<span class="h-cost ${cost.cls}" title="${esc(cost.title || '')}">${esc(cost.text)}</span>`
    : '';
  const pnl = fmtHoldPnl(it);
  const pnlHtml = pnl
    ? `<span class="h-pnl ${pnl.cls}" title="${esc(pnl.title || '')}">${esc(pnl.text)}</span>`
    : '';
  chip.innerHTML = `
    <span class="h-plat ${esc(plat)}">${esc(String(plat).toUpperCase())}</span>
    ${padLbl ? `<span class="h-pad" title="pad ${esc(pad)} · ${esc(it.tradePath || '')}">${esc(padLbl)}</span>` : ''}
    ${it.name && it.symbol && String(it.name) !== String(it.symbol)
      ? `<span class="h-name" title="${esc(it.name)}">${esc(it.name)}</span><span class="h-sym">$${esc(it.symbol)}</span>`
      : `<span class="h-sym" title="${esc(it.name || '')}">$${esc(it.symbol)}</span>`}
    <span class="h-amt">${esc(it.amountDisplay || fmtAmtHold(it.amount))}${it.unit === 'shares' ? ' 份' : ''}</span>
    ${valHtml}
    ${costHtml}
    ${pnlHtml}
    <span class="h-ca" title="${esc(it.address)}">${esc(it.shortCa || '')}</span>
  `;
  const caEl = chip.querySelector('.h-ca');
  caEl?.addEventListener('click', () => {
    const copy = it.tradeCa || it.address;
    if (copy && copy !== 'BNB') copyCa(copy);
  });
  if (it.address && it.address !== 'BNB' && plat !== 'native' && plat !== 'quote') {
    const sell = document.createElement('button');
    sell.type = 'button';
    sell.className = 'h-sell';
    const can = it.tradeable !== false;
    sell.textContent = can ? `卖 ${getSellAmount()}` : '不可卖';
    sell.disabled = !can;
    const sellCaHint = (it.platform === 'flap' && it.market && !it.graduated) ? it.market : (it.tradeCa || it.address);
    const pathHint = it.tradePath === 'gang-cli' ? ` · gang CLI (${it.gangPad || '?'})` : '';
    sell.title = can
      ? `卖出 ${getSellAmount()} · ${sellCaHint}${pathHint}`
      : (it.untradeableReason || '不可交易');
    sell.addEventListener('click', async e => {
      e.preventDefault();
      e.stopPropagation();
      if (!can) {
        toast(it.untradeableReason || '不可卖', 'err');
        return;
      }
      // Reuse card trade path with a synthetic card element for status
      const fakeCard = document.createElement('div');
      fakeCard.className = 'card';
      // Flap curve: must sell via market CA (shares), never predicted token.
      const sellCa = (it.platform === 'flap' && it.market && !it.graduated)
        ? it.market
        : (it.tradeCa || it.address);
      await doTrade('sell', fakeCard, sellCa, sell, {
        platform: it.platform,
        track: it.track,
        graduated: it.graduated,
        market: it.market,
        tradeCa: sellCa,
        address: it.address,
        tradeable: it.tradeable,
        untradeableReason: it.untradeableReason,
        symbol: it.symbol,
        gangPad: it.gangPad,
        tradePath: it.tradePath,
      });
      refreshHoldings(true);
    });
    chip.append(sell);
    // Nice-to-have: 转 100% to main wallet
    if (Number(it.amount) > 0) {
      const xfer = document.createElement('button');
      xfer.type = 'button';
      xfer.className = 'h-xfer';
      xfer.textContent = '转';
      xfer.title = `转全部到主钱包 ${S.mainWalletShort || shortCa(S.mainWallet)}`;
      xfer.addEventListener('click', async e => {
        e.preventDefault();
        e.stopPropagation();
        const xferCa = it.tradeCa || it.address;
        await doTransfer(xferCa, xfer, {
          platform: it.platform,
          track: it.track,
          graduated: it.graduated,
          tradeCa: xferCa,
          address: it.address,
          symbol: it.symbol,
        }, { max: true, percent: 100 });
      });
      chip.append(xfer);
    }
  }
  chip.addEventListener('click', e => {
    if (e.target.closest('.h-sell, .h-xfer, .h-ca')) return;
    if (!it.address || it.address === 'BNB' || it.platform === 'native' || it.platform === 'quote') return;
    openDetailFromHolding(it);
  });
  return chip;
}

function renderHoldings() {
  const list = $('#list-hold');
  const box = $('#holdings-list');
  const tbody = $('#holdings-tbody');
  const meta = $('#holdings-meta');
  const cnt = $('#cnt-hold');
  const h = S.holdings;
  if (!h) {
    if (meta) meta.textContent = '加载中…';
    if (cnt) cnt.textContent = '…';
    return;
  }
  if (!h.ok && !(h.items && h.items.length)) {
    if (meta) meta.textContent = h.error || '持仓读取失败';
    if (cnt) cnt.textContent = '0';
    if (list) list.innerHTML = '';
    if (tbody) tbody.innerHTML = '';
    if (box) { box.innerHTML = ''; box.hidden = true; }
    return;
  }
  const t = h.updatedAt ? new Date(h.updatedAt) : null;
  const filtered = filterHoldItems(h.items || []);
  let sumFilt = 0, nVal = 0;
  for (const it of filtered) {
    const v = holdItemValueUsd(it);
    if (v != null) { sumFilt += v; nVal += 1; }
  }
  const totAll = h.totalValueUsd != null && Number.isFinite(h.totalValueUsd)
    ? fmtHoldUsd(h.totalValueUsd) : null;
  if (meta) {
    meta.textContent = (filtered.length !== (h.items || []).length
      ? `筛选 ${filtered.length}/${(h.items || []).length} 项`
      : `${(h.items || []).length} 项`)
      + (nVal ? ` · 合计 ${fmtHoldUsd(sumFilt)}` : '')
      + (totAll ? ` · 全仓 ${totAll}` : '')
      + (h.meta?.unvaluedCount ? `（${h.meta.unvaluedCount} 无估值）` : '')
      + (t ? ` · ${t.toLocaleTimeString('zh-CN', { hour12: false })}` : '')
      + (h.meta?.bawError ? ` · baw: ${h.meta.bawError}` : '');
  }
  if (cnt) cnt.textContent = String(filtered.length);

  const paintList = (target) => {
    if (!target) return;
    target.innerHTML = '';
    if (!(h.items || []).length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = '当前无曲线/相关持仓';
      target.append(e);
      return;
    }
    if (!filtered.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = '没有符合筛选的持仓';
      target.append(e);
      return;
    }
    if ((S.holdSort || 'value-desc') === 'group') {
      const buckets = Object.fromEntries(HOLD_GROUPS.map(g => [g.key, []]));
      for (const it of filtered) buckets[holdGroupKey(it)].push(it);
      for (const g of HOLD_GROUPS) {
        const items = sortHoldItems(buckets[g.key], 'value-desc');
        if (!items.length) continue;
        const head = document.createElement('div');
        head.className = 'hold-col-group';
        head.innerHTML = `<span class="hold-group-label ${esc(g.platClass)}">${esc(g.label)}</span><span class="hold-group-count">${items.length}</span>`;
        target.append(head);
        for (const it of items) target.append(holdCardEl(it));
      }
    } else {
      for (const it of sortHoldItems(filtered)) target.append(holdCardEl(it));
    }
  };
  paintList(list);

  // Top strip table optional; keep empty/hidden — column is primary
  if (tbody) tbody.innerHTML = '';
  if (box) { box.innerHTML = ''; box.hidden = true; }
}

function fmtAmtHold(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  if (n >= 1e-4) return n.toFixed(6);
  return String(n);
}

async function refreshHoldings(force = false) {
  try {
    const q = force ? '/api/holdings?fresh=1' : '/api/holdings';
    S.holdings = await api(q);
    if (S.holdings?.meta?.mainWallet) {
      S.mainWallet = S.holdings.meta.mainWallet;
      S.mainWalletShort = S.holdings.meta.mainWalletShort || shortCa(S.mainWallet);
      updateXferDestHint();
    }
    renderHoldings();
    syncCardHoldings();
  } catch (e) {
    const meta = $('#holdings-meta');
    if (meta) meta.textContent = e.message || '持仓失败';
  }
}


function renderWallet(w) {
  const idEl = $('#wallet-id');
  const addrEl = $('#wallet-addr');
  const box = $('#wallet');
  if (!idEl || !addrEl) return;
  if (!w || !w.address) {
    idEl.textContent = '—';
    addrEl.textContent = w?.status === 'CONNECTED' ? '无地址' : '未连接';
    addrEl.removeAttribute('title');
    box?.classList.remove('on');
    return;
  }
  idEl.textContent = w.agentId || w.handle || 'Agent';
  addrEl.textContent = w.short || w.address;
  addrEl.title = w.address;
  addrEl.onclick = () => {
    if (w.address) copyCa(w.address);
  };
  box?.classList.toggle('on', w.status === 'CONNECTED');
}


function cardQuoteKey(c) {
  const q = String(c?.quote || 'BNB').trim();
  if (!q || q === '?') return 'BNB';
  // Truncated quote addresses from flap → treat as OTHER
  if (/^0x/i.test(q) || /…/.test(q)) return 'OTHER';
  return q.toUpperCase();
}

function collectQuotes(board) {
  const set = new Set();
  for (const col of ['new', 'near', 'graduated']) {
    for (const c of board?.[col] || []) set.add(cardQuoteKey(c));
  }
  // Stable preferred order, then alpha
  const prefer = ['BNB', 'WBNB', 'BNCB', 'NVDAB', 'GANG', 'U'];
  const rest = [...set].filter(x => !prefer.includes(x)).sort();
  return [...prefer.filter(x => set.has(x)), ...rest];
}

function syncQuoteChips(board) {
  const box = $('#quote-chips');
  if (!box) return;
  const quotes = collectQuotes(board);
  const cur = S.quoteFilter;
  const still = cur === 'all' || quotes.includes(cur);
  if (!still) S.quoteFilter = 'all';
  box.innerHTML = '';
  const mk = (key, label) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'quote-chip' + (S.quoteFilter === key ? ' on' : '');
    b.dataset.quote = key;
    b.textContent = label;
    b.addEventListener('click', () => {
      S.quoteFilter = key;
      $$('#quote-chips .quote-chip').forEach(x => x.classList.toggle('on', x.dataset.quote === key));
      render();
    });
    return b;
  };
  box.append(mk('all', '全部'));
  for (const q of quotes) box.append(mk(q, q));
}

function cardMc(c) {
  const v = Number(c?.mcUsd ?? c?.fdvUsd);
  return Number.isFinite(v) && v > 0 ? v : null;
}
function cardHolders(c) {
  const v = Number(c?.holderCount);
  return Number.isFinite(v) && v >= 0 ? v : null;
}
function cardVolume(c) {
  const v = Number(c?.volume24hUsd ?? c?.extra?.volume24hUsd);
  return Number.isFinite(v) && v >= 0 ? v : null;
}
function cardCreatedTs(c) {
  const ts = Number(c?.createdAt);
  if (Number.isFinite(ts) && ts > 0) return ts > 1e12 ? Math.floor(ts / 1000) : ts;
  const age = Number(c?.ageMin);
  if (Number.isFinite(age) && age >= 0) return Date.now() / 1000 - age * 60;
  return null;
}
/** Column sort — mc/holders/volume high→low; created newest→oldest; missing last. */
function sortColumn(items, mode) {
  const m = mode || 'mc';
  if (m === 'created') {
    return [...items].sort((a, b) => {
      const av = cardCreatedTs(a), bv = cardCreatedTs(b);
      if (av != null && bv != null && av !== bv) return bv - av; // newer first
      if (av != null && bv == null) return -1;
      if (av == null && bv != null) return 1;
      const ma = cardMc(a), mb = cardMc(b);
      if (ma != null && mb != null && ma !== mb) return mb - ma;
      return 0;
    });
  }
  const keyFn = m === 'holders' ? cardHolders : m === 'volume' ? cardVolume : cardMc;
  return [...items].sort((a, b) => {
    const av = keyFn(a), bv = keyFn(b);
    if (av != null && bv != null && av !== bv) return bv - av;
    if (av != null && bv == null) return -1;
    if (av == null && bv != null) return 1;
    const ma = cardMc(a), mb = cardMc(b);
    if (ma != null && mb != null && ma !== mb) return mb - ma;
    const ca = cardCreatedTs(a), cb = cardCreatedTs(b);
    if (ca != null && cb != null && ca !== cb) return cb - ca;
    return 0;
  });
}
function sortGraduated(items, mode) { return sortColumn(items, mode); }

function passListFilters(c) {
  if (S.filter !== 'all' && c.platform !== S.filter) return false;
  if (S.quoteFilter !== 'all' && cardQuoteKey(c) !== S.quoteFilter) return false;
  const q = String(S.search || '').trim().toLowerCase();
  if (q) {
    const ca = String(c.address || c.tradeCa || c.market || '').toLowerCase();
    const hay = `${c.symbol || ''} ${c.name || ''} ${ca}`.toLowerCase();
    // ticker / name / full 0x CA / partial CA fragment (e.g. last 4–6)
    if (!hay.includes(q)) return false;
  }
  return true;
}

function render() {
  const b = S.board;
  if (!b) return;
  syncQuoteChips(b);
  for (const col of ['new', 'near', 'graduated']) {
    const list = $(`#list-${col}`);
    let items = (b[col] || []).filter(passListFilters);
    const sortMode = col === 'graduated' ? (S.gradSort || 'mc')
      : col === 'new' ? (S.newSort || 'created')
      : col === 'near' ? (S.nearSort || 'mc')
      : 'mc';
    items = sortColumn(items, sortMode);
    list.innerHTML = '';
    if (!items.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      const bits = [];
      if (S.filter !== 'all') bits.push(S.filter.toUpperCase());
      if (S.quoteFilter !== 'all') bits.push(`底池 ${S.quoteFilter}`);
      if (S.search.trim()) bits.push(`「${S.search.trim()}」`);
      e.textContent = bits.length ? `当前筛选无匹配（${bits.join(' · ')}）` : '暂无数据';
      list.append(e);
    } else {
      items.forEach(c => list.append(cardEl(c)));
    }
    $(`#cnt-${col}`).textContent = String(items.length);
  }
  const nearSub = $('#near-sub');
  if (nearSub) {
    const mc = b.nearMinMcUsd != null ? Number(b.nearMinMcUsd) : 10000;
    nearSub.textContent = Number.isFinite(mc) ? `市值≥${mc >= 1000 ? `${Math.round(mc / 1000)}K` : mc}` : '市值≥10K';
    nearSub.title = b.meta?.nearGate || nearSub.textContent;
  }
  const m = b.meta || {};
  $('#rpc').textContent = m.rpcLatencyMs != null ? `RPC ${m.rpcLatencyMs}ms` : 'RPC —';
  $('#bnb').textContent = m.bnbUsd != null ? `BNB $${Number(m.bnbUsd).toFixed(1)}` : 'BNB —';
  const t = b.updatedAt ? new Date(b.updatedAt) : null;
  $('#updated').textContent = t ? `更新 ${t.toLocaleTimeString('zh-CN', { hour12: false })}` : '更新 —';
  const errs = m.errors && Object.keys(m.errors).length
    ? Object.entries(m.errors).map(([k, v]) => `${k}: ${v}`).join(' · ')
    : '';
  const softNote = m.softCurveHidden
    ? `已隐藏 ${m.softCurveHidden} 个 GANG soft（设 GANG_INCLUDE_SOFT=1 显示；买卖走 gang CLI）`
    : '';
  $('#err').textContent = [errs, softNote].filter(Boolean).join(' · ');
  renderWallet(m.wallet);
  syncBuyButtons();
}

async function refreshWalletOnly() {
  try {
    const h = await api('/api/health');
    if (h?.wallet) renderWallet(h.wallet);
    if (h?.mainWallet) {
      S.mainWallet = h.mainWallet;
      S.mainWalletShort = h.mainWalletShort || shortCa(h.mainWallet);
      updateXferDestHint();
    }
  } catch { /* ignore */ }
}

async function refresh() {
  try {
    S.board = await api('/api/board');
    render();
    // Prefer live health wallet if board still carries a stale empty address
    if (!S.board?.meta?.wallet?.address) await refreshWalletOnly();
  } catch (e) {
    $('#err').textContent = e.message;
    await refreshWalletOnly();
  }
}


(() => {
  const allowed = new Set(['mc', 'holders', 'volume', 'created']);
  const wire = (id, stateKey, storageKey, fallback) => {
    const sel = $(id);
    if (!sel) return;
    if (!allowed.has(S[stateKey])) S[stateKey] = fallback;
    sel.value = S[stateKey];
    sel.addEventListener('change', () => {
      const v = sel.value;
      S[stateKey] = allowed.has(v) ? v : fallback;
      try { localStorage.setItem(storageKey, S[stateKey]); } catch (_) {}
      render();
    });
  };
  wire('#grad-sort', 'gradSort', 'curve-board-grad-sort', 'mc');
  wire('#new-sort', 'newSort', 'curve-board-new-sort', 'created');
  wire('#near-sort', 'nearSort', 'curve-board-near-sort', 'mc');
})();

$$('#filters .chip').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('#filters .chip').forEach(b => b.classList.remove('on'));
    btn.classList.add('on');
    S.filter = btn.dataset.p;
    render();
  });
});

(() => {
  const inp = $('#ticker-search');
  if (!inp) return;
  let t = null;
  const apply = () => {
    S.search = inp.value || '';
    render();
  };
  inp.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(apply, 120);
  });
  inp.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      inp.value = '';
      apply();
    }
  });
})();

function syncSellHint() {
  const hint = $('#sell-picked');
  if (hint) hint.textContent = getSellAmount();
  $$('.btn-sell').forEach(b => {
    if (b.dataset.busy === '1') return;
    b.title = `卖出 ${getSellAmount()}（未毕业曲线可能需 App 确认或等毕业）`;
    b.textContent = `卖 ${getSellAmount()}`;
  });
  $$('.h-sell').forEach(b => {
    if (b.disabled || b.dataset.busy === '1') return;
    b.textContent = `卖 ${getSellAmount()}`;
  });
}

// Trade bar: pay token + abs amount (same row); % optional; sell %
(() => {
  // Restore pay token
  const savedPay = sessionStorage.getItem('curve-pay-token');
  const savedCa = sessionStorage.getItem('curve-pay-ca') || '';
  const payCaEl = $('#pay-ca');
  if (payCaEl && savedCa) payCaEl.value = savedCa;
  if (savedPay && Object.prototype.hasOwnProperty.call(PAY_TOKEN_MAP, savedPay)) {
    S.payKey = savedPay;
  } else if (savedPay === 'custom' || savedCa) {
    S.payKey = 'custom';
  } else {
    S.payKey = 'BNB';
  }

  
  const wireHoldSel = (id, key, storage, fallback) => {
    const el = $(id);
    if (!el) return;
    el.value = S[key] || fallback;
    el.addEventListener('change', () => {
      S[key] = el.value || fallback;
      try { localStorage.setItem(storage, S[key]); } catch (_) {}
      renderHoldings();
    });
  };
  wireHoldSel('#hold-plat', 'holdPlat', 'curve-hold-plat', 'all');
  wireHoldSel('#hold-val', 'holdVal', 'curve-hold-val', 'all');
  wireHoldSel('#hold-pnl', 'holdPnl', 'curve-hold-pnl', 'all');
  wireHoldSel('#hold-sort', 'holdSort', 'curve-hold-sort', 'value-desc');

  $$('#pay-chips .pay-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      S.payKey = btn.dataset.pay;
      if (payCaEl) payCaEl.value = '';
      sessionStorage.setItem('curve-pay-token', S.payKey);
      sessionStorage.setItem('curve-pay-ca', '');
      syncPayUI();
      syncBuyUI();
    });
  });

  payCaEl?.addEventListener('input', () => {
    const v = payCaEl.value.trim();
    if (v) S.payKey = 'custom';
    else if (!Object.prototype.hasOwnProperty.call(PAY_TOKEN_MAP, S.payKey)) S.payKey = 'BNB';
    syncPayUI();
    syncBuyUI();
  });

  // Restore buy size (abs preferred; % optional)
  const buyAmtEl = $('#buy-amt');
  const buyPctEl = $('#buy-pct');
  const presetAmts = ['0.01', '0.05', '0.1', '0.5'];
  const presetPcts = ['1', '0.5', '0.2'];
  const savedMode = sessionStorage.getItem('curve-buy-mode');
  const savedAmt = sessionStorage.getItem('curve-buy-amt');
  const savedPct = sessionStorage.getItem('curve-buy-pct');
  if (savedMode === 'pct' && savedPct) {
    const n = Number(savedPct);
    if (Number.isFinite(n) && n > 0) {
      S.buyMode = 'pct';
      S.buyPct = n;
      S.buyAmt = 0;
      if (!presetPcts.includes(String(n)) && buyPctEl) buyPctEl.value = String(n);
    }
  } else if (savedAmt) {
    const n = Number(savedAmt);
    if (Number.isFinite(n) && n > 0) {
      S.buyMode = 'abs';
      S.buyAmt = n;
      S.buyPct = 0;
      if (!presetAmts.includes(String(n)) && buyAmtEl) buyAmtEl.value = String(n);
    }
  } else {
    S.buyMode = 'abs';
    S.buyAmt = 0.05;
    S.buyPct = 0;
  }

  $$('#amt-chips .amt-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = Number(btn.dataset.amt);
      S.buyMode = 'abs';
      S.buyAmt = v;
      S.buyPct = 0;
      if (buyAmtEl) buyAmtEl.value = '';
      if (buyPctEl) buyPctEl.value = '';
      syncBuyUI();
    });
  });

  buyAmtEl?.addEventListener('input', () => {
    const n = Number(buyAmtEl.value);
    if (Number.isFinite(n) && n > 0) {
      S.buyMode = 'abs';
      S.buyAmt = n;
      S.buyPct = 0;
      if (buyPctEl) buyPctEl.value = '';
    }
    syncBuyUI();
  });

  $$('#size-chips .size-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = Number(btn.dataset.pct);
      S.buyMode = 'pct';
      S.buyPct = v;
      S.buyAmt = 0;
      if (buyPctEl) buyPctEl.value = '';
      if (buyAmtEl) buyAmtEl.value = '';
      syncBuyUI();
    });
  });

  buyPctEl?.addEventListener('input', () => {
    const n = Number(buyPctEl.value);
    if (Number.isFinite(n) && n > 0) {
      S.buyMode = 'pct';
      S.buyPct = n;
      S.buyAmt = 0;
      if (buyAmtEl) buyAmtEl.value = '';
    }
    syncBuyUI();
  });

  // Sell
  const savedSell = sessionStorage.getItem('curve-sell-pct');
  if (savedSell && ['10', '25', '50', '75', '100'].includes(savedSell)) S.sellPct = savedSell;
  $$('#sell-chips .sell-chip').forEach(btn => {
    btn.classList.toggle('on', btn.dataset.pct === S.sellPct);
    btn.addEventListener('click', () => {
      S.sellPct = btn.dataset.pct;
      sessionStorage.setItem('curve-sell-pct', S.sellPct);
      $$('#sell-chips .sell-chip').forEach(b => b.classList.toggle('on', b.dataset.pct === S.sellPct));
      syncSellHint();
    });
  });

  syncPayUI();
  syncBuyUI();
  syncSellHint();
})();


/* —— Token detail drawer (K-line + trade + holding) —— */
function coinFromHolding(it) {
  const boardCoin = findCoin(it.address) || findCoin(it.tradeCa);
  if (boardCoin) {
    return {
      ...boardCoin,
      tradeCa: (it.platform === 'flap' && it.market && !it.graduated) ? it.market : (boardCoin.tradeCa || it.tradeCa || it.address),
      market: it.market || boardCoin.market,
      gangPad: it.gangPad || boardCoin.gangPad,
      tradePath: it.tradePath || boardCoin.tradePath,
      tradeable: it.tradeable != null ? it.tradeable : boardCoin.tradeable,
      untradeableReason: it.untradeableReason || boardCoin.untradeableReason,
    };
  }
  return {
    platform: it.platform || '?',
    address: it.address,
    tradeCa: (it.platform === 'flap' && it.market && !it.graduated) ? it.market : (it.tradeCa || it.address),
    name: it.name || it.symbol || '?',
    symbol: it.symbol || '?',
    quote: it.quote || 'BNB',
    logoUrl: it.logoUrl || null,
    graduated: !!it.graduated,
    market: it.market,
    gangPad: it.gangPad,
    tradePath: it.tradePath,
    tradeable: it.tradeable !== false,
    untradeableReason: it.untradeableReason,
    track: it.track,
    mcUsd: null,
    fdvUsd: null,
    progressPct: it.graduated ? 100 : 0,
  };
}

function openDetailFromHolding(it) {
  openDetail(coinFromHolding(it));
}

function closeDetail() {
  S.detail = null;
  S.detailCandles = null;
  const drawer = $('#detail-drawer');
  const backdrop = $('#detail-backdrop');
  if (drawer) { drawer.hidden = true; drawer.setAttribute('aria-hidden', 'true'); }
  if (backdrop) backdrop.hidden = true;
  const hb = $('#detail-holders-body');
  const hm = $('#holders-meta');
  if (hb) { hb.className = 'detail-holders-body loading'; hb.textContent = '加载中…'; }
  if (hm) hm.textContent = '';
}

function openDetail(coin) {
  if (!coin?.address && !coin?.tradeCa) return;
  S.detail = coin;
  const drawer = $('#detail-drawer');
  const backdrop = $('#detail-backdrop');
  if (!drawer || !backdrop) return;
  drawer.hidden = false;
  drawer.setAttribute('aria-hidden', 'false');
  backdrop.hidden = false;
  renderDetailHeader(coin);
  renderDetailHolding(coin);
  syncDetailTradeButtons();
  syncDetailXfer();
  loadDetailKline();
  loadDetailHolders();
}

function renderDetailHeader(c) {
  const logo = $('#detail-logo');
  if (logo) {
    logo.innerHTML = '';
    logo.append(logoEl(c));
  }
  const name = $('#detail-name');
  const sym = $('#detail-sym');
  if (name) name.textContent = c.name || '—';
  if (sym) sym.textContent = c.symbol ? `$${c.symbol}` : '';
  const tags = $('#detail-tags');
  if (tags) {
    tags.innerHTML = `
      <span class="tag ${esc(c.platform || '')}">${esc(String(c.platform || '?').toUpperCase())}</span>
      <span class="tag">${esc(c.quote || 'BNB')}</span>
      ${c.graduated ? '<span class="tag">已开盘</span>' : '<span class="tag">曲线</span>'}
      ${padTagHtml(c)}
      ${c.tradeable === false ? `<span class="tag blocked">${esc(c.untradeableReason || '不可买')}</span>` : ''}
      ${devTagHtml(c)}
    `;
  }
  const caBtn = $('#detail-ca');
  if (caBtn) {
    const ca = c.address || c.tradeCa || '';
    caBtn.textContent = ca || '—';
    caBtn.title = ca ? `${ca}（点击复制）` : '无 CA';
    caBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      copyCa(ca);
    };
  }
}

function renderDetailHolding(c) {
  const box = $('#detail-hold-body');
  if (!box) return;
  const it = findHoldingForCa(c.address) || findHoldingForCa(c.tradeCa);
  if (!it || !(Number(it.amount) > 0)) {
    box.className = 'detail-hold-body empty';
    box.textContent = '当前钱包未持有此币';
    return;
  }
  box.className = 'detail-hold-body';
  const qty = fmtCardHoldAmt(it) + (it.unit === 'shares' ? ' 份' : '');
  const valN = holdItemValueUsd(it);
  const cost = fmtHoldCost(it);
  const pnl = fmtHoldPnl(it);
  const items = [
    { k: '数量', v: qty || '—', cls: '' },
    { k: '价值', v: valN != null ? fmtHoldUsd(valN) : '?', cls: valN == null ? 'unk' : '' },
  ];
  if (cost) items.push({ k: '成本', v: cost.text.replace(/^成本\s*/, ''), cls: cost.cls || '' });
  if (pnl) items.push({ k: '盈亏', v: pnl.text, cls: pnl.cls || '' });
  box.innerHTML = items.map(x =>
    `<div class="dh-item"><span class="dh-k">${esc(x.k)}</span><span class="dh-v ${esc(x.cls)}">${esc(x.v)}</span></div>`
  ).join('');
}

function syncDetailTradeButtons() {
  const buy = $('#detail-buy');
  const sell = $('#detail-sell');
  const hint = $('#detail-trade-hint');
  const c = S.detail;
  if (!buy || !sell) return;
  const size = getBuySize();
  const sizeOk = size.mode === 'pct' ? size.pct > 0 : Number(size.amount) > 0;
  const canTrade = !c || c.tradeable !== false;
  buy.disabled = !(sizeOk && canTrade) || buy.dataset.busy === '1';
  buy.textContent = !canTrade ? '不可买' : (sizeOk ? `买 ${size.label}` : '买');
  sell.disabled = !canTrade || sell.dataset.busy === '1';
  sell.textContent = canTrade ? `卖 ${getSellAmount()}` : '不可卖';
  if (hint) {
    const pay = getPayToken();
    hint.textContent = `顶栏：付 ${pay.label} · 买 ${size.label || '未选'} · 卖 ${getSellAmount()}`;
  }
}

function setDetailTradeStatus(text, kind = '') {
  const st = $('#detail-trade-status');
  if (!st) return;
  st.hidden = !text;
  st.className = `trade-status ${kind}`.trim();
  st.textContent = text || '';
}

async function detailDoTrade(side) {
  const c = S.detail;
  if (!c) return;
  const btn = side === 'buy' ? $('#detail-buy') : $('#detail-sell');
  if (!btn) return;
  // Reuse board card if present for status; else synthetic
  let card = document.querySelector(`.card[data-ca="${CSS.escape(c.address || '')}"]`);
  if (!card) {
    card = document.createElement('div');
    card.className = 'card';
  }
  // Patch setCardStatus to also mirror into drawer status
  const prev = setCardStatus;
  // lightweight: wrap via listening after
  await doTrade(side, card, c.tradeCa || c.address, btn, c);
  const st = card.querySelector('.trade-status');
  if (st) setDetailTradeStatus(st.textContent, st.className.replace('trade-status', '').trim());
  renderDetailHolding(c);
  syncDetailTradeButtons();
}

function drawCandles(canvas, candles) {
  if (!canvas) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cssW = canvas.clientWidth || 640;
  const cssH = canvas.clientHeight || 220;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.fillStyle = '#0a0d14';
  ctx.fillRect(0, 0, cssW, cssH);
  if (!candles || !candles.length) return;

  const padL = 8, padR = 8, padT = 10, padB = 18;
  const w = cssW - padL - padR;
  const h = cssH - padT - padB;
  let lo = Infinity, hi = -Infinity;
  for (const c of candles) {
    if (c.low != null && c.low < lo) lo = c.low;
    if (c.high != null && c.high > hi) hi = c.high;
  }
  if (!(hi > lo)) { lo = candles[0].close; hi = lo * 1.01 || 1; }
  const span = hi - lo || hi * 0.01 || 1e-12;
  const n = candles.length;
  const slot = w / n;
  const bodyW = Math.max(1, Math.min(10, slot * 0.65));

  // grid
  ctx.strokeStyle = 'rgba(28,35,48,.9)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padT + (h * i) / 4;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + w, y); ctx.stroke();
  }

  const yOf = v => padT + h * (1 - (v - lo) / span);

  for (let i = 0; i < n; i++) {
    const c = candles[i];
    const x = padL + slot * i + slot / 2;
    const up = (c.close ?? 0) >= (c.open ?? 0);
    const col = up ? '#3dff9a' : '#f87171';
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(x, yOf(c.high));
    ctx.lineTo(x, yOf(c.low));
    ctx.stroke();
    const y1 = yOf(c.open);
    const y2 = yOf(c.close);
    const top = Math.min(y1, y2);
    const bh = Math.max(1, Math.abs(y2 - y1));
    ctx.fillRect(x - bodyW / 2, top, bodyW, bh);
  }

  // price labels
  ctx.fillStyle = '#7a8499';
  ctx.font = '10px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.fillText(hi.toPrecision(4), padL + 2, padT + 10);
  ctx.fillText(lo.toPrecision(4), padL + 2, padT + h);
  const last = candles[candles.length - 1];
  if (last?.close != null) {
    ctx.fillStyle = '#3de0ff';
    ctx.textAlign = 'right';
    ctx.fillText(Number(last.close).toPrecision(4), padL + w - 2, padT + 10);
  }
}

async function loadDetailKline() {
  const c = S.detail;
  const meta = $('#kline-meta');
  const empty = $('#kline-empty');
  const canvas = $('#kline-canvas');
  if (!c) return;
  if (S.detailKlineBusy) return;
  S.detailKlineBusy = true;
  if (meta) meta.textContent = '加载中…';
  if (empty) empty.hidden = true;
  try {
    const ca = c.address || c.tradeCa;
    const q = new URLSearchParams({
      ca,
      resolution: S.detailRes || '1m',
      hours: String(S.detailHours || 2),
    });
    if (c.platform) q.set('platform', String(c.platform).toLowerCase());
    const j = await api(`/api/kline?${q}`);
    S.detailCandles = j.candles || [];
    if (meta) {
      if (j.ok) {
        const src = j.source ? String(j.source) : 'GMGN';
        const stale = j.stale ? ' · 缓存' : '';
        const fb = j.fallbackFrom ? ` ←${j.fallbackFrom}` : '';
        meta.textContent = `${j.count || 0} 根 · ${j.resolution || ''} · ${src}${fb}${stale}`;
      } else {
        meta.textContent = j.error || '失败';
      }
    }
    if (!S.detailCandles.length) {
      if (empty) { empty.hidden = false; empty.textContent = j.error || '暂无K线'; }
      drawCandles(canvas, []);
    } else {
      if (empty) empty.hidden = true;
      drawCandles(canvas, S.detailCandles);
    }
  } catch (e) {
    if (meta) meta.textContent = e.message || 'K线失败';
    if (empty) { empty.hidden = false; empty.textContent = e.message || 'K线失败'; }
    drawCandles(canvas, []);
  } finally {
    S.detailKlineBusy = false;
  }
}

function fmtHoldPct(p) {
  if (p == null || !Number.isFinite(p)) return '—';
  if (p >= 10) return `${p.toFixed(1)}%`;
  if (p >= 1) return `${p.toFixed(2)}%`;
  if (p >= 0.01) return `${p.toFixed(3)}%`;
  return `${p.toFixed(4)}%`;
}

function renderHoldersList(holders) {
  const body = $('#detail-holders-body');
  if (!body) return;
  const me = myWalletAddr();
  if (!holders?.length) {
    body.className = 'detail-holders-body empty';
    body.textContent = '暂无持有人数据';
    return;
  }
  body.className = 'detail-holders-body';
  body.innerHTML = holders.map((h, i) => {
    const addr = h.address || '';
    const isMe = me && addr.toLowerCase() === me;
    const label = h.name ? esc(h.name) : esc(shortCa(addr));
    const tags = (h.tags || []).map(t =>
      `<span class="holder-tag ${esc(t)}">${esc(t)}</span>`
    ).join('');
    return `<div class="holder-row${isMe ? ' me' : ''}" data-addr="${esc(addr)}" title="点击复制 ${esc(addr)}">
      <span class="holder-rank">${i + 1}</span>
      <span class="holder-addr">${label}${isMe ? ' · 我' : ''}</span>
      <span class="holder-tags">${tags}</span>
      <span class="holder-pct">${esc(fmtHoldPct(h.holdPct))}</span>
    </div>`;
  }).join('');
  body.querySelectorAll('.holder-row').forEach(row => {
    row.addEventListener('click', () => {
      const a = row.dataset.addr;
      if (!a) return;
      copyCa(a);
    });
  });
}

const HOLDERS_CLIENT_TTL_MS = 300_000;

function holdersCaKey(c) {
  return String(c?.address || c?.tradeCa || '').trim().toLowerCase();
}

function isHoldersRateLimitMsg(j) {
  if (j?.rateLimited) return true;
  const t = String(j?.error || j?.message || '').toLowerCase();
  return t.includes('429') || t.includes('rate_limit') || t.includes('rate limit')
    || t.includes('限频') || t.includes('too many');
}

function mapHoldersErrorZh(err) {
  const t = String(err || '');
  const low = t.toLowerCase();
  if (!t) return '持有人加载失败';
  if (low.includes('429') || low.includes('rate_limit') || t.includes('限频') || low.includes('too many')) {
    return 'GMGN 限频，请等一两分钟再开';
  }
  if (low.includes('gmgn_api_key') || low.includes('api_key missing')) return 'GMGN 密钥未配置';
  if (low.includes('invalid ca')) return '合约地址无效';
  if (low.includes('timeout') || low.includes('aborted') || low.includes('abort')) return '持有人请求超时';
  if (low.includes('network') || low.includes('fetch failed') || low.includes('econn')) return '网络异常，请稍后重试';
  if (t.includes('缺少访问密钥')) return t;
  // avoid dumping raw gmgn status dumps
  if (/^gmgn holders\b/i.test(t) || /code=\d+/.test(t)) return '持有人加载失败，请稍后重试';
  if (t.length > 80) return '持有人加载失败，请稍后重试';
  return t;
}

function showHoldersRetry(body, msg) {
  if (!body) return;
  body.className = 'detail-holders-body err';
  body.innerHTML = `<div class="holders-err-msg">${esc(msg)}</div>`
    + `<button type="button" class="holders-retry" id="holders-retry-btn">重试</button>`;
  body.querySelector('#holders-retry-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    loadDetailHolders(true);
  });
}

async function loadDetailHolders(force = false) {
  const c = S.detail;
  const body = $('#detail-holders-body');
  const meta = $('#holders-meta');
  if (!c || !body) return;
  if (S.detailHoldersBusy) return;

  const ca = holdersCaKey(c);
  if (!ca) {
    showHoldersRetry(body, '合约地址无效');
    if (meta) meta.textContent = '';
    return;
  }

  const cached = S.holdersByCa[ca];
  const fresh = cached && (Date.now() - cached.at < HOLDERS_CLIENT_TTL_MS) && cached.holders?.length;
  if (!force && fresh) {
    if (meta) meta.textContent = `Top ${cached.count || cached.holders.length} · 缓存`;
    renderHoldersList(cached.holders);
    return; // skip network to save GMGN quota
  }

  S.detailHoldersBusy = true;
  if (!cached?.holders?.length) {
    body.className = 'detail-holders-body loading';
    body.textContent = '加载中…';
    if (meta) meta.textContent = '';
  } else {
    // keep showing previous list while refreshing
    if (meta) meta.textContent = `Top ${cached.count || cached.holders.length} · 刷新中`;
  }
  try {
    const q = new URLSearchParams({ ca, limit: '20' });
    const j = await api(`/api/holders?${q}`);
    const rateLimited = isHoldersRateLimitMsg(j);

    if (j.ok && Array.isArray(j.holders)) {
      if (j.holders.length) {
        S.holdersByCa[ca] = { holders: j.holders, count: j.count || j.holders.length, at: Date.now() };
      }
      const metaBits = [];
      metaBits.push(`Top ${j.count || j.holders.length || 0}`);
      if (j.stale || j.rateLimited) metaBits.push('缓存');
      if (meta) meta.textContent = metaBits.join(' · ');
      if (j.holders.length) {
        renderHoldersList(j.holders);
        if (rateLimited || j.stale) {
          // soft banner above list is skipped; meta already says 缓存
        }
      } else if (rateLimited) {
        showHoldersRetry(body, 'GMGN 限频，请等一两分钟再开');
      } else {
        body.className = 'detail-holders-body empty';
        body.textContent = '暂无持有人数据';
      }
      return;
    }

    // error / rate limit — prefer client cache
    if (rateLimited) {
      if (cached?.holders?.length) {
        if (meta) meta.textContent = `Top ${cached.count || cached.holders.length} · 缓存`;
        renderHoldersList(cached.holders);
        return;
      }
      if (meta) meta.textContent = '限频';
      showHoldersRetry(body, 'GMGN 限频，请等一两分钟再开');
      return;
    }

    const zh = mapHoldersErrorZh(j.error || '持有人加载失败');
    if (cached?.holders?.length) {
      if (meta) meta.textContent = `Top ${cached.count || cached.holders.length} · 缓存`;
      renderHoldersList(cached.holders);
      return;
    }
    if (meta) meta.textContent = '失败';
    showHoldersRetry(body, zh);
  } catch (e) {
    const zh = mapHoldersErrorZh(e.message || '持有人加载失败');
    if (cached?.holders?.length) {
      if (meta) meta.textContent = `Top ${cached.count || cached.holders.length} · 缓存`;
      renderHoldersList(cached.holders);
    } else {
      if (meta) meta.textContent = '失败';
      showHoldersRetry(body, zh);
    }
  } finally {
    S.detailHoldersBusy = false;
  }
}

(() => {
  $('#detail-close')?.addEventListener('click', closeDetail);
  $('#detail-backdrop')?.addEventListener('click', closeDetail);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && S.detail) closeDetail();
  });
  $$('#kline-res .kres').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('#kline-res .kres').forEach(b => b.classList.remove('on'));
      btn.classList.add('on');
      S.detailRes = btn.dataset.res || '1m';
      S.detailHours = Number(btn.dataset.hours) || 2;
      if (S.detail) loadDetailKline();
    });
  });
  $('#detail-buy')?.addEventListener('click', e => {
    e.preventDefault();
    detailDoTrade('buy');
  });
  $('#detail-sell')?.addEventListener('click', e => {
    e.preventDefault();
    detailDoTrade('sell');
  });
  // Detail 转主钱包 chips + button
  $$('#detail-xfer .xfer-chip').forEach(btn => {
    btn.addEventListener('click', e => {
      e.preventDefault();
      S.xferPct = Number(btn.dataset.pct) || 100;
      $$('#detail-xfer .xfer-chip').forEach(b => b.classList.toggle('on', b === btn));
      const inp = $('#detail-xfer-amt');
      if (inp) inp.value = '';
    });
  });
  $('#detail-xfer-amt')?.addEventListener('input', () => {
    const inp = $('#detail-xfer-amt');
    if (inp && inp.value && Number(inp.value) > 0) {
      $$('#detail-xfer .xfer-chip').forEach(c => c.classList.remove('on'));
    }
  });
  $('#detail-xfer-btn')?.addEventListener('click', e => {
    e.preventDefault();
    const c = S.detail;
    if (!c) return;
    const ca = c.tradeCa || c.address;
    const inp = $('#detail-xfer-amt');
    const abs = (inp?.value || '').trim();
    let opts;
    if (abs && Number(abs) > 0) opts = { amount: abs };
    else {
      const on = document.querySelector('#detail-xfer .xfer-chip.on');
      const pct = on ? Number(on.dataset.pct) : Number(S.xferPct) || 100;
      opts = pct >= 100 ? { max: true, percent: 100 } : { percent: pct };
    }
    doTransfer(ca, $('#detail-xfer-btn'), c, opts);
  });
  window.addEventListener('resize', () => {
    if (S.detail && S.detailCandles) drawCandles($('#kline-canvas'), S.detailCandles);
  });
  updateXferDestHint();
})();

// Keep drawer trade buttons / holding in sync with top bar + holdings refresh
const _syncBuyUI = syncBuyUI;
syncBuyUI = function patchedSyncBuyUI() {
  _syncBuyUI();
  if (S.detail) syncDetailTradeButtons();
};
const _syncSellHint = syncSellHint;
syncSellHint = function patchedSyncSellHint() {
  _syncSellHint();
  if (S.detail) syncDetailTradeButtons();
};
const _renderHoldings = renderHoldings;
renderHoldings = function patchedRenderHoldings() {
  _renderHoldings();
  if (S.detail) renderDetailHolding(S.detail);
};

refresh();
refreshWalletOnly();
refreshHoldings();
S.timer = setInterval(refresh, 12_000);
setInterval(refreshWalletOnly, 20_000);
setInterval(() => refreshHoldings(false), 45_000);
