// Resolve ai-wallet-binance from common install locations (Windows npm global / box).
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

function candidates() {
  const home = process.env.APPDATA || process.env.HOME || '';
  const list = [
    path.join(home, 'npm', 'node_modules', 'ai-wallet-binance'),
    path.join(home, '.local', 'lib', 'node_modules', 'ai-wallet-binance'),
    '/home/box/.local/lib/node_modules/ai-wallet-binance',
  ];
  try {
    list.unshift(path.dirname(require.resolve('ai-wallet-binance/package.json')));
  } catch { /* not linked */ }
  return list;
}

export async function loadAiwb() {
  for (const root of candidates()) {
    const pads = path.join(root, 'lib', 'agentpads.mjs');
    const rpc = path.join(root, 'lib', 'rpc.mjs');
    const abi = path.join(root, 'lib', 'abi.mjs');
    if (fs.existsSync(pads) && fs.existsSync(rpc) && fs.existsSync(abi)) {
      const [agentpads, rpcMod, abiMod] = await Promise.all([
        import(pathToFileURL(pads).href),
        import(pathToFileURL(rpc).href),
        import(pathToFileURL(abi).href),
      ]);
      return { root, ...agentpads, ...rpcMod, ...abiMod };
    }
  }
  throw new Error('ai-wallet-binance not found (install globally or set APPDATA npm path)');
}
