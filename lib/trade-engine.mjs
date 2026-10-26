/**
 * In-process aiwb engine for board trades.
 * Avoids spawning `aiwb` twice (check + buy) and can reuse detect `info` after a passed check.
 *
 * Official handler flows (from ai-wallet-binance platforms):
 * - FLAP agent: portal buy/sellBps on market; Agent ID on msg.sender; quoteBuy for size; non-BNB quote = PCS swap+approve+buy
 * - GANG v2: launchpad buy(coin,quoteAmt,min); curves(token); if payToken==quote spend wallet quote (approve+buy, no BNB hop); else WBNB wrap or PCS→quote then approve+buy; 1% walletRoom; sell may need App
 * - FOUR agent: core buy(token,funds,min) with BNB value; template gate; simulate for quote; sell = approve+core.sell
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

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

  const USDT = '0x55d398326f99059fF775485246999027B3197955';
  // PancakeSwap V3 (BSC) — oANTHROPIC/USDT lives here, NOT on V2
  const PCS_V3 = {
    factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
    swapRouter: '0x1b81D678ffb9C0263b24A97847620C99d213eB14',
    quoter: '0xB048Bbc1Ee6b733FFdCce1cFA47797dA2045BdC',
    fees: [100, 500, 2500, 10000],
  };

  // Resolve baw once (board Start-Process often has no npm in PATH → spawnSync baw ENOENT).
  const bawBin = (() => {
    const found = findBaw(cfg);
    if (found) return found;
    const win = process.platform === 'win32';
    const home = process.env.APPDATA || process.env.HOME || '';
    const candidates = win
      ? [
          path.join(home, 'npm', 'baw.cmd'),
          path.join(home, 'npm', 'baw.exe'),
          path.join(process.env.LOCALAPPDATA || '', 'npm', 'baw.cmd'),
        ]
      : [path.join(home, '.npm-global', 'bin', 'baw'), '/usr/local/bin/baw'];
    for (const c of candidates) {
      if (c && fs.existsSync(c)) return c;
    }
    return null;
  })();

  function bawJson(args, { timeout = 60000 } = {}) {
    if (!bawBin) {
      throw new Error('找不到 baw（币安 AI 钱包 CLI）。请 npm i -g @binance/agentic-wallet，或设 BAW_BIN。');
    }
    const shell = process.platform === 'win32' && /\.cmd$/i.test(bawBin);
    const out = execFileSync(shell ? `"${bawBin}"` : bawBin, [...args, '--json'], {
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      shell,
      maxBuffer: 1 << 24,
      env: {
        ...process.env,
        Path: [
          path.dirname(bawBin),
          process.env.Path || process.env.PATH || '',
        ].join(process.platform === 'win32' ? ';' : ':'),
        PATH: [
          path.dirname(bawBin),
          process.env.PATH || process.env.Path || '',
        ].join(process.platform === 'win32' ? ';' : ':'),
      },
    });
    const i = out.indexOf('{');
    const j = out.lastIndexOf('}');
    if (i < 0 || j < 0) throw new Error(`baw bad output: ${out.slice(0, 200)}`);
    return JSON.parse(out.slice(i, j + 1));
  }

  /** Quote + swap pay→quote via Binance aggregator (V3/multi-DEX). Fail-closed on <85% value. */
  async function bawSwapPayToQuote(payToken, quote, payWei, payDec, qDec, paySym, qsym, { dryRun = false } = {}) {
    const { toWei, fromWei } = await load('engine.mjs');
    const payHuman = fromWei(payWei, payDec);
    const q1 = bawJson([
      'market-order', 'quote',
      '--fromTokenQty', payHuman,
      '--fromToken', payToken,
      '--toToken', quote,
      '--binanceChainId', '56',
    ], { timeout: 30000 });
    const toAmt = q1?.data?.toCoinAmount;
    if (!toAmt) throw new Error(`币安聚合无报价 ${paySym}→${qsym}. Nothing was sent.`);
    const expectedQuote = toWei(String(toAmt), qDec);

    // Fail-closed price sanity: reverse-quote must recover >= 85% of pay (in USDT terms when possible)
    async function reverseToUsdt(amountHuman, token) {
      if (sameAddr(token, USDT)) return toWei(String(amountHuman), 18);
      const q = bawJson([
        'market-order', 'quote',
        '--fromTokenQty', String(amountHuman),
        '--fromToken', token,
        '--toToken', USDT,
        '--binanceChainId', '56',
      ], { timeout: 30000 });
      const u = q?.data?.toCoinAmount;
      if (!u) return null;
      return toWei(String(u), 18);
    }

    let payUsdWei = sameAddr(payToken, USDT) ? payWei : null;
    if (payUsdWei == null) {
      try { payUsdWei = await reverseToUsdt(payHuman, payToken); } catch { payUsdWei = null; }
    }
    let recvUsdWei = null;
    try { recvUsdWei = await reverseToUsdt(String(toAmt), quote); } catch { recvUsdWei = null; }

    if (payUsdWei == null || recvUsdWei == null) {
      throw new Error(`换汇价格无法校验（${paySym}→${qsym}）。价格不符常规，未发交易。`);
    }
    if (recvUsdWei * 100n < payUsdWei * 85n) {
      const pct = Number((recvUsdWei * 10000n) / payUsdWei) / 100;
      throw new Error(
        `报价异常拒单：花约 ${fromWei(payUsdWei, 18)} U 经币安聚合只值约 ${fromWei(recvUsdWei, 18)} U（${pct.toFixed(1)}%）。价格不符常规，未发交易。`
      );
    }

    if (dryRun) {
      return {
        dryRun: true,
        expectedQuote,
        expectedQuoteHuman: String(toAmt),
        payHuman,
        via: '币安聚合',
        payUsd: fromWei(payUsdWei, 18),
        recvUsd: fromWei(recvUsdWei, 18),
      };
    }

    const me = (await engine.ctxFor({})).me;
    const beforeQ = await rpc.read(quote, 'balanceOf(address)', [me], ['uint256']);
    const sub = bawJson([
      'market-order', 'swap',
      '--fromTokenQty', payHuman,
      '--fromToken', payToken,
      '--toToken', quote,
      '--binanceChainId', '56',
    ], { timeout: 60000 });
    const orderId = sub?.data?.orderId;
    if (!orderId) throw new Error(`币安聚合下单失败: ${JSON.stringify(sub).slice(0, 200)}`);

    let finished = null;
    const tDeadline = Date.now() + 120000;
    while (Date.now() < tDeadline) {
      const st = bawJson(['market-order', 'list', '--orderId', String(orderId)], { timeout: 30000 });
      const item = st?.data?.list?.[0] || st?.data;
      const status = item?.status;
      if (status === 'FINISHED' || status === 'FAILED') { finished = item; break; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
    }
    if (!finished) throw new Error(`币安聚合订单超时 orderId=${orderId}. Nothing confirmed.`);
    if (finished.status === 'FAILED') {
      throw new Error(`币安聚合兑换失败 orderId=${orderId} tx=${finished.txHash || 'null'}. Nothing usable.`);
    }

    const afterQ = await rpc.read(quote, 'balanceOf(address)', [me], ['uint256']);
    let got = afterQ > beforeQ ? afterQ - beforeQ : 0n;
    if (got <= 0n && finished.toTokenActualQty) {
      got = toWei(String(finished.toTokenActualQty), qDec);
    }
    if (got <= 0n) throw new Error('币安聚合后报价币余额未增加. Nothing was sent to curve.');

    // Post-fill: actual received must be >= 85% of quoted amount (slippage / bad fill)
    if (got * 100n < expectedQuote * 85n) {
      throw new Error(
        `成交异常：预期 ${fromWei(expectedQuote, qDec)} ${qsym}，实到 ${fromWei(got, qDec)}（不足 85%）。已停在报价币，未继续买内盘。`
      );
    }

    return {
      expectedQuote: got,
      expectedQuoteHuman: fromWei(got, qDec),
      payHuman,
      via: '币安聚合',
      orderId: String(orderId),
      swapHash: finished.txHash || null,
      toTokenActualQty: finished.toTokenActualQty || fromWei(got, qDec),
    };
  }

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
      // Auto-pay with USDT → quote on PCS when wallet quote is short (never BNB).
      const usdtBal = await rpc.read(USDT, 'balanceOf(address)', [ctx.me], ['uint256']).catch(() => 0n);
      if (usdtBal > 0n) {
        const [{ PANCAKE }] = await Promise.all([load('platforms/pancake.mjs')]);
        const z = '0x0000000000000000000000000000000000000000';
        const pair = await rpc.read(PANCAKE.factory, 'getPair(address,address)', [USDT, quote], ['address']).catch(() => z);
        if (pair && !sameAddr(pair, z)) {
          let usdtWei;
          try {
            const amountsIn = await rpc.read(
              PANCAKE.router,
              'getAmountsIn(uint256,address[])',
              [quoteWei, [USDT, quote]],
              ['uint256[]'],
            );
            usdtWei = (amountsIn[0] * 103n) / 100n; // +3% cushion
          } catch (e) {
            throw new Error(
              `Need ${fromWei(quoteWei, decimals)} ${qsym} but only have ${fromWei(bal, decimals)}; cannot price USDT top-up: ${e.message}. Nothing was sent.`,
            );
          }
          const usdtDec = Number(await rpc.read(USDT, 'decimals()', [], ['uint8']).catch(() => 18n));
          if (usdtWei > usdtBal) {
            throw new Error(
              `Need ~${fromWei(usdtWei, usdtDec)} USDT to buy ${fromWei(quoteWei, decimals)} ${qsym}, wallet has ${fromWei(usdtBal, usdtDec)} USDT. Nothing was sent.`,
            );
          }
          const usdtHuman = fromWei(usdtWei, usdtDec);
          return runGangBuyWithPayThenQuote(ca, usdtHuman, { dryRun, info, payToken: USDT });
        }
      }
      throw new Error(
        `The AI wallet has ${fromWei(bal, decimals)} ${qsym}, less than ${fromWei(quoteWei, decimals)}, and cannot auto-pay with USDT. Nothing was sent.`,
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

  async function runBuy(ca, amount, {
    dryRun = false, info = null, platformHint = null, graduated = false, payToken = null,
  } = {}) {
    let useInfo = info;
    if (!useInfo || !useInfo.handler) {
      useInfo = await detectFast(ca, platformHint, { graduated });
    }
    if (!useInfo) throw new Error('Could not find where this coin trades. Nothing was sent.');
    if (!useInfo.token) useInfo.token = ca;

    const payRaw = payToken == null || payToken === '' ? 'BNB' : String(payToken).trim();
    const payIsNative = !payRaw || /^BNB$/i.test(payRaw) || /^native$/i.test(payRaw);
    const payAddr = (!payIsNative && /^0x[a-fA-F0-9]{40}$/i.test(payRaw)) ? payRaw : null;

    // GANG curve + pay token == curve quote → spend quote directly (no BNB hop).
    const quoteAddr = useInfo.quote || null;
    const isGangCurve = useInfo.platform === 'gang' && useInfo.phase !== 'dex';
    if (isGangCurve && payAddr && quoteAddr && sameAddr(payAddr, quoteAddr)) {
      return runGangBuyWithQuote(ca, amount, { dryRun, info: useInfo });
    }

    // GANG curve + explicit ERC-20 pay (e.g. USDT) that is NOT the quote:
    // swap pay→quote on Pancake V2, then curve-buy. Never silently spend BNB.
    if (isGangCurve && payAddr && quoteAddr && !sameAddr(payAddr, quoteAddr)) {
      return runGangBuyWithPayThenQuote(ca, amount, { dryRun, info: useInfo, payToken: payAddr });
    }

    // BNB path only when quote is WBNB or has a real BNB/WBNB pool. Thin/no BNB pool
    // (e.g. oANTHROPIC/USDT) must not burn BNB — force USDT/payToken instead.
    if (isGangCurve && (payIsNative || !payAddr)) {
      const [{ PANCAKE, pairOf }] = await Promise.all([load('platforms/pancake.mjs')]);
      const q = quoteAddr;
      const isWbnb = q && String(q).toLowerCase() === String(PANCAKE.wbnb).toLowerCase();
      const bnbPair = isWbnb ? true : !!(await pairOf(rpc, q).catch(() => null));
      if (!bnbPair) {
        throw new Error(
          `This coin is priced in ${useInfo.quoteSymbol || 'a non-BNB quote'} with no Pancake BNB pool. ` +
          `Pay with the quote token or USDT (${USDT}) — do not spend BNB. Nothing was sent.`
        );
      }
    }

    const r = await engine.buy(ca, amount, { dryRun, info: useInfo });
    return jsonSafe(r);
  }

  /**
   * Spend an ERC-20 pay token (USDT etc.) → swap to curve quote on PCS → GANG buy.
   * `amount` is human units of the *pay* token (not BNB).
   */
  async function runGangBuyWithPayThenQuote(ca, payAmountHuman, { dryRun = false, info, payToken }) {
    const [{ encodeCall }, { simulate, delivered }, { toWei, fromWei }, gangMod, pancakeMod] = await Promise.all([
      load('abi.mjs'),
      load('sim.mjs'),
      load('engine.mjs'),
      load('platforms/gang.mjs'),
      load('platforms/pancake.mjs'),
    ]);
    const GANG = gangMod.GANG;
    const PANCAKE = pancakeMod.PANCAKE;
    const ctx = await engine.ctxFor({});
    const quote = info.quote;
    const qsym = info.quoteSymbol || 'quote';
    if (!quote) throw new Error('This GANG curve has no quote token. Nothing was sent.');
    if (!payToken) throw new Error('payToken required for pay→quote buy. Nothing was sent.');
    if (sameAddr(payToken, quote)) {
      return runGangBuyWithQuote(ca, payAmountHuman, { dryRun, info });
    }

    const payDec = Number(await rpc.read(payToken, 'decimals()', [], ['uint8']).catch(() => 18n));
    const qDec = Number(await rpc.read(quote, 'decimals()', [], ['uint8']).catch(() => 18n));
    const paySym = await rpc.read(payToken, 'symbol()', [], ['string']).catch(() => 'pay');
    let payWei = toWei(String(payAmountHuman), payDec);
    if (payWei <= 0n) throw new Error('Amount must be above 0.');

    const payBal = await rpc.read(payToken, 'balanceOf(address)', [ctx.me], ['uint256']);
    if (payBal < payWei) {
      throw new Error(
        `The AI wallet has ${fromWei(payBal, payDec)} ${paySym}, less than ${fromWei(payWei, payDec)}. Nothing was sent.`
      );
    }

    // 没有报价币 / 支付币≠报价币 → 币安聚合换成报价币，再曲线买入（禁止自研 V2 BNB 中转）
    const zero = '0x0000000000000000000000000000000000000000';
    const directV2 = await rpc.read(PANCAKE.factory, 'getPair(address,address)', [payToken, quote], ['address']).catch(() => zero);
    const hasV2Direct = !!(directV2 && !sameAddr(directV2, zero));
    let hasV3 = false;
    for (const fee of PCS_V3.fees) {
      const pool = await rpc.read(PCS_V3.factory, 'getPool(address,address,uint24)', [payToken, quote, fee], ['address']).catch(() => zero);
      if (pool && !sameAddr(pool, zero)) { hasV3 = true; break; }
    }

    // Always prefer 币安聚合 for USDT (and any pay without reliable direct pool path we trust).
    // User rule: 没有报价代币的都走币安聚合.
    // User rule: 没有报价代币时一律币安聚合（本函数即 pay≠quote）
    const useBaw = true;

    if (useBaw) {
      const hop = await bawSwapPayToQuote(payToken, quote, payWei, payDec, qDec, paySym, qsym, { dryRun });
      if (dryRun) {
        return jsonSafe({
          dryRun: true,
          platform: 'gang',
          symbol: info.symbol,
          payPath: 'pay-to-quote-baw',
          plan: {
            via: hop.via,
            spendPay: hop.payHuman,
            paySymbol: paySym,
            expectedQuote: hop.expectedQuoteHuman,
            quoteSymbol: qsym,
            noBnbHop: true,
            hasV3,
            steps: [{ label: `币安聚合 ${paySym}→${qsym}` }, { label: `approve ${qsym}` }, { label: 'buy' }],
          },
          warnings: [`Paying with ${paySym} via Binance aggregator → ${qsym}, then curve buy. BNB not used.`],
        });
      }
      const quoteHuman = hop.expectedQuoteHuman;
      const bought = await runGangBuyWithQuote(ca, quoteHuman, { dryRun: false, info });
      return jsonSafe({
        ...bought,
        payPath: 'pay-to-quote-baw',
        spendPay: hop.payHuman,
        paySymbol: paySym,
        swapHash: hop.swapHash || null,
        orderId: hop.orderId || null,
        via: `${hop.via} ${paySym}→${qsym} + GANG launchpad (no BNB)`,
        warnings: [`Paid ${hop.payHuman} ${paySym} → ${quoteHuman} ${qsym} via 币安聚合 → curve buy. No BNB.`],
      });
    }

    // Rare: non-USDT with V2 direct pair — keep thin local V2 path + round-trip gate
    const path = [payToken, quote];
    const amounts = await rpc.read(PANCAKE.router, 'getAmountsOut(uint256,address[])', [payWei, path], ['uint256[]']);
    const expectedQuote = amounts.at(-1);
    if (!expectedQuote || expectedQuote <= 0n) {
      throw new Error(`PCS quote for ${paySym}→${qsym} is 0. Nothing was sent.`);
    }
    {
      const back = await rpc.read(PANCAKE.router, 'getAmountsOut(uint256,address[])', [expectedQuote, [...path].reverse()], ['uint256[]']);
      const backPay = back.at(-1);
      if (backPay * 100n < payWei * 85n) {
        const pct = Number((backPay * 10000n) / payWei) / 100;
        throw new Error(
          `报价异常拒单：花 ${fromWei(payWei, payDec)} ${paySym} 预估回兑仅 ${fromWei(backPay, payDec)}（${pct.toFixed(1)}%）。未发交易。`
        );
      }
    }
    const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 120);
    const minQuote = (expectedQuote * (10000n - ctx.slippageBps)) / 10000n;
    const swapData = encodeCall(
      'swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)',
      [payWei, minQuote, path, ctx.me, deadline()],
    );
    const via = `PCS V2 ${paySym}→${qsym} + GANG launchpad (no BNB)`;
    if (dryRun) {
      return jsonSafe({
        dryRun: true,
        platform: 'gang',
        symbol: info.symbol,
        payPath: 'pay-to-quote',
        plan: {
          via,
          spendPay: fromWei(payWei, payDec),
          paySymbol: paySym,
          expectedQuote: fromWei(expectedQuote, qDec),
          quoteSymbol: qsym,
          path,
          noBnbHop: true,
          steps: [{ label: `approve ${paySym}` }, { label: `swap→${qsym}` }, { label: `approve ${qsym}` }, { label: 'buy' }],
        },
        warnings: [`Paying with ${paySym} via Pancake V2 → ${qsym}, then curve buy. BNB not used.`],
      });
    }
    const payAllow = await rpc.read(payToken, 'allowance(address,address)', [ctx.me, PANCAKE.router], ['uint256']).catch(() => 0n);
    if (payAllow < payWei) {
      await engine.call({ to: payToken, data: encodeCall('approve(address,uint256)', [PANCAKE.router, payWei]), value: 0n, label: `approve ${paySym}` });
    }
    const beforeQ = await rpc.read(quote, 'balanceOf(address)', [ctx.me], ['uint256']);
    const swapped = await engine.call({ to: PANCAKE.router, data: swapData, value: 0n, label: `swap-${paySym}-to-${qsym}` });
    const afterQ = await rpc.read(quote, 'balanceOf(address)', [ctx.me], ['uint256']);
    let gotQuote = afterQ > beforeQ ? afterQ - beforeQ : 0n;
    if (gotQuote <= 0n) gotQuote = expectedQuote;
    const quoteHuman = fromWei(gotQuote, qDec);
    const bought = await runGangBuyWithQuote(ca, quoteHuman, { dryRun: false, info });
    return jsonSafe({
      ...bought,
      payPath: 'pay-to-quote',
      spendPay: fromWei(payWei, payDec),
      paySymbol: paySym,
      swapHash: swapped?.hash || null,
      via,
      warnings: [`Paid ${fromWei(payWei, payDec)} ${paySym} → ${quoteHuman} ${qsym} → curve buy. No BNB.`],
    })
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
