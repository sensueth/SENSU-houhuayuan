/**
 * In-process aiwb engine for board trades.
 * Avoids spawning `aiwb` twice (check + buy) and can reuse detect `info` after a passed check.
 *
 * Official handler flows (from ai-wallet-binance platforms):
 * - FLAP agent: portal buy/sellBps on market; Agent ID on msg.sender; quoteBuy for size; non-BNB quote = PCS swap+approve+buy
 * - GANG v2: launchpad buy(coin,quoteAmt,min); curves(token); quote-direct if payToken==quote; else configured stable (USDT)→quote on Pancake V2 direct (no BNB hop) then approve+buy. BNB only when the quote itself is BNB/WBNB. 1% walletRoom; sell may need App
 * - FOUR agent: core buy(token,funds,min) with BNB value; template gate; simulate for quote; sell = approve+core.sell
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { decideEnginePay, guardSwapUsd, stableByAddress, MIN_RECEIVED_USD_RATIO } from './pay-path.mjs';

/** PancakeSwap V2 — direct pay→quote only. Never route that hop through WBNB. */
const PCS_V2_ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
const PCS_V2_FACTORY = '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73';

const PLATFORM_HINT = {
  flap: 'flap-agent',
  'flap-agent': 'flap-agent',
  four: 'four-agent',
  'four-agent': 'four-agent',
  gang: 'gang',
};

function jsonSafe(v) {
  return JSON.parse(JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x)));
}

export async function createTradeEngine(aiwbRoot, { rpcUrls } = {}) {
  const root = aiwbRoot;
  const load = name => import(pathToFileURL(path.join(root, 'lib', name)).href);
  const [
    { createRpc, PUBLIC_BSC },
    { createWallet, findBaw },
    { createEngine },
    { check },
    { loadConfig },
    { PLATFORMS },
  ] = await Promise.all([
    load('rpc.mjs'),
    load('wallet.mjs'),
    load('engine.mjs'),
    load('check.mjs'),
    load('store.mjs'),
    load('platforms/index.mjs'),
  ]);

  const cfg = loadConfig();
  const urls = rpcUrls?.length
    ? rpcUrls
    : (cfg.rpc ? String(cfg.rpc).split(',').map(s => s.trim()).filter(Boolean) : PUBLIC_BSC);
  const rpc = createRpc(urls);
  const wallet = createWallet({ bin: findBaw(cfg) });
  const onAppWait = label => {
    console.log(`[board] App confirm needed for ${label} — waiting (Binance App)...`);
  };
  const engine = createEngine({ rpc, wallet, cfg, onAppWait });

  function handlerForPlatform(name) {
    const want = PLATFORM_HINT[name] || name;
    return PLATFORMS.find(p => {
      if (want === 'flap-agent') return !!p.FLAP_AGENT;
      if (want === 'flap') return !!p.FLAP_PORTAL && !p.FLAP_AGENT;
      if (want === 'four-agent') return !!p.FOUR_AGENT;
      if (want === 'gang') return !!p.GANG;
      return false;
    }) || null;
  }

  /**
   * Prefer board's platform hint: one RPC detect path first, then full engine.detect.
   * FOUR graduated (classic or agent pool) must not stick on four-agent — fall through to pancake.
   */
  async function detectFast(ca, platformHint, { graduated = false } = {}) {
    const ctx = await engine.lookCtx();
    const rawHint = platformHint ? String(platformHint).toLowerCase() : null;
    const hint = rawHint ? PLATFORM_HINT[rawHint] : null;
    // Graduated FOUR/FLAP: skip agent-curve hint; go straight to full detect (pancake / flap portal).
    if (graduated && (hint === 'four-agent' || rawHint === 'four' || hint === 'flap-agent' || rawHint === 'flap')) {
      return engine.detect(ctx, ca);
    }
    if (hint) {
      const h = handlerForPlatform(hint);
      if (h?.detect) {
        const partial = await h.detect(ctx, ca).catch(() => null);
        if (partial && !partial.notTradable) {
          return { ...partial, token: ca, handler: h };
        }
        if (partial?.notTradable && partial.launchedToken) {
          // follow launched token via full detect
          return engine.detect(ctx, partial.launchedToken || ca);
        }
        // four-agent null on classic fourmeme or graduating → full detect (pancake / other)
        if (partial) return { ...partial, token: ca, handler: h };
      }
      // FLAP: agent miss → try classic Flap Portal before full scan
      if (hint === 'flap-agent' || rawHint === 'flap') {
        const classic = handlerForPlatform('flap');
        if (classic?.detect) {
          const p2 = await classic.detect(ctx, ca).catch(() => null);
          if (p2 && !p2.notTradable) return { ...p2, token: ca, handler: classic };
        }
      }
    }
    return engine.detect(ctx, ca);
  }

  async function pingRpc() {
    const t0 = Date.now();
    await rpc.blockNumber();
    return Date.now() - t0;
  }

  async function runCheck(ca) {
    const result = await check(engine, ca);
    // Capture live detect info (with handler) for a fast follow-up buy.
    let info = null;
    try {
      const ctx = await engine.lookCtx();
      info = await engine.detect(ctx, ca);
    } catch { /* ignore */ }
    return { result: jsonSafe(result), info };
  }

  function sameAddr(a, b) {
    return a && b && String(a).toLowerCase() === String(b).toLowerCase();
  }

  /**
   * GANG v2 curve buy spending quote ERC-20 already in wallet (GANG/BNCB/…).
   * Skips the silent Pancake BNB→quote hop that stock aiwb buy always does.
   */
  async function runGangBuyWithQuote(ca, quoteAmountHuman, { dryRun = false, info } = {}) {
    const [{ encodeCall }, { simulate, delivered }, { toWei, fromWei }, gangMod] = await Promise.all([
      load('abi.mjs'),
      load('sim.mjs'),
      load('engine.mjs'),
      load('platforms/gang.mjs'),
    ]);
    const GANG = gangMod.GANG;
    const ctx = await engine.ctxFor({});
    const quote = info.quote;
    const qsym = info.quoteSymbol || 'quote';
    if (!quote) throw new Error('This GANG curve has no quote token. Nothing was sent.');

    const decRaw = await rpc.read(quote, 'decimals()', [], ['uint8']).catch(() => 18n);
    const decimals = Number(decRaw);
    let quoteWei = toWei(String(quoteAmountHuman), decimals);
    if (quoteWei <= 0n) throw new Error('Amount must be above 0.');

    const bal = await rpc.read(quote, 'balanceOf(address)', [ctx.me], ['uint256']);
    if (bal < quoteWei) {
      throw new Error(
        `The AI wallet has ${fromWei(bal, decimals)} ${qsym}, less than ${fromWei(quoteWei, decimals)}. `
        + `Top up ${qsym} or pay with USDT. This board will not swap BNB→${qsym}. Nothing was sent.`,
      );
    }

    const room = await rpc.read(GANG.launchpad, 'walletRoom(address,address)', [info.token || ca, ctx.me], ['uint256']);
    if (room <= 0n) {
      throw new Error('This wallet already holds 1% of this coin, the most one wallet may hold before the curve fills.');
    }

    const approveTx = {
      to: quote, value: 0n,
      data: encodeCall('approve(address,uint256)', [GANG.launchpad, quoteWei]),
    };
    const buyTx0 = {
      to: GANG.launchpad, value: 0n,
      data: encodeCall('buy(address,uint256,uint256)', [info.token || ca, quoteWei, 0n]),
    };
    const sim = await simulate(rpc, ctx.me, [approveTx, buyTx0]);
    if (!sim[1]?.ok) {
      throw new Error(`The GANG launchpad refuses this buy right now${sim[1]?.error ? `: ${sim[1].error}` : ''}.`);
    }
    let out = delivered([sim[1]], info.token || ca, ctx.me);
    if (out > room) {
      // shrink quote spend to fit 1% wallet room (~2% buffer like aiwb)
      quoteWei = (quoteWei * room * 98n) / (out * 100n);
      if (quoteWei <= 0n) throw new Error('Wallet room too small after 1% cap. Nothing was sent.');
      approveTx.data = encodeCall('approve(address,uint256)', [GANG.launchpad, quoteWei]);
      buyTx0.data = encodeCall('buy(address,uint256,uint256)', [info.token || ca, quoteWei, 0n]);
      const sim2 = await simulate(rpc, ctx.me, [approveTx, buyTx0]);
      if (!sim2[1]?.ok) {
        throw new Error(`The GANG launchpad refuses this buy right now${sim2[1]?.error ? `: ${sim2[1].error}` : ''}.`);
      }
      out = delivered([sim2[1]], info.token || ca, ctx.me);
    }
    const minOut = (out * (10000n - ctx.slippageBps)) / 10000n;
    const buyTx = {
      to: GANG.launchpad, value: 0n,
      data: encodeCall('buy(address,uint256,uint256)', [info.token || ca, quoteWei, minOut]),
    };
    const via = `GANG launchpad (spend wallet ${qsym}, approve + buy — no BNB→${qsym} hop)`;
    const plan = {
      expectedOut: out.toString(),
      minOut: minOut.toString(),
      spendQuote: fromWei(quoteWei, decimals, 18),
      spendQuoteWei: quoteWei.toString(),
      quote,
      quoteSymbol: qsym,
      via,
      steps: [
        { label: `approve ${qsym}` },
        { label: 'buy' },
      ],
      noBnbHop: true,
    };
    if (dryRun) {
      return jsonSafe({
        dryRun: true,
        platform: 'gang',
        symbol: info.symbol,
        plan,
        payPath: 'quote-direct',
        warnings: [
          'Binance flags sales on this curve as risky: set abnormal handling to confirm in the App.',
          `Paying with existing ${qsym} — skipped Pancake BNB→${qsym} swap.`,
        ],
      });
    }

    const allowance = await rpc
      .read(quote, 'allowance(address,address)', [ctx.me, GANG.launchpad], ['uint256'])
      .catch(() => 0n);
    let approveHash = null;
    if (allowance < quoteWei) {
      const ap = await engine.call({
        to: quote,
        data: encodeCall('approve(address,uint256)', [GANG.launchpad, quoteWei]),
        value: 0n,
        label: `approve ${qsym}`,
      });
      approveHash = ap?.hash || null;
    }
    const bought = await engine.call({
      to: GANG.launchpad,
      data: encodeCall('buy(address,uint256,uint256)', [info.token || ca, quoteWei, minOut]),
      value: 0n,
      label: 'gang-buy-quote',
    });
    return jsonSafe({
      status: 'ok',
      platform: 'gang',
      hash: bought?.hash || null,
      approveHash,
      payPath: 'quote-direct',
      spendQuote: fromWei(quoteWei, decimals, 18),
      quoteSymbol: qsym,
      expectedOut: out.toString(),
      via,
      warnings: plan.warnings || [
        `Paying with existing ${qsym} — skipped Pancake BNB→${qsym} swap.`,
      ],
    });
  }

  function isZeroAddress(a) {
    const s = String(a || '').toLowerCase();
    return !/^0x[a-f0-9]{40}$/.test(s) || /^0x0{40}$/.test(s);
  }

  function lastUint(v) {
    if (v == null) return null;
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v));
    if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
    if (Array.isArray(v) && v.length) return lastUint(v[v.length - 1]);
    if (typeof v === 'object' && typeof v.length === 'number' && v.length > 0) return lastUint(v[v.length - 1]);
    return null;
  }

  /**
   * GANG curve buy funded by an ERC-20 that is not the quote (USDT → oANTHROPIC, …).
   * Direct Pancake V2 pair only — never USDT→WBNB→quote and never native BNB.
   * USD guard runs before any broadcast.
   */
  async function runGangBuyViaPayToken(ca, payAmountHuman, {
    dryRun = false, info, payToken, quoteUsd = null, payUsd = null,
  } = {}) {
    const [{ encodeCall }, { simulate }, { toWei, fromWei }] = await Promise.all([
      load('abi.mjs'),
      load('sim.mjs'),
      load('engine.mjs'),
    ]);
    const ctx = await engine.ctxFor({});
    const quote = info.quote;
    const qsym = info.quoteSymbol || 'quote';
    const pay = String(payToken);
    const stable = stableByAddress(pay);
    const paySym = stable?.key || `${pay.slice(0, 6)}…${pay.slice(-4)}`;
    if (!quote) throw new Error('This GANG curve has no quote token. Nothing was sent.');
    if (sameAddr(pay, quote)) {
      return runGangBuyWithQuote(ca, payAmountHuman, { dryRun, info });
    }

    const [payDecRaw, quoteDecRaw] = await Promise.all([
      rpc.read(pay, 'decimals()', [], ['uint8']).catch(() => 18n),
      rpc.read(quote, 'decimals()', [], ['uint8']).catch(() => 18n),
    ]);
    const payDec = Number(payDecRaw);
    const quoteDec = Number(quoteDecRaw);
    const payWei = toWei(String(payAmountHuman), payDec);
    if (payWei <= 0n) throw new Error('Amount must be above 0. Nothing was sent.');

    const pair = await rpc.read(
      PCS_V2_FACTORY,
      'getPair(address,address)',
      [pay, quote],
      ['address'],
    ).catch(e => {
      throw new Error(
        `读不到 ${paySym}→${qsym} Pancake 池（${e.message || e}）。拒绝改走 BNB。Nothing was sent.`,
      );
    });
    if (isZeroAddress(pair)) {
      throw new Error(
        `没有 ${paySym}→${qsym} 的 Pancake V2 直达池。拒绝经 BNB 中转。Nothing was sent.`,
      );
    }

    const amounts = await rpc.read(
      PCS_V2_ROUTER,
      'getAmountsOut(uint256,address[])',
      [payWei, [pay, quote]],
      ['uint256[]'],
    ).catch(e => {
      throw new Error(
        `${paySym}→${qsym} 询价失败（${e.message || e}）。拒绝改走 BNB。Nothing was sent.`,
      );
    });
    const quoteWei = lastUint(amounts);
    if (quoteWei == null || quoteWei <= 0n) {
      throw new Error(`${paySym}→${qsym} 询价为 0。拒绝改走 BNB。Nothing was sent.`);
    }

    const payHuman = Number(fromWei(payWei, payDec));
    const quoteHuman = Number(fromWei(quoteWei, quoteDec));
    const px = payUsd != null && Number(payUsd) > 0
      ? Number(payUsd)
      : (stable ? stable.usd : null);
    const guard = guardSwapUsd({
      payAmount: payHuman,
      payUsd: px,
      quoteOut: quoteHuman,
      quoteUsd: quoteUsd != null ? Number(quoteUsd) : null,
    });
    if (!guard.ok) {
      const why = guard.error || '支付/到账美元价值不匹配';
      throw new Error(
        quoteUsd == null || !(Number(quoteUsd) > 0)
          ? `缺少 ${qsym} 美元价，无法核对 ${paySym}→${qsym} 是否亏穿（到账至少要有支付的 ${Math.round(MIN_RECEIVED_USD_RATIO * 100)}%）。拒绝广播。Nothing was sent.`
          : why,
      );
    }

    const bal = await rpc.read(pay, 'balanceOf(address)', [ctx.me], ['uint256']);
    if (bal < payWei) {
      throw new Error(
        `AI 钱包有 ${fromWei(bal, payDec)} ${paySym}，少于 ${fromWei(payWei, payDec)}。不会改花 BNB。Nothing was sent.`,
      );
    }

    const slipBps = Number(ctx.slippageBps);
    const slip = Number.isFinite(slipBps) && slipBps >= 0 && slipBps < 5000 ? slipBps : 300;
    const keepBps = BigInt(Math.max(10000 - slip, Math.round(MIN_RECEIVED_USD_RATIO * 10000)));
    const minOut = (quoteWei * keepBps) / 10000n;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
    const allowance = await rpc
      .read(pay, 'allowance(address,address)', [ctx.me, PCS_V2_ROUTER], ['uint256'])
      .catch(() => 0n);

    const txs = [];
    if (allowance < payWei) {
      txs.push({
        to: pay,
        value: 0n,
        data: encodeCall('approve(address,uint256)', [PCS_V2_ROUTER, payWei]),
      });
    }
    txs.push({
      to: PCS_V2_ROUTER,
      value: 0n,
      data: encodeCall(
        'swapExactTokensForTokens(uint256,uint256,address[],address,uint256)',
        [payWei, minOut, [pay, quote], ctx.me, deadline],
      ),
    });

    const sim = await simulate(rpc, ctx.me, txs);
    const swapSim = sim[sim.length - 1];
    if (!swapSim?.ok) {
      throw new Error(
        `${paySym}→${qsym} 模拟失败${swapSim?.error ? `: ${swapSim.error}` : ''}。拒绝改走 BNB。Nothing was sent.`,
      );
    }

    const via = `Pancake V2 ${paySym}→${qsym} direct (no BNB), then GANG buy with ${qsym}`;
    const plan = {
      via,
      noBnbHop: true,
      payPath: stable ? 'stable-to-quote' : 'pay-to-quote',
      payToken: pay,
      paySymbol: paySym,
      spendPay: fromWei(payWei, payDec, 18),
      expectedQuote: fromWei(quoteWei, quoteDec, 18),
      minQuote: fromWei(minOut, quoteDec, 18),
      quote,
      quoteSymbol: qsym,
      pair: String(pair),
      spendUsd: guard.spendUsd,
      receivedUsd: guard.receivedUsd,
      receivedRatio: guard.ratio,
      steps: [
        ...(allowance < payWei ? [{ label: `approve ${paySym}` }] : []),
        { label: `swap ${paySym}→${qsym}` },
        { label: `approve ${qsym}` },
        { label: 'buy' },
      ],
    };
    if (dryRun) {
      return jsonSafe({
        dryRun: true,
        platform: 'gang',
        symbol: info.symbol,
        plan,
        payPath: plan.payPath,
        via,
        warnings: [
          `Paying with ${paySym} → ${qsym} on Pancake V2. Native BNB is not spent.`,
          `Quote out ≈ $${Number(guard.receivedUsd).toFixed(2)} vs spend ≈ $${Number(guard.spendUsd).toFixed(2)}.`,
        ],
      });
    }

    let approveHash = null;
    if (allowance < payWei) {
      const ap = await engine.call({
        to: pay,
        data: encodeCall('approve(address,uint256)', [PCS_V2_ROUTER, payWei]),
        value: 0n,
        label: `approve ${paySym}`,
      });
      approveHash = ap?.hash || null;
    }
    const quoteBefore = await rpc.read(quote, 'balanceOf(address)', [ctx.me], ['uint256']);
    const swapped = await engine.call({
      to: PCS_V2_ROUTER,
      data: txs[txs.length - 1].data,
      value: 0n,
      label: `swap-${paySym}-to-${qsym}`,
    });
    const quoteAfter = await rpc.read(quote, 'balanceOf(address)', [ctx.me], ['uint256']);
    const got = quoteAfter > quoteBefore ? quoteAfter - quoteBefore : 0n;
    if (got <= 0n) {
      throw new Error(`${paySym}→${qsym} 成交后报价币没有增加。没有继续买曲线，也没有花 BNB。`);
    }
    const gotHuman = fromWei(got, quoteDec);
    const guard2 = guardSwapUsd({
      payAmount: payHuman,
      payUsd: px,
      quoteOut: Number(gotHuman),
      quoteUsd: quoteUsd != null ? Number(quoteUsd) : null,
    });
    if (!guard2.ok) {
      throw new Error(
        `${guard2.error || '到账美元价值过低'} 报价币已留在钱包（${gotHuman} ${qsym}），没有拿去曲线买入，也没有花 BNB。`,
      );
    }

    let bought;
    try {
      bought = await runGangBuyWithQuote(ca, gotHuman, { dryRun: false, info });
    } catch (e) {
      throw new Error(
        `${e.message || e} ${qsym} from the ${paySym} swap is still in the AI wallet. BNB was not spent.`,
      );
    }
    return jsonSafe({
      ...bought,
      payPath: plan.payPath,
      paySymbol: paySym,
      spendPay: plan.spendPay,
      swapHash: swapped?.hash || null,
      approvePayHash: approveHash,
      via,
      spendUsd: guard2.spendUsd,
      receivedUsd: guard2.receivedUsd,
      noBnbHop: true,
    });
  }

  async function runBuy(ca, amount, {
    dryRun = false, info = null, platformHint = null, graduated = false, payToken = null,
    quoteUsd = null, payUsd = null,
  } = {}) {
    let useInfo = info;
    if (!useInfo || !useInfo.handler) {
      useInfo = await detectFast(ca, platformHint, { graduated });
    }
    if (!useInfo) throw new Error('Could not find where this coin trades. Nothing was sent.');
    if (!useInfo.token) useInfo.token = ca;

    const payRaw = payToken == null || payToken === '' ? 'BNB' : String(payToken).trim();
    const onDex = graduated || useInfo.phase === 'dex' || useInfo.graduated === true;
    const hintedGang = String(useInfo.platform || '').toLowerCase() === 'gang'
      || String(platformHint || '').toLowerCase() === 'gang';
    const decision = decideEnginePay({
      payToken: payRaw,
      quoteAddress: useInfo.quote || null,
      quoteSymbol: useInfo.quoteSymbol || null,
      // Card hint wins when detect omits platform — a GANG curve must not fall through to BNB.
      platform: hintedGang ? 'gang' : (useInfo.platform || platformHint),
      graduated: onDex,
    });
    if (!decision.ok) {
      throw new Error(decision.error || '拒绝这笔支付路径。Nothing was sent.');
    }
    if (decision.nativeBnb && !decision.quoteIsBnb && (useInfo.platform === 'gang') && !onDex) {
      throw new Error('拒绝用 BNB 购买非 BNB 报价的曲线。Nothing was sent.');
    }

    if (decision.path === 'quote-direct') {
      return runGangBuyWithQuote(ca, amount, { dryRun, info: useInfo });
    }
    if (decision.path === 'stable-to-quote' || decision.path === 'pay-to-quote') {
      return runGangBuyViaPayToken(ca, amount, {
        dryRun,
        info: useInfo,
        payToken: decision.payToken,
        quoteUsd,
        payUsd,
      });
    }

    // BNB-priced quote only. Amount is BNB. Stock aiwb wraps WBNB or pays native.
    const r = jsonSafe(await engine.buy(ca, amount, { dryRun, info: useInfo }));
    return { ...r, payPath: 'bnb', nativeBnb: true, noBnbHop: false };
  }

  /**
   * After a buy: open sell allowance for this bag (exact amount of current hold).
   * Does NOT sell — only approve(spender, held) when plan.approve is required.
   */
  async function runEnsureSellApprove(ca, { platformHint = null, info = null, graduated = false } = {}) {
    const t0 = Date.now();
    let useInfo = info && info.handler ? info : await detectFast(ca, platformHint, { graduated });
    if (!useInfo) return { ok: false, skipped: true, reason: 'undetectable', tookMs: Date.now() - t0 };
    if (useInfo.notTradable) {
      return { ok: true, skipped: true, reason: useInfo.reason || 'not tradable', tookMs: Date.now() - t0 };
    }
    if (!useInfo.token) useInfo.token = ca;

    const dry = await engine.sell(ca, { percent: 100 }, { dryRun: true, info: useInfo });
    const a = dry?.plan?.approve;
    if (!a) {
      return {
        ok: true,
        skipped: true,
        reason: 'no sell approve needed',
        platform: dry?.platform || useInfo.platform,
        tookMs: Date.now() - t0,
      };
    }

    const [{ encodeCall }, ctx] = await Promise.all([
      import(pathToFileURL(path.join(root, 'lib', 'abi.mjs')).href),
      engine.ctxFor({}),
    ]);
    const amount = typeof a.amount === 'bigint' ? a.amount : BigInt(a.amount);
    const have = await rpc
      .read(a.token, 'allowance(address,address)', [ctx.me, a.spender], ['uint256'])
      .catch(() => 0n);
    if (have >= amount) {
      return {
        ok: true,
        skipped: true,
        reason: 'allowance already enough',
        token: a.token,
        spender: a.spender,
        platform: dry?.platform || useInfo.platform,
        tookMs: Date.now() - t0,
      };
    }

    const data = encodeCall('approve(address,uint256)', [a.spender, amount]);
    const sent = await engine.call({
      to: a.token,
      data,
      value: 0n,
      label: 'sell-approve',
    });
    return {
      ok: true,
      skipped: false,
      approved: true,
      hash: sent?.hash || null,
      token: a.token,
      spender: a.spender,
      amount: amount.toString(),
      platform: dry?.platform || useInfo.platform,
      tookMs: Date.now() - t0,
      tradePath: 'aiwb',
    };
  }

  async function runSell(ca, amountStr, { dryRun = false, platformHint = null, graduated = false } = {}) {
    // Parse "50%" or raw amount like aiwb CLI
    const opts = {};
    if (/%$/.test(String(amountStr).trim())) {
      opts.percent = Number(String(amountStr).trim().slice(0, -1));
    } else {
      opts.amount = String(amountStr).trim();
    }
    // Pre-detect with platform hint (Flap=market CA, GANG/FOUR=token). Pass info into
    // engine.sell so a second flaky RPC detect cannot wipe a good first hit.
    const info = await detectFast(ca, platformHint, { graduated });
    if (!info) throw new Error('Could not find where this coin trades. Nothing was sent.');
    if (info.notTradable) {
      throw new Error(
        info.launchedToken
          ? `This agent coin already launched as ${info.launchedToken}. Claim first: aiwb claim ${info.market}`
          : (info.reason || 'This market is not open for trading. Nothing was sent.'),
      );
    }
    if (!info.token) info.token = ca;
    const r = await engine.sell(ca, opts, { dryRun, info });
    return jsonSafe(r);
  }

  return {
    rpc,
    engine,
    cfg,
    urls,
    pingRpc,
    runCheck,
    runBuy,
    runSell,
    runEnsureSellApprove,
    detectFast,
    PLATFORMS,
  };
}

export function aiwbRootExists(root) {
  return root && fs.existsSync(path.join(root, 'lib', 'engine.mjs'));
}
