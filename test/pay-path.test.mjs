import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  ADDRESSES,
  chooseCurvePay,
  decideEnginePay,
  guardSwapUsd,
  assertSpendReceivedUsd,
} from '../lib/pay-path.mjs';

const QUOTE = '0x24B518b332543a4E1C3649d063daB199d103760a'; // oANTHROPIC
const USDT = ADDRESSES.USDT;
const CRAB = {
  quoteSymbol: 'oANTHROPIC',
  quoteAddress: QUOTE,
  quoteUsd: 0.02,
  quoteKey: 'OANTHROPIC',
};

test('(a) enough quote → quote-direct, not BNB', () => {
  const d = chooseCurvePay({
    ...CRAB,
    payToken: 'BNB',
    payKey: 'BNB',
    sizeMode: 'abs',
    sizeAmount: 0.05,
    bnbUsd: 600,
    quoteBalance: 5000,
    stableBalances: { USDT: 1000 },
  });
  assert.equal(d.action, 'use');
  assert.equal(d.path, 'quote-direct');
  assert.equal(d.payToken.toLowerCase(), QUOTE.toLowerCase());
  assert.notEqual(d.payToken, 'BNB');
  assert.equal(d.clearPayCa, false);
  // 0.05 BNB * $600 / $0.02 = 1500 quote
  assert.equal(d.rewriteAmount, 1500);
});

test('(b) short quote + enough USDT → USDT, not BNB', () => {
  const d = chooseCurvePay({
    ...CRAB,
    payToken: 'BNB',
    payKey: 'BNB',
    sizeMode: 'abs',
    sizeAmount: 0.05,
    bnbUsd: 600,
    quoteBalance: 1,
    stableBalances: { USDT: 1000 },
  });
  assert.equal(d.action, 'use');
  assert.equal(d.path, 'stable-to-quote');
  assert.equal(d.payKey, 'USDT');
  assert.equal(d.payToken.toLowerCase(), USDT.toLowerCase());
  assert.notEqual(d.path, 'bnb');
  assert.equal(d.payToken === 'BNB', false);
  // 0.05 * 600 = $30 USDT
  assert.equal(d.rewriteAmount, 30);
  assert.equal(d.clearPayCa, false);
});

test('(c) short quote and short USDT → refuse, no BNB', () => {
  const d = chooseCurvePay({
    ...CRAB,
    payToken: 'BNB',
    payKey: 'BNB',
    sizeMode: 'abs',
    sizeAmount: 0.05,
    bnbUsd: 600,
    quoteBalance: 1,
    stableBalances: { USDT: 5, USDC: 0 },
  });
  assert.equal(d.action, 'refuse');
  assert.equal(d.path, 'refuse');
  assert.equal(d.switched, false);
  assert.match(d.error, /拒绝用 BNB/);
  assert.equal(d.payToken, undefined);
});

test('explicit USDT pay CA is kept when quote is short — never cleared, never switched to BNB', () => {
  const d = chooseCurvePay({
    ...CRAB,
    explicit: true,
    payToken: USDT,
    payKey: 'USDT',
    payLabel: 'USDT',
    sizeMode: 'abs',
    sizeAmount: 0.3,
    bnbUsd: 600,
    quoteBalance: 0,
    stableBalances: { USDT: 1000 },
  });
  assert.equal(d.action, 'use');
  assert.equal(d.path, 'stable-to-quote');
  assert.equal(d.keepExplicit, true);
  assert.equal(d.clearPayCa, false);
  assert.equal(d.switched, false);
  assert.equal(d.rewriteAmount, null);
  assert.equal(d.payToken.toLowerCase(), USDT.toLowerCase());
  assert.notEqual(d.payKey, 'BNB');
});

test('explicit USDT is kept even when quote balance would cover', () => {
  const d = chooseCurvePay({
    ...CRAB,
    explicit: true,
    payToken: USDT,
    payKey: 'custom',
    sizeMode: 'abs',
    sizeAmount: 40,
    bnbUsd: 600,
    quoteBalance: 999999,
    stableBalances: { USDT: 1000 },
  });
  assert.equal(d.path, 'stable-to-quote');
  assert.equal(d.keepExplicit, true);
  assert.equal(d.switched, false);
});

test('BNB quote still pays BNB when no stable was selected', () => {
  const d = chooseCurvePay({
    quoteSymbol: 'BNB',
    quoteAddress: null,
    payToken: 'BNB',
    payKey: 'BNB',
    sizeMode: 'abs',
    sizeAmount: 0.05,
    bnbUsd: 600,
    quoteBalance: 0,
    stableBalances: { USDT: 1000 },
  });
  assert.equal(d.action, 'use');
  assert.equal(d.path, 'bnb');
  assert.equal(d.payToken, 'BNB');
});

test('engine: USDT pay on oANTHROPIC curve is stable→quote, not ignored', () => {
  const d = decideEnginePay({
    payToken: USDT,
    quoteAddress: QUOTE,
    quoteSymbol: 'oANTHROPIC',
    platform: 'gang',
    graduated: false,
  });
  assert.equal(d.ok, true);
  assert.equal(d.path, 'stable-to-quote');
  assert.equal(d.nativeBnb, false);
});

test('engine: BNB pay on oANTHROPIC curve hard-fails', () => {
  const d = decideEnginePay({
    payToken: 'BNB',
    quoteAddress: QUOTE,
    quoteSymbol: 'oANTHROPIC',
    platform: 'gang',
    graduated: false,
  });
  assert.equal(d.ok, false);
  assert.equal(d.path, 'refuse');
  assert.equal(d.nativeBnb, false);
  assert.match(d.error, /拒绝用 BNB/);
});

test('engine: pay token equal to quote is quote-direct', () => {
  const d = decideEnginePay({
    payToken: QUOTE,
    quoteAddress: QUOTE,
    quoteSymbol: 'oANTHROPIC',
    platform: 'gang',
    graduated: false,
  });
  assert.equal(d.ok, true);
  assert.equal(d.path, 'quote-direct');
});

test('engine: BNB pay on a BNB quote is allowed', () => {
  const d = decideEnginePay({
    payToken: 'BNB',
    quoteAddress: ADDRESSES.WBNB,
    quoteSymbol: 'WBNB',
    platform: 'gang',
    graduated: false,
  });
  assert.equal(d.ok, true);
  assert.equal(d.path, 'bnb');
  assert.equal(d.nativeBnb, true);
});

test('USD guard rejects the 0.3 BNB → ~$1 quote burn', () => {
  const g = guardSwapUsd({ payAmount: 0.3, payUsd: 600, quoteOut: 50, quoteUsd: 0.02 });
  // spend $180, received $1
  assert.equal(g.ok, false);
  assert.ok(g.ratio < 0.5);
  assert.match(g.error, /拒绝广播/);
});

test('USD guard accepts a USDT hop that delivers at least half the spend', () => {
  const g = guardSwapUsd({ payAmount: 30, payUsd: 1, quoteOut: 1400, quoteUsd: 0.02 });
  // spend $30, received $28
  assert.equal(g.ok, true);
  assert.ok(g.ratio >= 0.5);
});

test('USD guard fails closed when price is missing', () => {
  const g = assertSpendReceivedUsd({ spendUsd: 30, receivedUsd: 0 });
  assert.equal(g.ok, false);
  assert.match(g.error, /Nothing was sent/);
});

test('server source does not ignore a non-BNB pay token', () => {
  const src = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /non-BNB payToken ignored/);
  assert.doesNotMatch(src, /aiwb spends BNB/);
});

test('frontend does not clear a typed #pay-ca or fall back to BNB', () => {
  const src = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(src, /chooseCurvePay/);
  assert.match(src, /explicitPayCaLocked/);
  assert.doesNotMatch(src, /已改用 BNB/);
  assert.doesNotMatch(src, /fall back to BNB/);
  const pref = src.slice(src.indexOf('function preferPayTokenForCard'), src.indexOf('function getBuySize'));
  assert.equal(pref.includes("payCa.value = ''"), false);
  const clearer = src.slice(src.indexOf('function clearAutoPayCa'), src.indexOf('function applyPayDecision'));
  assert.match(clearer, /dataset\.auto !== '1'/);
});
