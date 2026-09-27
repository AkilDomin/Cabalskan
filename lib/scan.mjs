import { getKey, helius } from './helius.mjs';
import { inspectOwner, mapLimited } from './forensics.mjs';

const depths = {
  quick: { owners:0, txLimit:0, label:'quick summary' },
  standard: { owners:5, txLimit:8, label:'standard forensic' },
  deep: { owners:20, txLimit:16, label:'deep forensic' },
};

export async function liveScan(mint, requestedDepth = 'standard') {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) throw new Error('Invalid Solana mint address');
  const key = await getKey();
  if (!key) return { configured:false, message:'Helius API key is not configured locally.' };
  const keyConfig = depths[requestedDepth] || depths.standard;
  const [supply, holderResult] = await Promise.all([
    helius('getTokenSupply', [mint], key),
    helius('getTokenAccounts', { page:1, limit:1000, mint, displayOptions:{} }, key),
  ]);
  const accounts = holderResult?.token_accounts || [];
  const byOwner = new Map();
  for (const account of accounts) {
    const owner = account.owner;
    const amount = Number(account.amount || account.token_amount?.amount || 0);
    if (owner) byOwner.set(owner, (byOwner.get(owner) || 0) + amount);
  }
  const holders = [...byOwner.entries()].map(([owner, amount]) => ({ owner, amount })).sort((a,b)=>b.amount-a.amount);
  const total = Number(supply?.value?.amount || 0);
  const top10 = holders.slice(0,10).reduce((sum, h)=>sum+h.amount,0);
  const forensic = keyConfig.owners ? await mapLimited(holders.slice(0,keyConfig.owners), keyConfig.concurrency || 1, (holder)=>inspectOwner(holder.owner, mint, key, { txLimit:keyConfig.txLimit, concurrency:1 })) : [];
  const fundingGroups = new Map();
  for (const item of forensic) if (item.fundingSource) fundingGroups.set(item.fundingSource, (fundingGroups.get(item.fundingSource)||0)+1);
  const sharedFunding = [...fundingGroups.entries()].filter(([,count])=>count>=2).map(([source,count])=>({source,count}));
  const observedTimes = forensic.filter((item)=>item.firstObservedBlockTime).map((item)=>item.firstObservedBlockTime);
  const tightTimeCluster = observedTimes.length>=3 && Math.max(...observedTimes)-Math.min(...observedTimes)<=120;
  const acquisitionTimes = forensic.filter((item)=>item.firstAcquisitionBlockTime).map((item)=>item.firstAcquisitionBlockTime);
  const acquisitionSpreadSeconds = acquisitionTimes.length >= 2 ? Math.max(...acquisitionTimes)-Math.min(...acquisitionTimes) : null;
  const tightAcquisitionCluster = acquisitionTimes.length >= 3 && acquisitionSpreadSeconds <= 180;
  const acquisitionAmounts = forensic.map((item)=>item.firstAcquisitionAmount).filter((amount)=>Number.isFinite(amount) && amount > 0);
  const amountSpreadRatio = acquisitionAmounts.length >= 2 ? Math.max(...acquisitionAmounts)/Math.min(...acquisitionAmounts) : null;
  const exitGroups = new Map();
  for (const item of forensic) for (const destination of item.saleDestinations || []) exitGroups.set(destination.address, (exitGroups.get(destination.address)||0)+destination.count);
  const sharedExitDestinations = [...exitGroups.entries()].filter(([,count])=>count>=2).map(([address,count])=>({address,count}));
  const riskScore = Math.min(100, (sharedFunding.some((item)=>item.count>=3)?45:sharedFunding.length?20:0) + (tightTimeCluster?25:0) + (tightAcquisitionCluster?20:0) + (sharedExitDestinations.length?15:0) + (total && top10/total>0.10?20:0));
  const signals = [];
  if (!keyConfig.owners) signals.push({level:'info',title:'Quick summary mode',detail:'Supply and holders were loaded without expensive history analysis. Use standard or deep for forensic signals.'});
  if (sharedFunding.some((item)=>item.count>=3)) signals.push({level:'high',title:'Shared funding source',detail:'At least three checked holders received their first funding from one source.'});
  else if (sharedFunding.length) signals.push({level:'medium',title:'Repeated funding source',detail:`Holders share a funding source; checked ${keyConfig.owners} largest holders.`});
  if (tightTimeCluster) signals.push({level:'medium',title:'Tight first-observation timing',detail:'Three or more wallets appeared in history within two minutes.'});
  if (tightAcquisitionCluster) signals.push({level:'medium',title:'Synchronized first entry',detail:`First confirmed balance changes fit within ${acquisitionSpreadSeconds} seconds.`});
  if (sharedExitDestinations.length) signals.push({level:'medium',title:'Repeated exit destination',detail:'Several outgoing token transfers point to one address; it may be a pool, router, or coordinated address.'});
  if (amountSpreadRatio !== null && amountSpreadRatio >= 5) signals.push({level:'info',title:'Different first-entry sizes',detail:`The largest first entry is about ${amountSpreadRatio.toFixed(1)}x the smallest; this weakens the mechanical-copying signal.`});
  if (total && top10/total>0.10) signals.push({level:'medium',title:'Holder concentration',detail:'The top 10 loaded holders exceed 10% of supply; this is a signal, not proof of a link.'});
  if (!signals.length) signals.push({level:'info',title:'No confirmed links in this sample',detail:'There is not enough evidence for a cabal conclusion; expand the history and sample.'});
  return { configured:true, partial:true, scanDepth:keyConfig.label, mint, supply:supply?.value || null, loadedAccounts:accounts.length, uniqueOwners:holders.length, top10ConcentrationOfLoadedPage:total ? Number((top10/total*100).toFixed(2)) : null, acquisitionSpreadSeconds, amountSpreadRatio, sharedExitDestinations, riskScore, confidence: !keyConfig.owners ? 'not_run' : forensic.filter((item)=>item.status==='observed').length>=3?'medium':'low', analysisLimits:{ownersChecked:keyConfig.owners, transactionsPerOwner:keyConfig.txLimit}, signals, forensic, holders:holders.slice(0,20) };
}
