/** Chunked eth_getLogs with backoff + optional JSON cache of discovered addresses. */
import fs from 'node:fs';
import path from 'node:path';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function logsChunked(rpc, filter, from, to, {
  chunk = 1_000n,
  pauseMs = 80,
  retries = 1,
  deadlineMs = 25_000,
} = {}) {
  const out = [];
  const endAt = Date.now() + deadlineMs;
  for (let a = BigInt(from); a <= BigInt(to); a += chunk) {
    if (Date.now() > endAt) break;
    const b = a + chunk - 1n > BigInt(to) ? BigInt(to) : a + chunk - 1n;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const logs = await rpc.logs({ ...filter, fromBlock: a, toBlock: b });
        out.push(...logs);
        break;
      } catch (e) {
        await sleep(200 * (attempt + 1));
      }
    }
    if (pauseMs) await sleep(pauseMs);
  }
  return out;
}

export function loadCache(file) {
  try {
    if (!fs.existsSync(file)) return [];
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(j) ? j : (j.addresses || []);
  } catch { return []; }
}

export function saveCache(file, addresses) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const uniq = [...new Set(addresses.map(a => String(a).toLowerCase()))];
    fs.writeFileSync(file, JSON.stringify({ updatedAt: new Date().toISOString(), addresses: uniq }, null, 2));
  } catch { /* ignore */ }
}
