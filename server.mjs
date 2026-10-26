#!/usr/bin/env node
/**
 * AI WALLET CURVE — local data board (FLAP agent / GANG / FOUR agent).
 * Listens on 127.0.0.1 only. Buy/sell via in-process aiwb engine (BOARD_KEY auth);
 * GANG Soft/U/S via official `gang` CLI. Falls back to `aiwb` CLI if engine fails to load.
 *
 * Windows proxy (required for Node fetch out):
 *   HTTP_PROXY=http://127.0.0.1:18081 HTTPS_PROXY=http://127.0.0.1:18081 NODE_USE_ENV_PROXY=1
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { loadAiwb } from './lib/aiwb.mjs';
import { createTradeEngine } from './lib/trade-engine.mjs';
import { fetchHoldings, HOLDINGS_TTL_MS } from './lib/holdings.mjs';
import { fetchGang } from './lib/gang.mjs';
import { fetchFlap } from './lib/flap.mjs';
import { fetchFour } from './lib/four.mjs';
import { fetchGmgnPads, mergeGmgnIntoPad, fetchKline, fetchHolders } from './lib/gmgn.mjs';
import { fetchGangKline } from './lib/official-kline.mjs';
import { resolvePad, usesGangCli, gangTrade, gangQuote, gangEnsureSellApprove, peekPadCache } from './lib/gang-cli.mjs';
import {
  decideEnginePay,
  sizePaySpend,
  stableByAddress,
  stableByKey,
  isBnbQuote,
  knownPayToken,
} from './lib/pay-path.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 3847);
const CACHE_MS = Number(process.env.CACHE_MS || 10_000);
const NEAR_MIN = Number(process.env.NEAR_MIN_PCT || 50);
const NEAR_MIN_MC = Number(process.env.NEAR_MIN_MC_USD || 10000);
const KEY = process.env.BOARD_KEY || randomBytes(16).toString('hex');
/** Fixed recipient for board transfers — never accept client-supplied address. */
const DEFAULT_MAIN_WALLET = ''; // set MAIN_WALLET env (address book recipient)
const NATIVE_BNB = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
function resolveMainWallet() {
  const raw = String(process.env.MAIN_WALLET || DEFAULT_MAIN_WALLET).trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(raw)) {
    console.warn('[board] MAIN_WALLET invalid, using default', raw.slice(0, 20));
    return DEFAULT_MAIN_WALLET;
  }
  return raw;
}
const MAIN_WALLET = resolveMainWallet();
const CHAIN_TIMEOUT_MS = Number(process.env.CHAIN_TIMEOUT_MS || 90_000);
const TRADE_TIMEOUT_MS = Number(process.env.TRADE_TIMEOUT_MS || 660_000);
const CHECK_TTL_MS = Number(process.env.CHECK_TTL_MS || 30 * 60 * 1000);
const BODY_LIMIT = 8 * 1024;

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

let aiwb = null;
let tradeEngine = null;
let holdingsCache = { at: 0, payload: null, building: null };
let rpc = null;
let loadPnlFn = null;
let cache = { at: 0, payload: null, building: null };
let rpcLatency = null;
let bnbUsd = null;

const execFileAsync = promisify(execFile);
let walletInfo = { status: 'UNKNOWN', address: null, agentId: null, handle: null, updatedAt: null };

/** @type {Map<string, { at: number, result: object }>} */
const checkCache = new Map();

/** Serialize trades so concurrent clicks don't smash baw/aiwb. */
let tradeTail = Promise.resolve();
function enqueueTrade(fn) {
  const run = tradeTail.then(() => fn(), () => fn());
  tradeTail = run.then(() => {}, () => {});
  return run;
}

function shortAddr(a) {
  if (!a || a.length < 12) return a || '';
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function isAddress(s) {
  return typeof s === 'string' && /^0x[a-fA-F0-9]{40}$/.test(s);
}

function parseJsonBlob(text) {
  const raw = String(text || '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`no json: ${raw.slice(0, 160)}`);
  return JSON.parse(raw.slice(start, end + 1));
}

async function bawJson(args, { timeoutMs = 25_000 } = {}) {
  let stdout = '';
  let stderr = '';
  try {
    const r = await execFileAsync('baw', ['--json', ...args], {
      windowsHide: true,
      timeout: timeoutMs,
      env: process.env,
      shell: true,
      maxBuffer: 2_000_000,
    });
    stdout = r.stdout || '';
    stderr = r.stderr || '';
  } catch (e) {
    stdout = e.stdout || '';
    stderr = e.stderr || '';
    try {
      return parseJsonBlob(String(stdout).trim() || String(stderr).trim());
    } catch {
      const msg = e.killed ? `baw timed out after ${timeoutMs}ms` : (e.message || 'baw failed');
      throw new Error(msg);
    }
  }
  const text = String(stdout || '').trim() || String(stderr || '').trim();
  return parseJsonBlob(text);
}

/**
 * Run `aiwb … --json`. Inherits process env (HTTP_PROXY etc).
 * Timeout generous — App confirm can take minutes.
 */
async function aiwbJson(args, { timeoutMs = TRADE_TIMEOUT_MS } = {}) {
  let stdout = '';
  let stderr = '';
  try {
    const r = await execFileAsync('aiwb', [...args, '--json'], {
      windowsHide: true,
      timeout: timeoutMs,
      env: process.env,
      shell: true,
      maxBuffer: 4_000_000,
    });
    stdout = r.stdout || '';
    stderr = r.stderr || '';
  } catch (e) {
    stdout = e.stdout || '';
    stderr = e.stderr || '';
    // Prefer JSON error body from aiwb over generic spawn message.
    try {
      const j = parseJsonBlob(String(stdout).trim() || String(stderr).trim());
      if (j && (j.error || j.verdict || j.hash || j.ok != null)) return j;
    } catch { /* fall through */ }
    const msg = e.killed ? `aiwb timed out after ${timeoutMs}ms` : (e.message || 'aiwb failed');
    throw new Error(msg);
  }
  const text = String(stdout || '').trim() || String(stderr || '').trim();
  return parseJsonBlob(text);
}

function checkPassed(result) {
  if (!result || typeof result !== 'object') return { ok: false, reason: 'empty check result' };
  if (result.error) return { ok: false, reason: String(result.error) };
  if (result.verdict === 'do-not-buy') {
    const blocks = (result.flags || []).filter(f => f.level === 'block').map(f => f.text);
    return { ok: false, reason: blocks[0] || 'check verdict: do-not-buy' };
  }
  // Honeypot / cannot-sell simulated → block even if verdict string is odd.
  const flags = result.flags || [];
  const block = flags.find(f => f.level === 'block');
  if (block) return { ok: false, reason: block.text || 'blocked by check' };
  if (result.roundTrip && result.roundTrip.sellOk === false) {
    return { ok: false, reason: result.roundTrip.reason || 'simulated sell failed' };
  }
  if (result.roundTrip && result.roundTrip.buyOk === false) {
    return { ok: false, reason: result.roundTrip.reason || 'simulated buy failed' };
  }
  return { ok: true };
}

async function ensureRpcAlive() {
  try {
    if (tradeEngine) {
      const ms = await tradeEngine.pingRpc();
      rpcLatency = ms;
      return ms;
    }
    if (rpc) {
      const t0 = Date.now();
      await rpc.blockNumber();
      rpcLatency = Date.now() - t0;
      return rpcLatency;
    }
  } catch (e) {
    throw new Error(`BSC RPC unreachable before trade: ${e.message}`);
  }
  return null;
}

async function ensureCheck(ca, { platformHint = null } = {}) {
  const key = ca.toLowerCase();
  const hit = checkCache.get(key);
  if (hit && Date.now() - hit.at < CHECK_TTL_MS) {
    return { check: hit.result, cached: true, pass: checkPassed(hit.result), info: hit.info || null };
  }
  await ensureRpcAlive();
  if (tradeEngine) {
    const { result, info } = await withTimeout(
      tradeEngine.runCheck(ca),
      Math.min(TRADE_TIMEOUT_MS, 120_000),
      'aiwb check',
    );
    const pass = checkPassed(result);
    if (pass.ok) checkCache.set(key, { at: Date.now(), result, info });
    else checkCache.delete(key);
    return { check: result, cached: false, pass, info };
  }
  const result = await aiwbJson(['check', ca], { timeoutMs: Math.min(TRADE_TIMEOUT_MS, 120_000) });
  const pass = checkPassed(result);
  if (pass.ok) checkCache.set(key, { at: Date.now(), result, info: null });
  else checkCache.delete(key);
  return { check: result, cached: false, pass, info: null };
}

async function refreshWallet() {
  const prev = walletInfo;
  try {
    // Sequential: parallel baw calls often timeout on Windows proxy.
    const st = await bawJson(['wallet', 'status']).catch(() => null);
    const addr = await bawJson(['wallet', 'address']).catch(() => null);
    const agent = await bawJson(['wallet', 'agent-id']).catch(() => null);
    const status = st?.data?.status || (addr?.success ? 'CONNECTED' : (prev.status || 'DISCONNECTED'));
    const list = addr?.data?.addresses || [];
    const bsc = list.find(x => String(x.binanceChainId) === '56' || /bsc/i.test(x.chainName || ''));
    const address = bsc?.address
      || list.find(x => /^0x/i.test(x.address || ''))?.address
      || prev.address
      || null;
    const agentId = agent?.data?.agentId || prev.agentId || null;
    const handle = agent?.data?.handle || prev.handle || null;
    const claimed = agent?.data?.claimed != null ? !!agent.data.claimed : !!prev.claimed;
    walletInfo = {
      status,
      address,
      short: shortAddr(address),
      agentId,
      handle,
      claimed,
      updatedAt: new Date().toISOString(),
      ...(addr?.success === false ? { addressError: addr?.error?.name || addr?.error || 'address_failed' } : {}),
    };
  } catch (e) {
    walletInfo = { ...prev, status: prev.address ? (prev.status || 'CONNECTED') : 'ERROR', error: e.message, updatedAt: new Date().toISOString() };
  }
  return walletInfo;
}

function keyOk(req, url) {
  const h = req.headers['x-board-key'] || '';
  const q = url.searchParams.get('k') || '';
  const got = h || q;
  if (!got || got.length !== KEY.length) return false;
  try {
    return timingSafeEqual(Buffer.from(got), Buffer.from(KEY));
  } catch {
    return false;
  }
}

function mergeColumns(parts, key) {
  const map = new Map();
  for (const p of parts) {
    for (const c of p[key] || []) {
      const id = `${c.platform}:${c.address}`;
      if (!map.has(id)) map.set(id, c);
    }
  }
  return [...map.values()];
}

async function pingRpc() {
  if (!rpc) return null;
  const t0 = Date.now();
  try {
    await rpc.blockNumber();
    rpcLatency = Date.now() - t0;
    return rpcLatency;
  } catch {
    rpcLatency = null;
    return null;
  }
}

async function fetchBnbUsd() {
  try {
    // soft track items often include bnbUsd; fallback CoinGecko-less: gang soft page
    const r = await fetch('https://gang.fun/api/tokens?sort=new&limit=1', { headers: { accept: 'application/json' } });
    if (!r.ok) return null;
    const j = await r.json();
    const v = j?.items?.[0]?.bnbUsd;
    if (v) bnbUsd = Number(v);
    return bnbUsd;
  } catch {
    return bnbUsd;
  }
}


/** Overlay gangPad/tradePath from resolvePad cache only — no N+1 RPC per card. */
function overlayGangPadsFromCache(board) {
  if (!board) return board;
  for (const col of ['new', 'near', 'graduated']) {
    const arr = board[col];
    if (!Array.isArray(arr)) continue;
    for (const c of arr) {
      if (String(c.platform || '').toLowerCase() !== 'gang') continue;
      const info = peekPadCache(c.address || c.tradeCa);
      if (!info?.pad) continue;
      const pad = String(info.pad).toLowerCase();
      c.gangPad = pad;
      if (info.graduated) {
        c.tradePath = 'aiwb';
        c.graduated = true;
      } else if (usesGangCli(pad)) {
        c.tradePath = 'gang-cli';
      } else {
        c.tradePath = 'aiwb';
      }
      if (c.extra && typeof c.extra === 'object') {
        c.extra = { ...c.extra, gangPad: c.gangPad, tradePath: c.tradePath };
      }
    }
  }
  return board;
}

async function buildBoard() {
  const errors = {};
  const empty = { new: [], near: [], graduated: [], total: 0 };

  const gangP = fetchGang({ nearMinPct: NEAR_MIN, nearMinMcUsd: NEAR_MIN_MC }).catch(e => {
    errors.gang = e.message;
    return { ...empty, error: e.message };
  });

  // Chain pads run sequentially to avoid eth_getLogs rate limits on free RPCs.
  // GMGN trenches run in parallel (FLAP/FOUR near+graduated MC backfill).
  let flap = { ...empty }, four = { ...empty };
  const gang = await gangP;
  const gmgnP = fetchGmgnPads({ nearMinPct: NEAR_MIN, nearMinMcUsd: NEAR_MIN_MC }).catch(e => {
    errors.gmgn = e.message;
    return { flap: { ...empty, error: e.message }, four: { ...empty, error: e.message }, error: e.message };
  });
  if (aiwb && rpc) {
    // Internal log deadlines inside fetchers; no outer Abort (would discard cached enrichments).
    four = await fetchFour(aiwb, rpc, { nearMinPct: NEAR_MIN, nearMinMcUsd: NEAR_MIN_MC }).catch(e => {
      errors.four = e.message;
      return { ...empty, error: e.message };
    });
    flap = await fetchFlap(aiwb, rpc, { nearMinPct: NEAR_MIN, nearMinMcUsd: NEAR_MIN_MC }).catch(e => {
      errors.flap = e.message;
      return { ...empty, error: e.message };
    });
  } else {
    errors.chain = 'aiwb/rpc unavailable — GANG only (GMGN may still fill FLAP/FOUR)';
  }
  const gmgn = await gmgnP;
  if (gmgn.error) errors.gmgn = gmgn.error;
  flap = mergeGmgnIntoPad(flap, gmgn.flap);
  four = mergeGmgnIntoPad(four, gmgn.four);
  await Promise.all([pingRpc(), fetchBnbUsd(), refreshWallet()]);

  const near = mergeColumns([gang, flap, four], 'near')
    .sort((a, b) => {
      // 市值高的在前；缺市值的靠后，再用进度兜底
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
  // Prefer near over new when the same CA qualifies for both
  const nearKeys = new Set(near.map(c => `${c.platform}:${(c.address || '').toLowerCase()}`));
  const newest = mergeColumns([gang, flap, four], 'new')
    .filter(c => !nearKeys.has(`${c.platform}:${(c.address || '').toLowerCase()}`))
    .sort((a, b) => {
      // prefer createdAt, else ageMin asc
      if (a.createdAt && b.createdAt) return b.createdAt - a.createdAt;
      return (a.ageMin ?? 1e9) - (b.ageMin ?? 1e9);
    });
  const graduated = mergeColumns([gang, flap, four], 'graduated')
    .sort((a, b) => {
      if (a.createdAt && b.createdAt) return b.createdAt - a.createdAt;
      return (a.ageMin ?? 1e9) - (b.ageMin ?? 1e9);
    });

  return {
    new: newest,
    near,
    graduated,
    updatedAt: new Date().toISOString(),
    platforms: ['flap', 'gang', 'four'],
    nearMinPct: NEAR_MIN,
    nearMinMcUsd: NEAR_MIN_MC,
    meta: {
      rpcLatencyMs: rpcLatency,
      bnbUsd,
      counts: {
        new: newest.length,
        near: near.length,
        graduated: graduated.length,
        byPlatform: {
          flap: { new: flap.new.length, near: flap.near.length, graduated: flap.graduated.length, total: flap.total },
          gang: { new: gang.new.length, near: gang.near.length, graduated: gang.graduated.length, total: gang.total },
          four: { new: four.new.length, near: four.near.length, graduated: four.graduated.length, total: four.total },
        },
      },
      errors,
      sources: { gang: 'https://gang.fun/api', flap: 'FLAP_AGENT RPC + GMGN trenches', four: 'FOUR_AGENT RPC + GMGN trenches', gmgn: 'https://openapi.gmgn.ai/v1/trenches' },
      note: 'FLAP/FOUR 列表=链上Agent发现∪GMGN trenches；FOUR 内盘仅 agent 标签(fourmeme_agent/four_xmode_agent/bn_fourmeme)，经典 fourmeme 内盘不展示；已开盘 fourmeme/openfour→pancake；交易走 aiwb；GANG Soft/U/S→gang CLI',
      softCurveHidden: gang.softCurveHidden || 0,
      nearGate: `市值≥$${NEAR_MIN_MC} 或 进度≥${NEAR_MIN}%`,
      wallet: walletInfo,
    },
  };
}

async function getBoard(force = false) {
  const now = Date.now();
  const fresh = cache.payload && now - cache.at < CACHE_MS;
  if (!force && fresh) return cache.payload;
  // Stale-while-revalidate: return last good board while a refresh runs.
  if (!force && cache.payload && cache.building) return cache.payload;
  if (cache.building) return cache.building;
  cache.building = buildBoard()
    .then(p => { cache = { at: Date.now(), payload: p, building: null }; return p; })
    .catch(e => {
      cache.building = null;
      if (cache.payload) return cache.payload; // keep serving stale on refresh failure
      throw e;
    });
  if (!force && cache.payload) {
    cache.building.catch(() => {});
    return cache.payload;
  }
  return cache.building;
}

function serveStatic(url, res) {
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  if (rel.includes('..')) { res.writeHead(400); res.end('bad path'); return; }
  if (rel === '/pay-path.js') {
    const file = path.join(__dirname, 'lib', 'pay-path.mjs');
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
    return;
  }
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); res.end('not found'); return;
  }
  const ext = path.extname(file);
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

async function readJsonBody(req, limit = BODY_LIMIT) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const err = new Error('body too large');
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const err = new Error('invalid JSON body');
    err.status = 400;
    throw err;
  }
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function validateAmount(side, amount) {
  if (amount == null || amount === '') return { ok: false, error: 'amount required' };
  const s = String(amount).trim();
  if (side === 'buy') {
    // Percent of market-cap / supply target → converted to BNB spend later
    if (/^\d+(\.\d+)?%$/.test(s)) {
      const pct = Number(s.slice(0, -1));
      if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
        return { ok: false, error: 'buy % must be in (0, 100]' };
      }
      return { ok: true, mode: 'pct', pct, amount: s };
    }
    // Escape hatch: plain number = absolute BNB spend
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) {
      return { ok: false, error: 'buy amount must be a % (e.g. 0.5%) or a finite BNB number > 0' };
    }
    return { ok: true, mode: 'bnb', amount: String(s) };
  }
  // sell: "25%" | "50%" | "100%" | raw token amount
  if (/^\d+(\.\d+)?%$/.test(s)) {
    const pct = Number(s.slice(0, -1));
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return { ok: false, error: 'sell % must be in (0, 100]' };
    return { ok: true, amount: s };
  }
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, error: 'sell amount must be % or a positive token amount' };
  return { ok: true, amount: s };
}

/** Convert buy size % of MC into BNB spend for `aiwb buy CA <BNB>`. */
function lookupBoardMcUsd(ca) {
  const want = String(ca || '').toLowerCase();
  if (!want || !cache?.payload) return null;
  const lists = [cache.payload.new, cache.payload.near, cache.payload.graduated];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const c of list) {
      const a = String(c?.ca || c?.tradeCa || '').toLowerCase();
      if (a === want) {
        const mc = Number(c?.mcUsd ?? c?.fdvUsd);
        if (Number.isFinite(mc) && mc > 0) return mc;
      }
    }
  }
  return null;
}

function pctToBnbSpend(pct, bodyMcUsd, bodyBnbUsd) {
  const mc = Number(bodyMcUsd);
  const px = Number(bodyBnbUsd != null && bodyBnbUsd !== '' ? bodyBnbUsd : bnbUsd);
  if (!Number.isFinite(mc) || mc <= 0) {
    return {
      ok: false,
      error: 'buy % needs mcUsd (from card) or use absolute BNB amount (plain number)',
    };
  }
  if (!Number.isFinite(px) || px <= 0) {
    return {
      ok: false,
      error: 'buy % needs bnbUsd (board meta / server) or use absolute BNB amount',
    };
  }
  let bnb = (pct / 100) * mc / px;
  if (!Number.isFinite(bnb) || bnb <= 0) {
    return { ok: false, error: 'estimated BNB spend is not positive' };
  }
  // Clamp to (0, 50]
  if (bnb > 50) bnb = 50;
  // ~6 decimal places, strip trailing zeros
  const rounded = Number(bnb.toFixed(6));
  if (!(rounded > 0)) {
    return { ok: false, error: 'estimated BNB spend rounds to 0 — try a larger %' };
  }
  return { ok: true, bnb: String(rounded), mcUsd: mc, bnbUsd: px };
}

function normalizePayToken(raw) {
  if (raw == null || raw === '') return { token: 'BNB', isNative: true, key: 'BNB' };
  const known = knownPayToken(raw);
  if (known) {
    return { token: known.token, isNative: known.token === 'BNB', key: known.key };
  }
  const s = String(raw).trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(s)) {
    return { token: s, isNative: false, key: 'custom' };
  }
  return { token: s, isNative: false, key: s };
}

function lookupBoardCoin(ca) {
  const want = String(ca || '').toLowerCase();
  if (!want || !cache?.payload) return null;
  const lists = [cache.payload.new, cache.payload.near, cache.payload.graduated];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const c of list) {
      const a = String(c?.address || c?.ca || c?.tradeCa || '').toLowerCase();
      const t = String(c?.tradeCa || '').toLowerCase();
      if (a === want || t === want) return c;
    }
  }
  return null;
}

function resolvePayUsd(pay, body) {
  const fromBody = Number(body?.payUsd);
  if (fromBody > 0) return fromBody;
  const stable = stableByAddress(pay?.token) || stableByKey(pay?.key) || stableByKey(pay?.token);
  if (stable) return stable.usd;
  if (pay?.isNative) {
    const px = Number(body?.bnbUsd != null && body.bnbUsd !== '' ? body.bnbUsd : bnbUsd);
    if (px > 0) return px;
  }
  return null;
}

function resolveQuoteUsd(body, ca) {
  const coin = lookupBoardCoin(ca);
  const fromCard = Number(coin?.quoteUsd ?? coin?.extra?.quoteUsd);
  const fromBody = Number(body?.quoteUsd);
  if (fromCard > 0 && fromBody > 0) {
    const ratio = fromBody / fromCard;
    if (ratio < 0.5 || ratio > 2) return fromCard;
    return fromBody;
  }
  if (fromCard > 0) return fromCard;
  if (fromBody > 0) return fromBody;
  const sym = String(body?.quoteSymbol || coin?.quote || '');
  const addr = body?.quoteAddress || coin?.extra?.quoteAddress || coin?.quoteAddress || null;
  if (isBnbQuote(sym, addr)) {
    const px = Number(body?.bnbUsd != null && body.bnbUsd !== '' ? body.bnbUsd : bnbUsd);
    if (px > 0) return px;
  }
  if (stableByAddress(addr) || stableByKey(sym)) return 1;
  return null;
}

function coinQuoteAddress(body, ca) {
  const coin = lookupBoardCoin(ca);
  return body?.quoteAddress || coin?.extra?.quoteAddress || coin?.quoteAddress || null;
}

function coinQuoteSymbol(body, ca) {
  const coin = lookupBoardCoin(ca);
  return body?.quoteSymbol || coin?.quote || null;
}

function clarifyTradeError(err, { platform, track, pad } = {}) {
  const msg = String(err || '');
  // GANG 1% wallet cap (selector 0x1f2a2005 / myRoomTokens=0)
  if (
    /0x1f2a2005/i.test(msg)
    || /myRoomTokens\s*[:=]\s*0\b/i.test(msg)
    || /wallet\s*cap|1%\s*(wallet|cap|上限)|room\s*tokens?\s*(is|=|:)\s*0/i.test(msg)
    || /exceeded?\s*(the\s*)?(max|maximum)?\s*(wallet|holding|1%)/i.test(msg)
    || /已达.*1%|钱包上限/i.test(msg)
  ) {
    return '已达该币 1% 钱包上限，曲线打满前不能再买';
  }
  if (/rate limit|all RPC nodes failed|publicnode|dataseed/i.test(msg)) {
    return `${msg} — BSC RPC 限流；请 aiwb config set rpc 换节点，或设 BSC_RPC`;
  }
  if (/Could not find where this coin trades/i.test(msg)) {
    if (platform === 'flap') {
      return `${msg} — Flap: sell with market CA (tradeCa), not predicted token; try aiwb info <market>`;
    }
    if (platform === 'four') {
      return `${msg} — classic fourmeme 内盘 aiwb 不支持（仅 Agent 模板）；已开盘应走 pancake。run aiwb info <ca>`;
    }
    const padL = String(pad || '').toLowerCase();
    const tr = String(track || '').toLowerCase();
    // Only Soft/U/S archive hint when pad/track actually says archive — not every gang miss
    if (usesGangCli(padL) || tr === 'soft') {
      return `${msg} — aiwb V2 miss; board should route Soft/U/S via gang CLI. Retry or: gang token --token <ca>`;
    }
    if (platform === 'gang') {
      return `${msg} — GANG aiwb 未找到交易池（pad=${padL || '?'}）；非 Soft/U/S 或已毕业应走 pancake`;
    }
    return `${msg} — soft/non-agent curve or RPC miss; run aiwb info <ca>`;
  }
  return msg;
}

async function handleCheck(ca) {
  if (!isAddress(ca)) {
    return { status: 400, body: { ok: false, error: 'invalid ca' } };
  }
  const t0 = Date.now();
  try {
    const { check, cached, pass } = await ensureCheck(ca);
    return {
      status: pass.ok ? 200 : 400,
      body: {
        ok: pass.ok,
        ca,
        cached,
        check,
        reason: pass.ok ? undefined : pass.reason,
        tookMs: Date.now() - t0,
      },
    };
  } catch (e) {
    return {
      status: 500,
      body: { ok: false, ca, error: clarifyTradeError(e.message), tookMs: Date.now() - t0 },
    };
  }
}


/**
 * Detect pad for a GANG CA and decide trade path.
 * ALWAYS resolvePad on-chain first — board gangPad=v2 from /stocks/tokens often
 * mislabels Soft/U/S (LaunchpadU/S). Never trust board hint alone when chain says otherwise.
 */
async function resolveGangRoute({ ca, platform, track, gangPadHint, tradePathHint, graduated }) {
  const plat = String(platform || '').toLowerCase();
  const tr = String(track || '').toLowerCase();
  const hintPad = gangPadHint ? String(gangPadHint).toLowerCase() : null;
  const hintPath = tradePathHint ? String(tradePathHint).toLowerCase() : null;

  let pad = null;
  try {
    const info = await resolvePad(ca);
    pad = info?.pad ? String(info.pad).toLowerCase() : null;
    if (info?.graduated) {
      return { pad, tradePath: 'aiwb', graduated: true, reason: 'graduated→aiwb/pancake', source: 'resolvePad' };
    }
    if (usesGangCli(pad)) {
      return { pad, tradePath: 'gang-cli', graduated: false, source: 'resolvePad' };
    }
    // True V2 / non-archive on-chain
    return {
      pad: pad || (plat === 'gang' ? 'v2' : null),
      tradePath: 'aiwb',
      graduated: false,
      source: 'resolvePad',
    };
  } catch (e) {
    const err = e.message || String(e);
    // Fall back to hint/track: soft|u|s / gang-cli → CLI; v2 → aiwb
    if (usesGangCli(hintPad) || tr === 'soft' || hintPath === 'gang-cli') {
      return {
        pad: hintPad || (tr === 'soft' ? 'soft' : 'unknown'),
        tradePath: 'gang-cli',
        graduated: !!graduated,
        error: err,
        reason: 'resolvePad failed → hint/track gang-cli',
      };
    }
    pad = hintPad || (tr === 'v2' ? 'v2' : (plat === 'gang' ? 'v2' : null));
    return {
      pad,
      tradePath: hintPath || 'aiwb',
      graduated: !!graduated,
      error: err,
      reason: 'resolvePad failed → hint/track aiwb',
    };
  }
}


/** After a live buy succeeds: open sell authorization so the next sell skips approve. */
async function postBuyEnsureSellApprove(ca, { tradePath, platform, info } = {}) {
  const t0 = Date.now();
  try {
    if (tradePath === 'gang-cli') {
      return await withTimeout(gangEnsureSellApprove(ca), Math.min(TRADE_TIMEOUT_MS, 300_000), 'sell-approve');
    }
    if (tradeEngine?.runEnsureSellApprove) {
      return await withTimeout(
        tradeEngine.runEnsureSellApprove(ca, { platformHint: platform, info: info || null }),
        Math.min(TRADE_TIMEOUT_MS, 180_000),
        'sell-approve',
      );
    }
    return { ok: true, skipped: true, reason: 'no sell-approve path', tookMs: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: e.message || String(e), tookMs: Date.now() - t0 };
  }
}

async function handleGangCliTrade({ side, ca, amt, bnbSpend, convertMeta, pay, dry, platform, track, pad, t0 }) {
  // Buy safety: aiwb check fails on non-V2 — use gang quote as gate (or skip when quote works).
  let check = null;
  let checkMs = null;
  let quoteGate = null;
  if (side === 'buy') {
    const qT0 = Date.now();
    try {
      quoteGate = await gangQuote(ca, bnbSpend);
      checkMs = Date.now() - qT0;
      if (!quoteGate?.success) {
        return {
          status: 400,
          body: {
            ok: false, side, ca, platform, track, pad, tradePath: 'gang-cli',
            amount: amt.amount, bnbSpend, convert: convertMeta, payToken: pay?.token,
            quoteGate, checkMs,
            error: String(quoteGate?.error || 'gang quote failed — buy blocked'),
            note: 'Safety gate for Soft/U/S = gang quote (aiwb check skipped: LaunchpadV2-only)',
            tookMs: Date.now() - t0,
          },
        };
      }
      check = {
        verdict: 'gang-quote-ok',
        gate: 'gang-quote',
        pad: quoteGate.pad || pad,
        tokensOut: quoteGate.tokensOut,
        spent: quoteGate.spent,
        fee: quoteGate.fee,
        refund: quoteGate.refund,
      };
    } catch (e) {
      return {
        status: 400,
        body: {
          ok: false, side, ca, platform, track, pad, tradePath: 'gang-cli',
          amount: amt.amount, bnbSpend, error: `gang quote gate: ${e.message}`,
          note: 'Safety gate for Soft/U/S = gang quote (aiwb check skipped)',
          tookMs: Date.now() - t0,
        },
      };
    }
  }

  const tradeAmt = side === 'buy' ? bnbSpend : amt.amount;
  const result = await withTimeout(
    gangTrade({
      side,
      token: ca,
      bnb: side === 'buy' ? bnbSpend : undefined,
      amount: side === 'sell' ? amt.amount : undefined,
      dry,
    }),
    TRADE_TIMEOUT_MS,
    `gang ${side}`,
  );

  const noteParts = [
    `tradePath=gang-cli pad=${result.pad || pad || '?'}`,
    side === 'buy' ? 'check=gang-quote (aiwb skipped)' : null,
    dry ? 'dry preview — not executed' : null,
    result.needsAppConfirm ? 'NeedConfirmation — confirm in Binance App' : null,
  ].filter(Boolean);

  if (!result.ok) {
    return {
      status: 400,
      body: {
        ok: false, side, ca, platform, track, pad: result.pad || pad,
        tradePath: 'gang-cli', check, quoteGate, result, checkMs,
        ...(side === 'buy' ? { payToken: pay?.token, amount: amt.amount, bnbSpend, convert: convertMeta } : { amount: amt.amount }),
        error: clarifyTradeError(result.error || 'gang trade failed', { platform, track, pad }),
        note: noteParts.join(' · '),
        tookMs: Date.now() - t0,
      },
    };
  }

  let sellApprove = null;
  if (
    side === 'buy'
    && !dry
    && result.executed
    && !result.needsAppConfirm
    && !result.pendingConfirmation
  ) {
    sellApprove = await postBuyEnsureSellApprove(ca, { tradePath: 'gang-cli', platform });
    if (sellApprove?.needsAppConfirm) noteParts.push('sell-approve 待 App 确认');
    else if (sellApprove?.approved) noteParts.push('已开卖出授权');
    else if (sellApprove?.skipped) noteParts.push(`卖出授权跳过(${sellApprove.reason || 'ok'})`);
    else if (sellApprove && sellApprove.ok === false) noteParts.push(`卖出授权失败: ${sellApprove.error || '?'}`);
  }

  return {
    status: 200,
    body: {
      ok: true, side, ca, platform, track, pad: result.pad || pad,
      tradePath: 'gang-cli', check, quoteGate, result, checkMs,
      needsAppConfirm: !!result.needsAppConfirm,
      pendingConfirmation: !!result.pendingConfirmation,
      dry: !!dry,
      sellApprove,
      ...(side === 'buy' ? { payToken: pay?.token, amount: amt.amount, bnbSpend, convert: convertMeta } : { amount: amt.amount }),
      note: noteParts.join(' · '),
      tookMs: Date.now() - t0,
    },
  };
}

async function handleTrade(body) {
  const side = String(body?.side || '').toLowerCase();
  // Prefer explicit tradeCa (Flap market); fall back to display ca.
  const ca = String(body?.tradeCa || body?.ca || '').trim();
  const platform = body?.platform ? String(body.platform).toLowerCase() : null;
  const track = body?.track != null ? String(body.track).toLowerCase() : null;
  const dry = !!body?.dry;
  if (side !== 'buy' && side !== 'sell') {
    return { status: 400, body: { ok: false, error: 'side must be buy|sell' } };
  }
  if (!isAddress(ca)) {
    return { status: 400, body: { ok: false, error: 'invalid ca' } };
  }
  const graduated = body?.graduated === true || body?.graduated === 'true';
  const amt = validateAmount(side, body?.amount);
  if (!amt.ok) return { status: 400, body: { ok: false, error: amt.error } };

  const pay = side === 'buy' ? normalizePayToken(body?.payToken) : null;

  let bnbSpend = null;
  let paySpend = null;
  let convertMeta = null;
  if (side === 'buy') {
    const payUsdEarly = resolvePayUsd(pay, body);
    const quoteUsdEarly = resolveQuoteUsd(body, ca);
    if (!pay.isNative) {
      // Amount is in the pay token (USDT, quote, …). Never clamp it as if it were BNB.
      const mc = Number(body?.mcUsd) > 0 ? Number(body.mcUsd) : lookupBoardMcUsd(ca);
      const stable = stableByAddress(pay.token) || stableByKey(pay.key);
      const sized = sizePaySpend({
        mode: amt.mode === 'pct' ? 'pct' : 'abs',
        pct: amt.pct,
        absAmount: amt.amount,
        mcUsd: mc,
        payUsd: payUsdEarly,
        maxAmount: stable ? 10_000 : null,
      });
      if (!sized.ok) {
        return {
          status: 400,
          body: { ok: false, error: sized.error, payToken: pay.token, amount: amt.amount },
        };
      }
      paySpend = sized.amount;
      convertMeta = {
        mode: amt.mode === 'pct' ? 'pct-pay' : 'pay-token',
        payToken: pay.token,
        paySpend,
        payUsd: sized.payUsd,
        spendUsd: sized.spendUsd,
        quoteUsd: quoteUsdEarly,
      };
    } else if (amt.mode === 'pct') {
      const conv = pctToBnbSpend(amt.pct, body?.mcUsd, body?.bnbUsd);
      if (!conv.ok) return { status: 400, body: { ok: false, error: conv.error, amount: amt.amount } };
      bnbSpend = conv.bnb;
      paySpend = conv.bnb;
      convertMeta = { mode: 'pct', pct: amt.pct, mcUsd: conv.mcUsd, bnbUsd: conv.bnbUsd };
    } else {
      // Absolute BNB; still clamp to (0, 50]. Used only when the curve quote is BNB.
      let n = Number(amt.amount);
      if (n > 50) n = 50;
      bnbSpend = String(Number(n.toFixed(6)));
      paySpend = bnbSpend;
      convertMeta = { mode: 'bnb' };
    }
  }

  const gangPadHint = body?.gangPad ? String(body.gangPad).toLowerCase() : null;
  const tradePathHint = body?.tradePath ? String(body.tradePath).toLowerCase() : null;

  return enqueueTrade(async () => {
    const t0 = Date.now();
    let check = null;
    // Hoisted: catch references padForErr; const-in-try is TDZ there.
    let padForErr = gangPadHint || null;
    try {
      // GANG Soft / LaunchpadU / LaunchpadS → official gang CLI
      let route = null;
      if (platform === 'gang' || track === 'soft' || gangPadHint || tradePathHint === 'gang-cli') {
        route = await resolveGangRoute({
          ca, platform, track, gangPadHint, tradePathHint, graduated,
        });
      }
      padForErr = route?.pad || gangPadHint || null;
      if (route?.tradePath === 'gang-cli') {
        if (side === 'buy' && pay && !pay.isNative) {
          const qAddr = coinQuoteAddress(body, ca);
          const isQuote = qAddr && String(pay.token).toLowerCase() === String(qAddr).toLowerCase();
          if (!isQuote) {
            return {
              status: 400,
              body: {
                ok: false, side, ca, platform, track, pad: route.pad, tradePath: 'gang-cli',
                payToken: pay.token, amount: amt.amount,
                error: '这笔支付币不是曲线报价币。Soft/U/S 的 gang CLI 不会做 USDT→报价币，也拒绝改花 BNB。Nothing was sent.',
                tookMs: Date.now() - t0,
              },
            };
          }
          // Official CLI `--bnb` on U/S/V2 is the quote amount.
          bnbSpend = paySpend;
          convertMeta = { ...(convertMeta || {}), mode: 'quote-cli', paySpend };
        }
        return await handleGangCliTrade({
          side, ca, amt, bnbSpend, convertMeta, pay, dry, platform, track,
          pad: route.pad, t0,
        });
      }

      if (side === 'buy') {
        const quoteSymbol = coinQuoteSymbol(body, ca);
        const quoteAddress = coinQuoteAddress(body, ca);
        const quoteUsdResolved = resolveQuoteUsd(body, ca);
        const payUsdResolved = resolvePayUsd(pay, body);
        const graduatedTrade = graduated || !!route?.graduated;
        const spendAmount = paySpend;
        const buyOpts = {
          platformHint: platform,
          graduated: graduatedTrade,
          payToken: pay.token,
          quoteUsd: quoteUsdResolved,
          payUsd: payUsdResolved,
        };

        // No in-process engine: aiwb CLI always sizes in BNB. Refuse anything else.
        if (!tradeEngine) {
          const hinted = decideEnginePay({
            payToken: pay.token,
            quoteAddress,
            quoteSymbol,
            platform: platform || (quoteSymbol && !isBnbQuote(quoteSymbol, quoteAddress) ? 'gang' : platform),
            graduated: graduatedTrade,
          });
          if (!hinted.ok || hinted.path !== 'bnb') {
            return {
              status: 400,
              body: {
                ok: false, side, ca, payToken: pay.token, amount: amt.amount, paySpend: spendAmount,
                error: hinted.error || '进程内交易引擎不可用。拒绝用 aiwb CLI 花 BNB。Nothing was sent.',
                payPath: 'refuse',
                platform, track, tookMs: Date.now() - t0,
              },
            };
          }
        }

        let ensured = { check: null, cached: false, pass: { ok: true }, info: null };
        let checkMs = 0;
        const checkT0 = Date.now();
        let preview = null;
        let payPath = pay.isNative ? 'bnb' : null;

        if (tradeEngine) {
          try {
            preview = await withTimeout(
              tradeEngine.runBuy(ca, spendAmount, { ...buyOpts, dryRun: true }),
              Math.min(TRADE_TIMEOUT_MS, 120_000),
              'pay-path check',
            );
            checkMs = Date.now() - checkT0;
          } catch (e) {
            return {
              status: 400,
              body: {
                ok: false, side, ca, payToken: pay.token, amount: amt.amount, paySpend: spendAmount,
                quoteSymbol, quoteAddress, quoteUsd: quoteUsdResolved,
                error: clarifyTradeError(e.message || 'pay-path check failed', { platform, track, pad: padForErr }),
                platform, track, payPath: 'refuse', tookMs: Date.now() - t0,
              },
            };
          }
          if (preview?.error) {
            return {
              status: 400,
              body: {
                ok: false, side, ca, check: preview, payToken: pay.token, amount: amt.amount,
                paySpend: spendAmount,
                error: clarifyTradeError(preview.error, { platform, track, pad: padForErr }),
                platform, track, payPath: 'refuse', tookMs: Date.now() - t0,
              },
            };
          }
          payPath = preview?.payPath || null;
          if (!payPath || (!pay.isNative && payPath === 'bnb')) {
            return {
              status: 400,
              body: {
                ok: false, side, ca, payToken: pay.token, amount: amt.amount, paySpend: spendAmount,
                error: '支付币没有按原样执行（引擎仍会花 BNB）。已中止。Nothing was sent.',
                platform, track, payPath: 'refuse', tookMs: Date.now() - t0,
              },
            };
          }
          if (payPath === 'bnb') {
            ensured = await ensureCheck(ca, { platformHint: platform });
            check = ensured.check;
            checkMs = Date.now() - checkT0;
            if (!ensured.pass.ok) {
              return {
                status: 400,
                body: {
                  ok: false, side, ca, check, payToken: pay.token, amount: amt.amount, bnbSpend,
                  error: clarifyTradeError(ensured.pass.reason || 'check failed', { platform, track, pad: padForErr }),
                  platform, track, checkMs, cachedCheck: ensured.cached, payPath, tookMs: Date.now() - t0,
                },
              };
            }
          } else {
            check = {
              verdict: 'pay-path-sim-ok',
              gate: 'dry-run',
              payPath,
              via: preview?.via || preview?.plan?.via,
              steps: preview?.plan?.steps || null,
              noBnbHop: preview?.payPath !== 'bnb',
              spendUsd: preview?.plan?.spendUsd ?? preview?.spendUsd ?? null,
              receivedUsd: preview?.plan?.receivedUsd ?? preview?.receivedUsd ?? null,
              receivedRatio: preview?.plan?.receivedRatio ?? null,
            };
          }
        }

        const noteParts = [];
        if (payPath === 'quote-direct') noteParts.push('pay=quote-direct (wallet quote → launchpad, no BNB hop)');
        else if (payPath === 'stable-to-quote') noteParts.push(`pay=${preview?.paySymbol || preview?.plan?.paySymbol || pay.key || 'USDT'}→quote (no BNB)`);
        else if (payPath === 'pay-to-quote') noteParts.push('pay=erc20→quote (no BNB hop)');
        else noteParts.push('pay=BNB (quote is BNB)');
        if (ensured.cached) noteParts.push('check cache hit — skipped re-audit');
        if (ensured.info?.handler) noteParts.push('reuse detect info');
        noteParts.push(tradeEngine ? 'in-process engine' : 'aiwb CLI');
        let note = noteParts.join(' · ');

        let result = preview;
        const buyT0 = Date.now();
        if (tradeEngine) {
          if (!dry) {
            result = await withTimeout(
              tradeEngine.runBuy(ca, spendAmount, { ...buyOpts, dryRun: false, info: ensured.info }),
              TRADE_TIMEOUT_MS,
              'aiwb buy',
            );
          }
        } else {
          const args = ['buy', ca, bnbSpend];
          if (dry) args.push('--dry');
          result = await aiwbJson(args);
        }
        const buyMs = Date.now() - buyT0;
        const livePath = result?.payPath || payPath;
        if (livePath === 'bnb' && !pay.isNative) {
          return {
            status: 400,
            body: {
              ok: false, side, ca, check, result, payToken: pay.token, amount: amt.amount,
              error: '广播前发现仍会花 BNB，已中止。Nothing was sent.',
              platform, track, payPath: 'refuse', tookMs: Date.now() - t0,
            },
          };
        }
        if (result?.error) {
          return {
            status: 400,
            body: {
              ok: false, side, ca, check, result,
              payToken: pay.token, amount: amt.amount,
              bnbSpend: livePath === 'bnb' ? bnbSpend : null,
              paySpend: spendAmount, convert: convertMeta, note,
              error: clarifyTradeError(result.error, { platform, track, pad: padForErr }),
              platform, track, pad: padForErr, checkMs, buyMs, cachedCheck: ensured.cached,
              payPath: livePath, tookMs: Date.now() - t0,
            },
          };
        }
        let sellApprove = null;
        const buyDone = !dry && !result?.dryRun && !result?.error;
        if (buyDone) {
          sellApprove = await postBuyEnsureSellApprove(ca, {
            tradePath: 'aiwb',
            platform,
            info: ensured.info || null,
          });
          const noteExtra = [];
          if (sellApprove?.needsAppConfirm) noteExtra.push('sell-approve 待 App 确认');
          else if (sellApprove?.approved) noteExtra.push('已开卖出授权');
          else if (sellApprove?.skipped) noteExtra.push(`卖出授权跳过(${sellApprove.reason || 'ok'})`);
          else if (sellApprove && sellApprove.ok === false) noteExtra.push(`卖出授权失败: ${sellApprove.error || '?'}`);
          if (noteExtra.length) note = [note, ...noteExtra].filter(Boolean).join(' · ');
        }
        return {
          status: 200,
          body: {
            ok: true, side, ca, check, result,
            payToken: pay.token, amount: amt.amount,
            bnbSpend: livePath === 'bnb' ? bnbSpend : null,
            paySpend: spendAmount,
            convert: convertMeta, note,
            payPath: livePath,
            quoteSpend: livePath === 'quote-direct' ? spendAmount : (result?.spendQuote || result?.plan?.expectedQuote || null),
            sellApprove,
            platform, track, checkMs, buyMs, cachedCheck: ensured.cached, tookMs: Date.now() - t0,
          },
        };
      }

      // sell — no check gate (user already holds); still require explicit amount
      await ensureRpcAlive();
      let result;
      if (tradeEngine) {
        result = await withTimeout(
          tradeEngine.runSell(ca, amt.amount, { dryRun: dry, platformHint: platform, graduated }),
          TRADE_TIMEOUT_MS,
          'aiwb sell',
        );
      } else {
        const args = ['sell', ca, amt.amount];
        if (dry) args.push('--dry');
        result = await aiwbJson(args);
      }
      if (result?.error) {
        return {
          status: 400,
          body: {
            ok: false, side, ca, check: null, result, platform, track,
            error: clarifyTradeError(result.error, { platform, track, pad: padForErr }),
            tookMs: Date.now() - t0,
          },
        };
      }
      return {
        status: 200,
        body: { ok: true, side, ca, check: null, result, platform, track, tookMs: Date.now() - t0 },
      };
    } catch (e) {
      return {
        status: 500,
        body: {
          ok: false, side, ca, check, platform, track,
          error: clarifyTradeError(e.message, { platform, track, pad: padForErr }),
          ...(side === 'buy' ? { payToken: pay?.token, amount: amt.amount, bnbSpend, convert: convertMeta } : {}),
          tookMs: Date.now() - t0,
        },
      };
    }
  });
}


function formatSendAmount(n) {
  if (!Number.isFinite(n) || n <= 0) return null;
  // Human units for baw --amount; avoid scientific notation.
  let s;
  if (n >= 1e6) s = n.toFixed(2);
  else if (n >= 1) s = n.toFixed(6);
  else if (n >= 1e-6) s = n.toFixed(8);
  else s = n.toFixed(12);
  s = s.replace(/\.?0+$/, '');
  return s || null;
}

function isNativeTokenCa(ca) {
  const a = String(ca || '').trim();
  if (!a) return false;
  if (/^BNB$/i.test(a)) return true;
  return a.toLowerCase() === NATIVE_BNB.toLowerCase();
}

function addressBookErrorZh(raw) {
  const s = String(raw || '');
  if (/address\s*book|地址簿|not\s+in\s+(the\s+)?address|recipient.*(not|invalid|unknown)|地址.*不在/i.test(s)) {
    return `主钱包不在币安 App 地址簿，请先在 App→钱包→设置→地址簿添加 ${shortAddr(MAIN_WALLET)}`;
  }
  return null;
}

/**
 * Manual transfer AI wallet → MAIN_WALLET only.
 * Body: { ca|tradeCa, amount?, percent?, max? }
 * Ignores any client-supplied recipient.
 */
async function handleTransfer(body) {
  const t0 = Date.now();
  const caRaw = String(body?.ca || body?.tradeCa || '').trim();
  if (!isAddress(caRaw)) {
    return { status: 400, body: { ok: false, error: 'ca required (ERC20 0x…)', tookMs: Date.now() - t0 } };
  }
  if (isNativeTokenCa(caRaw)) {
    return {
      status: 400,
      body: {
        ok: false,
        ca: caRaw,
        recipient: MAIN_WALLET,
        error: '暂不支持转原生 BNB，请只转 ERC20 持仓',
        tookMs: Date.now() - t0,
      },
    };
  }
  const ca = caRaw; // keep client checksum if valid hex

  const wantMax = body?.max === true || body?.max === 'true' || body?.max === 1;
  let percent = null;
  if (body?.percent != null && body?.percent !== '') {
    const p = Number(body.percent);
    if (!Number.isFinite(p) || !(p > 0) || p > 100) {
      return { status: 400, body: { ok: false, ca, recipient: MAIN_WALLET, error: 'percent 须在 (0,100]', tookMs: Date.now() - t0 } };
    }
    percent = p;
  }
  let amountIn = null;
  if (body?.amount != null && body?.amount !== '' && !wantMax && percent == null) {
    const a = String(body.amount).trim();
    if (!a || !/^\d+(\.\d+)?$/.test(a) || !(Number(a) > 0)) {
      return { status: 400, body: { ok: false, ca, recipient: MAIN_WALLET, error: 'amount 须为正数', tookMs: Date.now() - t0 } };
    }
    amountIn = a;
  }
  if (!wantMax && percent == null && amountIn == null) {
    return {
      status: 400,
      body: {
        ok: false, ca, recipient: MAIN_WALLET,
        error: '请提供 max:true 或 percent(0,100] 或 amount',
        tookMs: Date.now() - t0,
      },
    };
  }

  // Prefer percent → resolve from holdings; 100% or max → baw --max
  let useMax = wantMax || (percent != null && percent >= 100);
  let sendAmount = amountIn;
  let resolvedPercent = percent;

  if (!useMax && percent != null) {
    let bal = null;
    try {
      const h = await getHoldings(false);
      const addr = ca.toLowerCase();
      const it = (h?.items || []).find(x => {
        const a = String(x.address || '').toLowerCase();
        const t = String(x.tradeCa || '').toLowerCase();
        return (a && a === addr) || (t && t === addr);
      });
      if (it && it.unit === 'shares') {
        return {
          status: 400,
          body: {
            ok: false, ca, recipient: MAIN_WALLET, percent,
            error: '曲线份额（shares）不能直接转账，请先卖出或等毕业成 ERC20',
            tookMs: Date.now() - t0,
          },
        };
      }
      if (it && Number(it.amount) > 0) bal = Number(it.amount);
    } catch { /* fall through */ }
    if (!(bal > 0)) {
      return {
        status: 400,
        body: {
          ok: false, ca, recipient: MAIN_WALLET, percent,
          error: '无法解析持仓数量（刷新持仓后再试，或改填绝对 amount / max）',
          tookMs: Date.now() - t0,
        },
      };
    }
    const human = formatSendAmount(bal * (percent / 100));
    if (!human) {
      return { status: 400, body: { ok: false, ca, recipient: MAIN_WALLET, percent, error: '计算转出数量失败', tookMs: Date.now() - t0 } };
    }
    sendAmount = human;
  }

  return enqueueTrade(async () => {
    const args = [
      'wallet', 'send',
      ...(useMax ? ['--max'] : ['--amount', String(sendAmount)]),
      '--recipient', MAIN_WALLET,
      '--binanceChainId', '56',
      '--tokenAddress', ca,
      '--gasLevel', 'MEDIUM',
    ];
    try {
      const j = await bawJson(args, { timeoutMs: TRADE_TIMEOUT_MS });
      const errRaw = j?.error
        ? (typeof j.error === 'string' ? j.error : (j.error.message || j.error.name || JSON.stringify(j.error)))
        : (j?.success === false ? (j?.message || 'send failed') : null);
      if (errRaw) {
        const book = addressBookErrorZh(errRaw);
        let err = book || String(errRaw).slice(0, 240);
        if (!book && /transfer.*(fail|disable|lock|not\s+allow)|non[- ]?transfer|locked|不可转|禁止转|无法转账|TRANSFER_FROM_FAILED|execution reverted/i.test(String(errRaw))) {
          err = `代币可能未开放转账（曲线未毕业常见）：${err}`;
        }
        return {
          status: 400,
          body: {
            ok: false,
            ca,
            recipient: MAIN_WALLET,
            ...(useMax ? { max: true } : { amount: sendAmount }),
            ...(resolvedPercent != null ? { percent: resolvedPercent } : {}),
            error: err,
            tookMs: Date.now() - t0,
          },
        };
      }
      const data = j?.data || j?.result || {};
      const txHash = data.txHash || data.hash || j?.txHash || j?.hash || null;
      const needsAppConfirm = !!(
        j?.needsAppConfirm || j?.pendingConfirmation || data.needsAppConfirm || data.pendingConfirmation
        || /NeedConfirmation|pending.?confirm|awaiting.?confirm|require.*confirm/i.test(JSON.stringify(j || {}))
      );
      const note = needsAppConfirm
        ? '已提交，请在币安 App 确认转账'
        : (txHash ? '已广播，等待链上确认' : null);
      return {
        status: 200,
        body: {
          ok: true,
          ca,
          recipient: MAIN_WALLET,
          ...(useMax ? { max: true } : { amount: sendAmount }),
          ...(resolvedPercent != null ? { percent: resolvedPercent } : {}),
          ...(txHash ? { txHash } : {}),
          ...(needsAppConfirm ? { needsAppConfirm: true } : {}),
          ...(note ? { note } : {}),
          tookMs: Date.now() - t0,
        },
      };
    } catch (e) {
      const msg = e.message || 'transfer failed';
      const book = addressBookErrorZh(msg);
      return {
        status: 500,
        body: {
          ok: false,
          ca,
          recipient: MAIN_WALLET,
          ...(useMax ? { max: true } : { amount: sendAmount }),
          ...(resolvedPercent != null ? { percent: resolvedPercent } : {}),
          error: book || msg.slice(0, 240),
          tookMs: Date.now() - t0,
        },
      };
    }
  });
}

async function getHoldings(force = false) {
  const now = Date.now();
  if (!force && holdingsCache.payload && now - holdingsCache.at < HOLDINGS_TTL_MS) {
    return holdingsCache.payload;
  }
  if (!force && holdingsCache.payload && holdingsCache.building) return holdingsCache.payload;
  if (holdingsCache.building) return holdingsCache.building;
  holdingsCache.building = (async () => {
    if (!walletInfo.address) await refreshWallet().catch(() => {});
    const board = cache.payload || await getBoard(false).catch(() => null);
    const payload = await fetchHoldings({
      owner: walletInfo.address,
      board,
      tradeEngine,
      aiwb,
      bawJson,
      loadPnl: loadPnlFn || undefined,
      bnbUsd,
    });
    holdingsCache = { at: Date.now(), payload, building: null };
    return payload;
  })().catch(e => {
    holdingsCache.building = null;
    if (holdingsCache.payload) return holdingsCache.payload;
    return { ok: false, error: e.message, items: [], updatedAt: new Date().toISOString() };
  });
  if (!force && holdingsCache.payload) {
    holdingsCache.building.catch(() => {});
    return holdingsCache.payload;
  }
  return holdingsCache.building;
}


/**
 * Board K-line: prefer official GANG candles when platform=gang (saves GMGN quota);
 * otherwise GMGN first; on GMGN 429/fail try GANG if CA is on gang.fun.
 * FLAP/FOUR have no official candle API — GMGN only (+ stale/429 UX).
 */
async function fetchBoardKline(opts = {}) {
  const platform = String(opts.platform || '').toLowerCase();
  const preferOfficial = opts.prefer === 'official' || (platform === 'gang' && opts.prefer !== 'gmgn');
  const common = {
    address: opts.address,
    resolution: opts.resolution,
    hours: opts.hours,
    fromSec: opts.fromSec,
    toSec: opts.toSec,
  };

  if (preferOfficial && platform === 'gang') {
    const off = await fetchGangKline(common);
    if (off.ok && off.candles?.length) return off;
    const gm = await fetchKline(common);
    if (gm.ok && gm.candles?.length) return { ...gm, fallbackFrom: off.source || 'GANG' };
    // Prefer official error if both empty; keep rateLimited from GMGN when present
    if (gm.rateLimited) return gm;
    if (off.ok) return off; // ok but 0 candles
    return {
      ok: false,
      error: gm.error || off.error || 'K线不可用',
      candles: [],
      address: String(opts.address || '').toLowerCase(),
      resolution: opts.resolution,
      source: gm.source || off.source || null,
      tried: ['GANG', 'GMGN'],
    };
  }

  const gm = await fetchKline(common);
  if (gm.ok && gm.candles?.length) return gm;

  // Opportunistic GANG fallback when GMGN fails/empty (known gang, or unknown platform)
  if (platform === 'gang' || !platform) {
    const off = await fetchGangKline(common);
    if (off.ok && off.candles?.length) {
      return { ...off, fallbackFrom: 'GMGN', rateLimited: !!gm.rateLimited };
    }
  }

  if (platform === 'flap' || platform === 'four') {
    // Documented: no official candle API; surface GMGN result (incl. Chinese 429)
    return gm.ok ? gm : {
      ...gm,
      error: gm.error || (platform === 'flap'
        ? 'FLAP 无官方K线，GMGN 亦失败'
        : 'FOUR 无官方K线，GMGN 亦失败'),
    };
  }

  return gm;
}

const AUTH_PATHS = new Set(['/api/board', '/api/health', '/api/trade', '/api/transfer', '/api/check', '/api/holdings', '/api/kline', '/api/holders']);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type,x-board-key');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (AUTH_PATHS.has(url.pathname)) {
    if (!keyOk(req, url)) {
      sendJson(res, 401, { error: 'unauthorized — open the URL with ?k=…' });
      return;
    }
  }

  try {
    if (url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, rpcLatencyMs: rpcLatency, bnbUsd, aiwb: !!aiwb, tradeEngine: !!tradeEngine, gangCli: true, wallet: walletInfo, mainWallet: MAIN_WALLET, mainWalletShort: shortAddr(MAIN_WALLET) });
      return;
    }
    if (url.pathname === '/api/board') {
      const force = url.searchParams.get('fresh') === '1';
      const board = await getBoard(force);
      // Always overlay live wallet — board cache must not freeze a timed-out empty address.
      if (!walletInfo.address) await refreshWallet().catch(() => {});
      overlayGangPadsFromCache(board);
      const out = { ...board, meta: { ...(board.meta || {}), wallet: walletInfo } };
      sendJson(res, 200, out);
      return;
    }
    if (url.pathname === '/api/check') {
      let ca = url.searchParams.get('ca') || '';
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        if (body.ca) ca = String(body.ca);
      } else if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      const out = await handleCheck(ca);
      sendJson(res, out.status, out.body);
      return;
    }
    if (url.pathname === '/api/trade') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'POST only' });
        return;
      }
      const body = await readJsonBody(req);
      const out = await handleTrade(body);
      // Invalidate holdings after a successful trade so the strip refreshes soon.
      if (out?.body?.ok) holdingsCache = { at: 0, payload: holdingsCache.payload, building: null };
      sendJson(res, out.status, out.body);
      return;
    }
    if (url.pathname === '/api/transfer') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'POST only' });
        return;
      }
      const body = await readJsonBody(req);
      // Security: strip any client recipient — server always uses MAIN_WALLET.
      if (body && typeof body === 'object') {
        delete body.recipient;
        delete body.to;
        delete body.destination;
      }
      const out = await handleTransfer(body);
      if (out?.body?.ok) holdingsCache = { at: 0, payload: holdingsCache.payload, building: null };
      sendJson(res, out.status, out.body);
      return;
    }
    if (url.pathname === '/api/holdings') {
      const force = url.searchParams.get('fresh') === '1';
      const h = await getHoldings(force);
      const out = {
        ...h,
        meta: { ...(h.meta || {}), mainWallet: MAIN_WALLET, mainWalletShort: shortAddr(MAIN_WALLET) },
      };
      sendJson(res, out.ok === false && !out.items?.length ? 500 : 200, out);
      return;
    }
    if (url.pathname === '/api/kline') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'GET only' });
        return;
      }
      const ca = String(url.searchParams.get('ca') || url.searchParams.get('address') || '').trim();
      const resolution = String(url.searchParams.get('resolution') || '1m');
      const hours = Number(url.searchParams.get('hours') || 2);
      const fromSec = url.searchParams.get('from') ? Number(url.searchParams.get('from')) : undefined;
      const toSec = url.searchParams.get('to') ? Number(url.searchParams.get('to')) : undefined;
      const platform = String(url.searchParams.get('platform') || '').toLowerCase().trim();
      const prefer = String(url.searchParams.get('prefer') || '').toLowerCase().trim(); // official|gmgn
      const out = await fetchBoardKline({
        address: ca, resolution, hours, fromSec, toSec, platform, prefer,
      });
      sendJson(res, out.ok ? 200 : (out.error?.includes('invalid') ? 400 : 502), out);
      return;
    }
    if (url.pathname === '/api/holders') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'GET only' });
        return;
      }
      const ca = String(url.searchParams.get('ca') || url.searchParams.get('address') || '').trim();
      const limit = Number(url.searchParams.get('limit') || 20);
      const chain = String(url.searchParams.get('chain') || 'bsc');
      const out = await fetchHolders({ address: ca, chain, limit });
      sendJson(res, out.ok ? 200 : (out.error?.includes('invalid') ? 400 : 502), out);
      return;
    }
    serveStatic(url, res);
  } catch (e) {
    sendJson(res, e.status || 500, { error: e.message });
  }
});

async function main() {
  try {
    aiwb = await loadAiwb();
    const defaultRpc = [
      'https://bsc.blockrazor.xyz',
      'https://1rpc.io/bnb',
      'https://bsc-rpc.publicnode.com',
      'https://bsc-dataseed.bnbchain.org',
    ];
    const rpcList = process.env.BSC_RPC ? process.env.BSC_RPC.split(',').map(s => s.trim()).filter(Boolean) : defaultRpc;
    if (!process.env.GANG_RPC_URL && rpcList[0]) process.env.GANG_RPC_URL = rpcList[0];
    rpc = aiwb.createRpc(rpcList);
    console.log('[board] aiwb loaded from', aiwb.root);
    try {
      tradeEngine = await createTradeEngine(aiwb.root, { rpcUrls: rpcList });
      console.log('[board] in-process trade engine ready; rpc', tradeEngine.urls[0]);
    } catch (e) {
      console.warn('[board] trade engine unavailable, CLI fallback:', e.message);
      tradeEngine = null;
    }
    try {
      const { pathToFileURL } = await import('node:url');
      const store = await import(pathToFileURL(path.join(aiwb.root, 'lib', 'store.mjs')).href);
      loadPnlFn = () => store.pnl();
    } catch (e) {
      console.warn('[board] pnl loader unavailable:', e.message);
    }
  } catch (e) {
    console.warn('[board] aiwb unavailable:', e.message, '— GANG HTTP only');
  }

  refreshWallet().catch(() => {});
  setInterval(() => refreshWallet().catch(() => {}), 60_000);

  server.listen(PORT, HOST, () => {
    const url = `http://${HOST}:${PORT}/?k=${KEY}`;
    console.log('[board] SENSU listening');
    console.log('[board] URL', url);
    console.log('[board] nearMinPct', NEAR_MIN, 'nearMinMcUsd', NEAR_MIN_MC, 'cacheMs', CACHE_MS, 'tradeTimeoutMs', TRADE_TIMEOUT_MS);
    console.log('[board] MAIN_WALLET', MAIN_WALLET);
    // Warm cache in background
    getBoard(true).then(b => {
      const c = b.meta?.counts;
      console.log('[board] warm', JSON.stringify(c));
      if (b.meta?.errors && Object.keys(b.meta.errors).length) console.log('[board] errors', b.meta.errors);
      return getHoldings(true);
    }).then(h => {
      if (h) console.log('[board] holdings', h.items?.length ?? 0, h.ok ? 'ok' : h.error);
    }).catch(e => console.error('[board] warm failed', e.message));
  });
}

main();
