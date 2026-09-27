const depths = new Set(['quick', 'standard', 'deep']);
const mintPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body, (_key, value) => typeof value === 'bigint' ? value.toString() : value));
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });

  const mint = String(req.query?.mint ?? '').trim();
  const depth = String(req.query?.depth ?? 'standard').toLowerCase();
  const rawScanAtSlot = req.query?.scanAtSlot;
  const scanAtSlot = rawScanAtSlot === undefined || rawScanAtSlot === '' ? undefined : Number(rawScanAtSlot);

  if (!mintPattern.test(mint)) return json(res, 400, { error: 'Invalid Solana mint address', code: 'E001_INVALID_MINT' });
  if (!depths.has(depth)) return json(res, 400, { error: 'depth must be quick, standard, or deep', code: 'E002_INVALID_DEPTH' });
  if (scanAtSlot !== undefined && (!Number.isSafeInteger(scanAtSlot) || scanAtSlot <= 0)) return json(res, 400, { error: 'scanAtSlot must be a positive integer', code: 'E003_INVALID_SLOT' });

  try {
    const { runForensicScan } = await import('../core-ts/dist/index.js');
    const result = await runForensicScan(mint, depth, { scanAtSlot });
    return json(res, 200, { ...result, coreRuntime: 'typescript', deployment: 'vercel' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    const code = message.match(/\[(E\d{3}_[A-Z_]+)\]/)?.[1] ?? 'E900_UNKNOWN';
    const status = /429|too many requests|rate.?limit|resource exhausted/i.test(message) ? 429 : 500;
    return json(res, status, { error: message, code, retryable: status === 429 });
  }
}
