import { helius } from './helius.mjs';

export async function mapLimited(items, limit, worker) {
  const results=[]; let cursor=0;
  async function run(){ while(cursor<items.length){ const index=cursor++; results[index]=await worker(items[index]); } }
  await Promise.all(Array.from({length:Math.min(limit,items.length)},run));
  return results;
}

function tokenDelta(tx, mint, owner) {
  const before = new Map();
  const after = new Map();
  for (const item of tx?.meta?.preTokenBalances || []) {
    if (item.mint === mint && item.owner === owner) before.set(item.accountIndex, Number(item.uiTokenAmount?.amount || 0));
  }
  for (const item of tx?.meta?.postTokenBalances || []) {
    if (item.mint === mint && item.owner === owner) after.set(item.accountIndex, Number(item.uiTokenAmount?.amount || 0));
  }
  const indexes = new Set([...before.keys(), ...after.keys()]);
  return [...indexes].reduce((sum, index) => sum + (after.get(index) || 0) - (before.get(index) || 0), 0);
}

function transactionTokenDestinations(tx, mint, owner) {
  const keys = tx?.transaction?.message?.accountKeys || [];
  const addressAt = (index) => typeof keys[index] === 'string' ? keys[index] : keys[index]?.pubkey;
  const tokenAccounts = new Map();
  for (const item of [...(tx?.meta?.preTokenBalances || []), ...(tx?.meta?.postTokenBalances || [])]) {
    if (item.mint === mint && item.owner) tokenAccounts.set(addressAt(item.accountIndex), item.owner);
  }
  const ownedAccounts = new Set([...tokenAccounts.entries()].filter(([, accountOwner]) => accountOwner === owner).map(([account]) => account));
  const destinations = new Set();
  const allInstructions = [
    ...(tx?.transaction?.message?.instructions || []),
    ...((tx?.meta?.innerInstructions || []).flatMap((group) => group.instructions || [])),
  ];
  for (const instruction of allInstructions) {
    const info = instruction?.parsed?.info;
    if (instruction?.program !== 'spl-token' || !info || !['transfer', 'transferChecked'].includes(instruction.parsed?.type)) continue;
    if (ownedAccounts.has(info.source) && info.destination) destinations.add(tokenAccounts.get(info.destination) || info.destination);
  }
  return [...destinations].filter(Boolean);
}

export async function inspectOwner(owner, mint, key, options = {}) {
  const historyLimit = options.historyLimit || 100;
  const txLimit = options.txLimit || 8;
  try {
    const signatures = await helius('getSignaturesForAddress', [owner, { limit:historyLimit }], key);
    const oldest = [...(signatures || [])].sort((a,b)=>(a.blockTime || 0)-(b.blockTime || 0))[0];
    if (!oldest?.signature) return { owner, status:'insufficient_history' };
    const recent = (signatures || []).filter((item) => item.signature).slice(0, txLimit);
    const transactions = await mapLimited(recent, options.concurrency || 1, async (item) => {
      try { return await helius('getTransaction', [item.signature, { encoding:'jsonParsed', maxSupportedTransactionVersion:0 }], key); }
      catch { return null; }
    });
    const acquisitions = [];
    const sales = [];
    const saleDestinations = new Map();
    for (let index = 0; index < transactions.length; index++) {
      const tx = transactions[index];
      if (!tx) continue;
      const delta = tokenDelta(tx, mint, owner);
      const time = tx.blockTime || recent[index]?.blockTime || null;
      if (delta > 0) acquisitions.push({ amount: delta, blockTime: time });
      if (delta < 0) {
        const destinations = transactionTokenDestinations(tx, mint, owner);
        for (const destination of destinations) saleDestinations.set(destination, (saleDestinations.get(destination) || 0) + 1);
        sales.push({ amount: Math.abs(delta), blockTime: time, destinations });
      }
    }
    const oldestTx = await helius('getTransaction', [oldest.signature, { encoding:'jsonParsed', maxSupportedTransactionVersion:0 }], key);
    const instructions = oldestTx?.transaction?.message?.instructions || [];
    const funding = instructions.find((ix) => ix?.program === 'system' && ix?.parsed?.type === 'transfer' && ix.parsed.info?.destination === owner);
    const firstAcquisition = acquisitions.filter((item) => item.blockTime).sort((a,b)=>a.blockTime-b.blockTime)[0] || null;
    return {
      owner, status:'observed', firstObservedBlockTime: oldest.blockTime || null, firstSignature: oldest.signature,
      fundingSource: funding?.parsed?.info?.source || null, firstAcquisitionBlockTime: firstAcquisition?.blockTime || null,
      firstAcquisitionAmount: firstAcquisition?.amount || null, acquisitionCount: acquisitions.length, saleCount: sales.length,
      saleDestinations: [...saleDestinations.entries()].map(([address,count])=>({address,count})),
    };
  } catch (error) { return { owner, status:'error', error:error.message }; }
}
