/**
 * Official @gangfun/cli (`gang`) wrapper for Soft / LaunchpadU / LaunchpadS.
 * V2 stays on aiwb; archive pads use: gang quote|buy|sell → gang execute --request-id.
 * Never invent Soft calldata — only spawn the official CLI.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);

export const GANG_PADS = {
  v2: '0x1B8F3f69DFa0a7F63d308C7EB0Fd38D8b099966E',
  soft: '0x4E6f13c8A453c1b8b4E20b590082bb233a5b80d7',
  u: '0xF81C4E51c48466c6025B0165b1Ea0F6978c712cb',
  s: '0x60aee38576035E757deD30fF8db8A8DA476430C1',
};

const ARCHIVE = new Set(['soft', 'u', 's']);
const PAD_TTL_MS = Number(process.env.GANG_PAD_TTL_MS || 300_000);
const padCache = new Map(); // ca -> { at, info }

let chainModPromise = null;

export function isArchivePad(padId) {
  return ARCHIVE.has(String(padId || '').toLowerCase());
}

/** Trades that must go through official gang CLI (not aiwb LaunchpadV2-only). */
export function usesGangCli(padId) {
  return isArchivePad(padId);
}

function ensureGangRpcEnv() {
  if (process.env.GANG_RPC_URL) return;
  const first = (process.env.BSC_RPC || '').split(',').map(s => s.trim()).filter(Boolean)[0];
  if (first) process.env.GANG_RPC_URL = first;
}

async function loadGangChain() {
  if (chainModPromise) return chainModPromise;
  chainModPromise = (async () => {
    ensureGangRpcEnv();
    const candidates = [
      process.env.GANG_CLI_CHAIN,
      process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules', '@gangfun', 'cli', 'src', 'chain.js'),
      process.env.HOME && path.join(process.env.HOME, '.npm-global', 'lib', 'node_modules', '@gangfun', 'cli', 'src', 'chain.js'),
      '/usr/lib/node_modules/@gangfun/cli/src/chain.js',
    ].filter(Boolean);
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) {
          return await import(pathToFileURL(p).href);
        }
      } catch { /* try next */ }
    }
    return null;
  })();
  return chainModPromise;
}

function parseJsonBlob(text) {
  const raw = String(text || '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`gang: no json: ${raw.slice(0, 200)}`);
  return JSON.parse(raw.slice(start, end + 1));
}

/**
 * Spawn `gang <args…>` (official CLI prints JSON).
 * Inherits HTTP(S)_PROXY / NODE_USE_ENV_PROXY / GANG_RPC_URL from process.env.
 */
export async function gangJson(args, { timeoutMs = 180_000 } = {}) {
  ensureGangRpcEnv();
  let stdout = '';
  let stderr = '';
  try {
    const r = await execFileAsync('gang', args, {
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
    try {
      return parseJsonBlob(String(stdout).trim() || String(stderr).trim());
    } catch {
      const msg = e.killed ? `gang timed out after ${timeoutMs}ms` : (e.message || 'gang failed');
      throw new Error(msg + (stderr ? `: ${String(stderr).slice(0, 200)}` : ''));
    }
  }
  return parseJsonBlob(String(stdout).trim() || String(stderr).trim());
}

/** Pure-RPC pad resolve (V2 → Soft → U → S), same order as official CLI. */
export async function resolvePad(token) {
  const ca = String(token || '').toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(ca)) throw new Error('invalid token for resolvePad');
  const hit = padCache.get(ca);
  if (hit && Date.now() - hit.at < PAD_TTL_MS && hit.info?.pad) {
    return hit.info;
  }
  const chain = await loadGangChain();
  if (chain?.resolvePad) {
    const pad = await chain.resolvePad(ca);
    const info = {
      pad: pad.id,
      padAddress: pad.address,
      kind: pad.kind,
      graduated: false,
      source: 'resolvePad',
    };
    // graduated from curve if present
    try {
      const c = pad.curve;
      if (pad.kind === 'soft' && Array.isArray(c)) info.graduated = !!c[3];
      else if (Array.isArray(c)) info.graduated = !!c[6];
      else if (c?.graduated != null) info.graduated = !!c.graduated;
    } catch { /* ignore */ }
    padCache.set(ca, { at: Date.now(), info });
    return info;
  }
  // Fallback: gang token (needs baw for myBalance; still returns pad)
  const j = await gangJson(['token', '--token', ca], { timeoutMs: 90_000 });
  if (!j?.success && j?.error) throw new Error(String(j.error));
  const info = {
    pad: j.pad,
    padAddress: j.padAddress,
    kind: j.kind,
    graduated: !!j.graduated,
    symbol: j.symbol,
    name: j.name,
    quote: j.quote,
    myBalance: j.myBalance,
    myBalanceRaw: j.myBalanceRaw,
    pair: j.pair || null,
    source: 'gang-token',
  };
  padCache.set(ca, { at: Date.now(), info });
  return info;
}

/** Full token info via CLI (includes myBalance when wallet connected). */
export async function gangToken(token, { timeoutMs = 90_000 } = {}) {
  const ca = String(token || '').toLowerCase();
  const j = await gangJson(['token', '--token', ca], { timeoutMs });
  if (!j?.success && j?.error) throw new Error(String(j.error));
  const info = {
    pad: j.pad,
    padAddress: j.padAddress,
    kind: j.kind,
    graduated: !!j.graduated,
    symbol: j.symbol,
    name: j.name,
    quote: j.quote,
    myBalance: j.myBalance,
    myBalanceRaw: j.myBalanceRaw,
    pair: j.pair || null,
    progressPct: j.progressPct,
    source: 'gang-token',
  };
  padCache.set(ca, { at: Date.now(), info });
  return info;
}

export async function gangQuote(token, bnbAmount, { timeoutMs = 90_000 } = {}) {
  return gangJson(['quote', '--token', token, '--bnb', String(bnbAmount)], { timeoutMs });
}

function formatEtherLike(rawWei) {
  const s = String(rawWei);
  if (!/^\d+$/.test(s)) throw new Error(`bad wei: ${s}`);
  if (s === '0') return '0';
  if (s.length <= 18) return `0.${s.padStart(18, '0')}`.replace(/\.?0+$/, '') || '0';
  const whole = s.slice(0, s.length - 18);
  let frac = s.slice(s.length - 18).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

/**
 * Convert board sell amount ("50%" | "100%" | raw tokens) to gang CLI flags.
 * Uses myBalanceRaw from gang token — never invents a balance.
 */
export async function sellAmountToGangFlags(token, amountStr) {
  const s = String(amountStr || '').trim();
  if (!s) throw new Error('sell amount required');
  if (/^100%$/.test(s) || /^all$/i.test(s)) return { all: true };
  if (/%$/.test(s)) {
    const pct = Number(s.slice(0, -1));
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
      throw new Error('sell % must be in (0, 100]');
    }
    if (pct >= 100) return { all: true };
    const info = await gangToken(token);
    if (!info.myBalanceRaw) throw new Error('gang token did not return myBalanceRaw — cannot size % sell');
    const bal = BigInt(info.myBalanceRaw);
    if (bal <= 0n) throw new Error('no balance to sell');
    // pct with 2 decimal places → / 10000
    const bps = BigInt(Math.round(pct * 100));
    const wei = (bal * bps) / 10000n;
    if (wei <= 0n) throw new Error('sell % rounds to 0 tokens');
    return { amount: formatEtherLike(wei.toString()), balanceRaw: info.myBalanceRaw, pad: info.pad };
  }
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) throw new Error('sell amount must be % or a positive token amount');
  return { amount: String(s) };
}

export async function gangSellPreview(token, { amount, all = false, slippage } = {}, { timeoutMs = 180_000 } = {}) {
  const args = ['sell', '--token', token];
  if (all) args.push('--all');
  else {
    if (amount == null || amount === '') throw new Error('gang sell needs --amount or --all');
    args.push('--amount', String(amount));
  }
  if (slippage != null) args.push('--slippage', String(slippage));
  return gangJson(args, { timeoutMs });
}

export async function gangBuyPreview(token, bnbAmount, { slippage } = {}, { timeoutMs = 180_000 } = {}) {
  const args = ['buy', '--token', token, '--bnb', String(bnbAmount)];
  if (slippage != null) args.push('--slippage', String(slippage));
  return gangJson(args, { timeoutMs });
}

export async function gangExecute(requestId, { timeoutMs = 300_000 } = {}) {
  if (!requestId) throw new Error('request-id required');
  return gangJson(['execute', '--request-id', String(requestId)], { timeoutMs });
}

const SETUP_STEPS = new Set(['approve', 'approve-quote', 'wrap-bnb']);

/**
 * Preview → (optional) execute loop for archive pads.
 * dry=true: stop after first successful preview (no execute).
 * Auto-executes setup steps (approve / wrap) then re-previews the trade.
 */
export async function gangTrade({
  side,
  token,
  /** buy: quote/BNB amount string for --bnb */
  bnb,
  /** sell: board amount "50%" | raw | use all */
  amount,
  dry = false,
  maxSteps = 5,
  onStep = null,
} = {}) {
  const ca = String(token || '').trim();
  const steps = [];
  let lastPreview = null;
  let lastExecute = null;

  for (let i = 0; i < maxSteps; i++) {
    let preview;
    if (side === 'buy') {
      if (bnb == null || bnb === '') throw new Error('buy needs bnb/--bnb amount');
      preview = await gangBuyPreview(ca, bnb);
    } else if (side === 'sell') {
      const flags = await sellAmountToGangFlags(ca, amount);
      preview = await gangSellPreview(ca, { amount: flags.amount, all: !!flags.all });
    } else {
      throw new Error('side must be buy|sell');
    }

    lastPreview = preview;
    steps.push({ i, preview: summarizePreview(preview) });
    if (typeof onStep === 'function') onStep({ phase: 'preview', i, preview });

    if (!preview?.success) {
      return {
        ok: false,
        side,
        ca,
        dry,
        error: String(preview?.error || 'gang preview failed'),
        preview,
        steps,
        tradePath: 'gang-cli',
      };
    }

    if (dry) {
      return {
        ok: true,
        side,
        ca,
        dry: true,
        executed: false,
        preview,
        steps,
        pad: preview.pad,
        step: preview.step,
        requestId: preview.requestId || null,
        requireConfirmation: !!preview.requireConfirmation,
        note: 'dry preview only — not executed; run without dry to gang execute',
        tradePath: 'gang-cli',
        next: preview.next || (preview.requestId ? `gang execute --request-id ${preview.requestId}` : undefined),
      };
    }

    if (!preview.requestId) {
      return {
        ok: false,
        side,
        ca,
        dry: false,
        error: 'gang preview returned no requestId',
        preview,
        steps,
        tradePath: 'gang-cli',
      };
    }

    const ex = await gangExecute(preview.requestId);
    lastExecute = ex;
    steps.push({ i, execute: summarizeExecute(ex) });
    if (typeof onStep === 'function') onStep({ phase: 'execute', i, execute: ex });

    if (!ex?.success) {
      return {
        ok: false,
        side,
        ca,
        dry: false,
        error: String(ex?.error || 'gang execute failed'),
        preview,
        execute: ex,
        steps,
        pad: preview.pad,
        tradePath: 'gang-cli',
      };
    }

    if (ex.pendingConfirmation || ex.status === 'PENDING_CONFIRMATION') {
      return {
        ok: true,
        side,
        ca,
        dry: false,
        needsAppConfirm: true,
        pendingConfirmation: true,
        preview,
        execute: ex,
        steps,
        pad: preview.pad,
        step: preview.step,
        requestId: preview.requestId,
        txHash: ex.txHash || null,
        note: 'Confirm in Binance App (NeedConfirmation). After approve, board/poll or: gang tx --hash <hash>',
        next: ex.next || 'Approve in Binance App, then check tx history',
        tradePath: 'gang-cli',
      };
    }

    // Setup step done on-chain → re-run buy/sell preview
    if (SETUP_STEPS.has(String(preview.step || ''))) {
      continue;
    }

    // Final trade step
    return {
      ok: true,
      side,
      ca,
      dry: false,
      executed: true,
      needsAppConfirm: false,
      preview,
      execute: ex,
      steps,
      pad: preview.pad,
      step: preview.step,
      requestId: preview.requestId,
      hash: ex.txHash || null,
      txHash: ex.txHash || null,
      tradePath: 'gang-cli',
    };
  }

  return {
    ok: false,
    side,
    ca,
    dry,
    error: `gang trade exceeded ${maxSteps} steps (stuck on approve/wrap?)`,
    preview: lastPreview,
    execute: lastExecute,
    steps,
    tradePath: 'gang-cli',
  };
}

/**
 * After a gang-cli buy: if next sell would need an `approve` setup step, execute that only.
 * Does not execute a sell step.
 */
export async function gangEnsureSellApprove(token, { timeoutMs = 300_000 } = {}) {
  const ca = String(token || '').trim();
  const t0 = Date.now();
  const flags = await sellAmountToGangFlags(ca, '100%');
  const preview = await gangSellPreview(ca, { amount: flags.amount, all: !!flags.all }, { timeoutMs });
  if (!preview?.success) {
    return {
      ok: false,
      skipped: false,
      error: String(preview?.error || 'gang sell preview failed'),
      preview: summarizePreview(preview),
      tookMs: Date.now() - t0,
      tradePath: 'gang-cli',
    };
  }
  const step = String(preview.step || '');
  if (step !== 'approve') {
    return {
      ok: true,
      skipped: true,
      reason: `step=${step || 'unknown'} (sell approve already open or not required)`,
      pad: preview.pad,
      step,
      preview: summarizePreview(preview),
      tookMs: Date.now() - t0,
      tradePath: 'gang-cli',
    };
  }
  if (!preview.requestId) {
    return {
      ok: false,
      error: 'approve preview has no requestId',
      preview: summarizePreview(preview),
      tookMs: Date.now() - t0,
      tradePath: 'gang-cli',
    };
  }
  const ex = await gangExecute(preview.requestId, { timeoutMs });
  if (!ex?.success) {
    return {
      ok: false,
      error: String(ex?.error || 'gang approve execute failed'),
      preview: summarizePreview(preview),
      execute: summarizeExecute(ex),
      tookMs: Date.now() - t0,
      tradePath: 'gang-cli',
    };
  }
  if (ex.pendingConfirmation || ex.status === 'PENDING_CONFIRMATION') {
    return {
      ok: true,
      skipped: false,
      approved: false,
      needsAppConfirm: true,
      pendingConfirmation: true,
      pad: preview.pad,
      step,
      hash: ex.txHash || null,
      preview: summarizePreview(preview),
      execute: summarizeExecute(ex),
      note: 'Sell-approve pending Binance App confirm',
      tookMs: Date.now() - t0,
      tradePath: 'gang-cli',
    };
  }
  return {
    ok: true,
    skipped: false,
    approved: true,
    pad: preview.pad,
    step,
    hash: ex.txHash || null,
    preview: summarizePreview(preview),
    execute: summarizeExecute(ex),
    tookMs: Date.now() - t0,
    tradePath: 'gang-cli',
  };
}

function summarizePreview(p) {
  if (!p) return null;
  return {
    success: p.success,
    step: p.step,
    pad: p.pad,
    kind: p.kind,
    symbol: p.symbol,
    amount: p.amount,
    expectOut: p.expectOut,
    expectTokens: p.expectTokens,
    fee: p.fee,
    requestId: p.requestId,
    requireConfirmation: p.requireConfirmation,
    error: p.error,
  };
}

function summarizeExecute(e) {
  if (!e) return null;
  return {
    success: e.success,
    status: e.status,
    txHash: e.txHash,
    pendingConfirmation: e.pendingConfirmation,
    error: e.error,
  };
}

/** Read cached pad without RPC (board card overlay; null if miss/stale). */
export function peekPadCache(token) {
  const ca = String(token || '').toLowerCase();
  const hit = padCache.get(ca);
  if (hit && Date.now() - hit.at < PAD_TTL_MS && hit.info?.pad) return hit.info;
  return null;
}

export function clearPadCache() {
  padCache.clear();
}
