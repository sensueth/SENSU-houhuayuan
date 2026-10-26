// Minimal BSC JSON-RPC (mirrors aiwb createRpc shape; proxy via NODE_USE_ENV_PROXY on Windows).
const PUBLIC_BSC = [
  'https://bsc-rpc.publicnode.com',
  'https://1rpc.io/bnb',
  'https://bsc.blockrazor.xyz',
  'https://bsc-dataseed.bnbchain.org',
];

export function createRpc(urls = PUBLIC_BSC, { timeoutMs = 10000 } = {}) {
  const list = (Array.isArray(urls) ? urls : String(urls).split(',')).map(s => s.trim()).filter(Boolean);
  let best = 0, id = 0, lastLatency = null;

  async function send(method, params = []) {
    let last;
    for (let i = 0; i < list.length; i++) {
      const k = (best + i) % list.length;
      const t0 = Date.now();
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), timeoutMs);
        const res = await fetch(list[k], {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
          signal: ctl.signal,
        }).finally(() => clearTimeout(timer));
        const j = await res.json();
        if (j.error) throw new Error(j.error.message || 'rpc error');
        best = k;
        lastLatency = Date.now() - t0;
        return j.result;
      } catch (e) {
        last = e;
      }
    }
    throw new Error(`all RPC nodes failed (${last?.message || last})`);
  }

  const hex = n => '0x' + BigInt(n).toString(16);
  const blockTag = b => (b == null ? 'latest' : typeof b === 'string' ? b : hex(b));

  return {
    urls: list,
    latencyMs: () => lastLatency,
    send,
    blockNumber: async () => BigInt(await send('eth_blockNumber')),
    call: ({ to, data }, block) => send('eth_call', [{ to, data }, blockTag(block)]),
    logs: filter => send('eth_getLogs', [{
      ...filter,
      fromBlock: blockTag(filter.fromBlock),
      toBlock: blockTag(filter.toBlock),
    }]),
    async read(to, sig, args, outTypes) {
      // lazy import abi from aiwb if present, else local encode below is unused — callers pass data
      throw new Error('use call with encoded data');
    },
  };
}

export { PUBLIC_BSC };
