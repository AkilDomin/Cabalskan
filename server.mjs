import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
let runForensicScan;
let coreRuntime = 'typescript';
try {
  ({ runForensicScan } = await import('./core-ts/dist/index.js'));
} catch {
  ({ liveScan: runForensicScan } = await import('./lib/scan.mjs'));
  coreRuntime = 'javascript-fallback';
}

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8765);
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml' };
const depths = new Set(['quick', 'standard', 'deep']);

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body, (_key, value) => typeof value === 'bigint' ? value.toString() : value) : body);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${port}`);
    if (url.pathname === '/api/live-scan') {
      const mint = url.searchParams.get('mint')?.trim() ?? '';
      const requestedDepth = (url.searchParams.get('depth') ?? 'standard').toLowerCase();
      const rawScanAtSlot = url.searchParams.get('scanAtSlot');
      const scanAtSlot = rawScanAtSlot === null || rawScanAtSlot === '' ? undefined : Number(rawScanAtSlot);
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return send(res, 400, { error: 'Invalid Solana mint address' });
      if (!depths.has(requestedDepth)) return send(res, 400, { error: 'depth must be quick, standard, or deep' });
      if (scanAtSlot !== undefined && (!Number.isSafeInteger(scanAtSlot) || scanAtSlot <= 0)) return send(res, 400, { error: 'scanAtSlot must be a positive integer' });
      const result = await runForensicScan(mint, requestedDepth, { scanAtSlot });
      return send(res, 200, { ...result, coreRuntime });
    }
    const requested = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.resolve(root, `.${requested}`);
    if (!file.startsWith(root + path.sep)) return send(res, 403, { error: 'Forbidden' });
    const body = await fs.readFile(file);
    return send(res, 200, body, mime[path.extname(file)] || 'application/octet-stream');
  } catch (error) {
    if (res.headersSent || res.writableEnded) {
      res.destroy();
      return;
    }
    const message = error instanceof Error ? error.message : 'Internal server error';
    const status = /429|too many requests|rate.?limit|resource exhausted/i.test(message)
      ? 429
      : /could not find account|invalid param|invalid solana mint/i.test(message)
        ? 400
        : 500;
    const code = message.match(/\[(E\d{3}_[A-Z_]+)\]/)?.[1] ?? 'E900_UNKNOWN';
    return send(res, status, { error: message, code, retryable: status === 429 });
  }
});

server.listen(port, '127.0.0.1', () => console.log(`CabalScan TS core server: http://localhost:${port}`));
