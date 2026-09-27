import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const credentialPath = path.join(os.homedir(), '.config', 'cabalscan', 'credentials.json');

export async function getKey() {
  if (process.env.HELIUS_API_KEY) return process.env.HELIUS_API_KEY;
  try { const saved = JSON.parse(await fs.readFile(credentialPath, 'utf8')); return saved.heliusApiKey; } catch { return null; }
}

export async function helius(method, params, key) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`, {
      method:'POST', headers:{'content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:Date.now(),method,params}),
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok && !data.error) return data.result;
    if (response.status !== 429 && data.error?.code !== -32429) throw new Error(data.error?.message || `Helius HTTP ${response.status}`);
    await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
  }
  throw new Error('Helius HTTP 429: rate limit after retries');
}
