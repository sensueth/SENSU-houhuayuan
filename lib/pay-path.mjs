/**
 * Curve-buy pay path.
 *
 * (a) Wallet already holds enough of the curve quote → quote-direct (no hop).
 * (b) Quote is short, but a configured stable (USDT, then USDC) covers the sized
 *     spend → spend that stable and swap stable→quote, never BNB.
 * (c) Both short, and the quote is not BNB-priced → refuse. Do not spend BNB.
 *
 * BNB is allowed only when the curve quote itself is BNB/WBNB.
 * An explicit pay CA (user typed #pay-ca) is never cleared and never replaced
 * with BNB. Typed USDT stays USDT.
 *
 * Before a pay→quote hop is broadcast, received quote USD must be at least
 * MIN_RECEIVED_USD_RATIO of spend USD (default 50%). The 0.3 BNB → ~$1
 * oANTHROPIC burn fails this check.
 */

export const ADDRESSES = {
  USDT: '0x55d398326f99059fF775485246999027B3197955',
  USDC: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
  WBNB: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  GANG: '0x0c6302401aa5325c2e36f170f52c00b1d220b405',
  BNCB: '0x4902C5ebc598265Ed2212b559B042De8a5Eeec3f',
  NVDAB: '0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436',
};

/** Stables the engine will spend before BNB. USDT first. */
export const STABLES = [
  { key: 'USDT', address: ADDRESSES.USDT, usd: 1 },
  { key: 'USDC', address: ADDRESSES.USDC, usd: 1 },
];

export const KNOWN_PAY = {
  BNB: 'BNB',
  USDT: ADDRESSES.USDT,
  USDC: ADDRESSES.USDC,
  GANG: ADDRESSES.GANG,
  BNCB: ADDRESSES.BNCB,
  NVDAB: ADDRESSES.NVDAB,
};

/** Reject a hop when quote received is below this fraction of spend USD. */
export const MIN_RECEIVED_USD_RATIO = 0.5;

const EPS = 1e-9;

export function sameAddr(a, b) {
  return !!(a && b && String(a).toLowerCase() === String(b).toLowerCase());
}

export function isHexAddr(s) {
  return typeof s === 'string' && /^0x[a-fA-F0-9]{40}$/.test(s.trim());
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function isBnbQuote(symbol, address) {
  const s = String(symbol || '').trim().toUpperCase();
  if (s === 'BNB' || s === 'WBNB') return true;
  const a = String(address || '').trim().toLowerCase();
  if (!a) return false;
  if (a === 'bnb') return true;
  if (a === ADDRESSES.WBNB.toLowerCase()) return true;
  if (a === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') return true;
  return false;
}

export function stableByKey(key) {
  const k = String(key || '').trim().toUpperCase();
  return STABLES.find(s => s.key === k) || null;
}

export function stableByAddress(addr) {
  if (!isHexAddr(String(addr || ''))) return null;
  return STABLES.find(s => sameAddr(s.address, addr)) || null;
}

export function knownPayToken(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (isHexAddr(s)) {
    const hit = Object.entries(KNOWN_PAY).find(([, v]) => v !== 'BNB' && sameAddr(v, s));
    return hit ? { key: hit[0], token: hit[1] } : { key: 'custom', token: s };
  }
  const up = s.toUpperCase();
  if (up === 'BNB' || up === 'NATIVE') return { key: 'BNB', token: 'BNB' };
  if (KNOWN_PAY[up]) return { key: up, token: KNOWN_PAY[up] };
  const st = stableByKey(up);
  if (st) return { key: st.key, token: st.address };
  return null;
}

export function roundPayAmount(n) {
  const x = Number(n);
  if (!(x > 0) || !Number.isFinite(x)) return null;
  let d = 6;
  if (x >= 100) d = 2;
  else if (x >= 1) d = 4;
  const r = Number(x.toFixed(d));
  return r > 0 ? r : null;
}

/**
 * Size a buy in the pay token. Absolute amounts are already in pay-token units.
 * Percent amounts become pay-token units via mcUsd / payUsd.
 * Does not size in BNB unless the pay token is BNB.
 */
export function sizePaySpend({
  mode = 'abs',
  pct = null,
  absAmount = null,
  mcUsd = null,
  payUsd = null,
  maxAmount = null,
} = {}) {
  const cap = num(maxAmount);
  if (mode === 'pct') {
    const mc = num(mcUsd);
    const px = num(payUsd);
    const p = num(pct);
    if (!(mc > 0) || !(px > 0) || !(p > 0)) {
      return { ok: false, error: '按 % 买入需要市值和支付币美元价（不能改按 BNB 估算）' };
    }
    let amt = (p / 100) * mc / px;
    if (cap && amt > cap) amt = cap;
    const rounded = roundPayAmount(amt);
    if (!(rounded > 0)) return { ok: false, error: '估算支付数量为 0' };
    return { ok: true, amount: String(rounded), spendUsd: (p / 100) * mc, payUsd: px };
  }
  let n = num(absAmount);
  if (!(n > 0)) return { ok: false, error: 'amount 须为正数' };
  if (cap && n > cap) n = cap;
  const rounded = roundPayAmount(n) ?? n;
  const px = num(payUsd);
  return {
    ok: true,
    amount: String(rounded),
    spendUsd: px && px > 0 ? rounded * px : null,
    payUsd: px && px > 0 ? px : null,
  };
}

export function assertSpendReceivedUsd({
  spendUsd,
  receivedUsd,
  minRatio = MIN_RECEIVED_USD_RATIO,
} = {}) {
  const spend = num(spendUsd);
  const recv = num(receivedUsd);
  const ratio = minRatio > 0 && minRatio < 1 ? minRatio : MIN_RECEIVED_USD_RATIO;
  if (!(spend > 0) || !(recv > 0)) {
    return {
      ok: false,
      ratio: null,
      spendUsd: spend,
      receivedUsd: recv,
      error: '无法比较支付与报价币美元价值（缺价格或到账为 0），拒绝广播。Nothing was sent.',
    };
  }
  const got = recv / spend;
  if (got < ratio) {
    return {
      ok: false,
      ratio: got,
      spendUsd: spend,
      receivedUsd: recv,
      error: `报价币到账约 $${recv.toFixed(2)}，低于支付 $${spend.toFixed(2)} 的 ${Math.round(ratio * 100)}%（实际 ${(got * 100).toFixed(1)}%）。疑似走错池或滑点过大，拒绝广播。Nothing was sent.`,
    };
  }
  return { ok: true, ratio: got, spendUsd: spend, receivedUsd: recv, error: null };
}

export function guardSwapUsd({
  payAmount,
  payUsd,
  quoteOut,
  quoteUsd,
  minRatio = MIN_RECEIVED_USD_RATIO,
} = {}) {
  const pay = num(payAmount);
  const px = num(payUsd);
  const out = num(quoteOut);
  const qpx = num(quoteUsd);
  if (!(pay > 0) || !(px > 0) || !(out > 0) || !(qpx > 0)) {
    return assertSpendReceivedUsd({ spendUsd: null, receivedUsd: null, minRatio });
  }
  return assertSpendReceivedUsd({
    spendUsd: pay * px,
    receivedUsd: out * qpx,
    minRatio,
  });
}

function useDecision(base, extra) {
  return {
    action: 'use',
    clearPayCa: false,
    keepExplicit: false,
    switched: false,
    rewriteAmount: null,
    error: null,
    ...base,
    ...extra,
  };
}

/**
 * Frontend / dry selection. Balances are human units.
 * explicit=true means the user typed #pay-ca — never override, never clear.
 */
export function chooseCurvePay({
  quoteSymbol = null,
  quoteAddress = null,
  quoteUsd = null,
  quoteKey = null,
  explicit = false,
  payToken = 'BNB',
  payKey = 'BNB',
  payLabel = null,
  sizeMode = 'abs',
  sizeAmount = null,
  sizePct = null,
  mcUsd = null,
  bnbUsd = null,
  quoteBalance = 0,
  stableBalances = {},
  selectedPayUsd = null,
} = {}) {
  const quoteAddr = quoteAddress && isHexAddr(String(quoteAddress)) ? String(quoteAddress) : null;
  const quoteIsBnb = isBnbQuote(quoteSymbol, quoteAddr);
  const token = String(payToken || 'BNB');
  const key = String(payKey || 'BNB');
  const base = { explicit: !!explicit, clearPayCa: false, quoteIsBnb };

  if (explicit && token && token !== 'BNB' && !isBnbQuote(key, token)) {
    const isQuote = !!(quoteAddr && sameAddr(token, quoteAddr));
    const stable = stableByAddress(token) || stableByKey(key);
    let path = 'pay-to-quote';
    if (isQuote) path = 'quote-direct';
    else if (stable) path = 'stable-to-quote';
    return useDecision(base, {
      path,
      payKey: stable?.key || (isQuote ? (quoteKey || String(quoteSymbol || key).toUpperCase()) : key),
      payToken: token,
      payLabel: stable?.key || payLabel || key,
      switched: false,
      keepExplicit: true,
      rewriteAmount: null,
      reason: isQuote ? 'explicit-quote' : 'explicit-pay',
    });
  }

  if (explicit && (token === 'BNB' || isBnbQuote(key, token))) {
    if (!quoteIsBnb) {
      return {
        ...base,
        action: 'refuse',
        path: 'refuse',
        payKey: key,
        payToken: token,
        payLabel: payLabel || 'BNB',
        switched: false,
        keepExplicit: true,
        rewriteAmount: null,
        reason: 'explicit-bnb-blocked',
        error: `报价是 ${quoteSymbol || '非 BNB'}，不是 BNB 池。已保留支付框，但拒绝用 BNB 去换报价币。请改填 USDT 或报价币 CA。`,
      };
    }
    return useDecision(base, {
      path: 'bnb',
      payKey: 'BNB',
      payToken: 'BNB',
      payLabel: 'BNB',
      switched: false,
      keepExplicit: true,
      reason: 'explicit-bnb',
    });
  }

  const mode = sizeMode === 'pct' ? 'pct' : 'abs';
  const absAmt = num(sizeAmount);
  const pct = num(sizePct);
  const mc = num(mcUsd);
  const bnbPx = num(bnbUsd);
  const qPx = num(quoteUsd);
  const selPx = num(selectedPayUsd);
  const qBal = num(quoteBalance) || 0;

  let spendUsd = null;
  if (mode === 'pct' && pct > 0 && mc > 0) spendUsd = (pct / 100) * mc;
  else if (mode === 'abs' && absAmt > 0) {
    const px = (token === 'BNB' || key === 'BNB' || isBnbQuote(key, token)) ? bnbPx : selPx;
    if (px > 0) spendUsd = absAmt * px;
  }

  const payingQuote = !!(quoteAddr && sameAddr(token, quoteAddr));
  const needQuote = (spendUsd > 0 && qPx > 0)
    ? spendUsd / qPx
    : (payingQuote && mode === 'abs' && absAmt > 0 ? absAmt : null);

  if (!quoteIsBnb && quoteAddr && needQuote > 0 && qBal + EPS >= needQuote) {
    const rewrite = (mode === 'abs' && !payingQuote) ? roundPayAmount(needQuote) : null;
    return useDecision(base, {
      path: 'quote-direct',
      payKey: quoteKey || String(quoteSymbol || 'QUOTE').toUpperCase(),
      payToken: quoteAddr,
      payLabel: quoteSymbol || quoteKey || 'QUOTE',
      switched: !payingQuote,
      rewriteAmount: rewrite,
      amountMode: rewrite != null ? 'abs' : mode,
      reason: 'quote-covers',
      spendUsd,
      need: needQuote,
      bal: qBal,
    });
  }

  if (!quoteIsBnb) {
    const currentStable = stableByAddress(token) || stableByKey(key);
    if (!(spendUsd > 0)) {
      if (currentStable) {
        return useDecision(base, {
          path: 'stable-to-quote',
          payKey: currentStable.key,
          payToken: currentStable.address,
          payLabel: currentStable.key,
          switched: false,
          reason: 'stable-keep-unpriced',
        });
      }
      const anyStable = STABLES.some(st => (num(stableBalances[st.key]) || 0) > 0);
      return {
        ...base,
        action: 'refuse',
        path: 'refuse',
        switched: false,
        keepExplicit: false,
        rewriteAmount: null,
        reason: anyStable ? 'cannot-size-stable' : 'no-quote-no-stable',
        error: anyStable
          ? '报价不是 BNB。钱包有 USDT，但缺少美元价格，无法把数量换成 USDT。拒绝用 BNB。'
          : `报价币 ${quoteSymbol || ''} 不够，也没有可用的 USDT。该池不是 BNB 计价，拒绝用 BNB。`.trim(),
      };
    }

    const ordered = [];
    if (currentStable) ordered.push(currentStable);
    for (const st of STABLES) {
      if (!ordered.some(s => s.key === st.key)) ordered.push(st);
    }
    let shortStable = null;
    for (const st of ordered) {
      const bal = num(stableBalances[st.key]) || num(stableBalances[st.address]) || 0;
      const need = spendUsd / st.usd;
      const already = sameAddr(token, st.address) || key.toUpperCase() === st.key;
      if (bal + EPS >= need) {
        const rewrite = (mode === 'abs' && !already) ? roundPayAmount(need) : null;
        return useDecision(base, {
          path: 'stable-to-quote',
          payKey: st.key,
          payToken: st.address,
          payLabel: st.key,
          switched: !already,
          rewriteAmount: rewrite,
          amountMode: rewrite != null ? 'abs' : mode,
          reason: 'stable-covers',
          spendUsd,
          need,
          bal,
        });
      }
      if (already && !shortStable) shortStable = { st, bal, need };
    }
    if (shortStable) {
      return useDecision(base, {
        path: 'stable-to-quote',
        payKey: shortStable.st.key,
        payToken: shortStable.st.address,
        payLabel: shortStable.st.key,
        switched: false,
        reason: 'stable-short-keep',
        spendUsd,
        need: shortStable.need,
        bal: shortStable.bal,
      });
    }
    return {
      ...base,
      action: 'refuse',
      path: 'refuse',
      switched: false,
      keepExplicit: false,
      rewriteAmount: null,
      reason: 'no-quote-no-stable',
      spendUsd,
      error: `报价币 ${quoteSymbol || ''} 不够，USDT 也不够这次金额。该池不是 BNB 计价，拒绝用 BNB 去换。`.trim(),
    };
  }

  const stable = stableByAddress(token) || stableByKey(key);
  if (stable) {
    return useDecision(base, {
      path: 'stable-to-quote',
      payKey: stable.key,
      payToken: stable.address,
      payLabel: stable.key,
      switched: false,
      reason: 'user-stable-on-bnb-quote',
    });
  }
  if (isHexAddr(token) && !isBnbQuote(key, token)) {
    return useDecision(base, {
      path: 'pay-to-quote',
      payKey: key,
      payToken: token,
      payLabel: payLabel || key,
      switched: false,
      reason: 'user-erc20-on-bnb-quote',
    });
  }
  return useDecision(base, {
    path: 'bnb',
    payKey: 'BNB',
    payToken: 'BNB',
    payLabel: 'BNB',
    switched: token !== 'BNB' && key !== 'BNB',
    reason: 'bnb-quote',
  });
}

/**
 * Server / engine decision after the curve quote is known.
 * Never returns a BNB spend for a non-BNB GANG curve quote.
 * A non-native pay token is never ignored.
 */
export function decideEnginePay({
  payToken = 'BNB',
  quoteAddress = null,
  quoteSymbol = null,
  platform = null,
  graduated = false,
} = {}) {
  const known = knownPayToken(payToken);
  const raw = String(payToken || 'BNB').trim();
  const token = known ? known.token : raw;
  const payAddr = isHexAddr(token) ? token : null;
  const payIsNative = token === 'BNB' || /^native$/i.test(token);
  const quoteAddr = isHexAddr(String(quoteAddress || '')) ? String(quoteAddress) : null;
  const quoteIsBnb = isBnbQuote(quoteSymbol, quoteAddr);
  const gangCurve = String(platform || '').toLowerCase() === 'gang' && !graduated;
  const payIsQuote = !!(payAddr && quoteAddr && sameAddr(payAddr, quoteAddr));

  if (!known && !payIsNative && !payAddr) {
    return {
      ok: false,
      path: 'refuse',
      nativeBnb: false,
      error: `不认识支付币 ${raw}，拒绝改花 BNB。Nothing was sent.`,
    };
  }

  if (payIsQuote) {
    return { ok: true, path: 'quote-direct', payToken: payAddr, nativeBnb: false, quoteIsBnb };
  }

  if (payAddr) {
    const stable = stableByAddress(payAddr);
    if (!gangCurve) {
      return {
        ok: false,
        path: 'refuse',
        nativeBnb: false,
        payToken: payAddr,
        error: `已指定支付 ${stable?.key || payAddr}，此路径不会静默改花 BNB。非 GANG 曲线暂不支持该币换成报价币。Nothing was sent.`,
      };
    }
    if (!quoteAddr) {
      return {
        ok: false,
        path: 'refuse',
        nativeBnb: false,
        error: '曲线报价币地址未知，拒绝广播。Nothing was sent.',
      };
    }
    return {
      ok: true,
      path: stable ? 'stable-to-quote' : 'pay-to-quote',
      payToken: payAddr,
      nativeBnb: false,
      quoteIsBnb,
    };
  }

  if (gangCurve && !quoteIsBnb) {
    const label = quoteSymbol || quoteAddr || '非 BNB';
    return {
      ok: false,
      path: 'refuse',
      nativeBnb: false,
      quoteIsBnb: false,
      error: `该 GANG 曲线报价是 ${label}，不是 BNB 池。拒绝用 BNB 兑换报价币（会打到错误池）。请用报价币或 USDT 支付。Nothing was sent.`,
    };
  }

  if (gangCurve && !quoteAddr && !quoteIsBnb) {
    return {
      ok: false,
      path: 'refuse',
      nativeBnb: false,
      error: '还不知道该曲线的报价币，拒绝默认花 BNB。Nothing was sent.',
    };
  }

  return { ok: true, path: 'bnb', payToken: 'BNB', nativeBnb: true, quoteIsBnb };
}
