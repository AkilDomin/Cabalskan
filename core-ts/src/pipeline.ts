import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Connection, PublicKey } from '@solana/web3.js';
import { CabalForensicAnalyzer } from './module2.js';
import { fetchTokenHoldersExtended } from './module1.js';
import { checkTokenSecurityMetrics } from './security.js';
import { generateAIVerdict, generateRuleBasedVerdict, type AIForensicReport } from './ai-verdict.js';
import type { AIVerdict, DexClassification, ForensicGraph, TokenSecurityMetrics } from './types.js';

export type ScanDepth = 'quick' | 'standard' | 'deep';

export interface PipelineResult {
  configured: true;
  partial: true;
  scanDepth: ScanDepth;
  mint: string;
  supply: { amount: string; decimals: number; uiAmount: number | null; uiAmountString?: string | null } | null;
  loadedAccounts: number;
  uniqueOwners: number;
  riskScore: number;
  confidence: 'low' | 'medium' | 'not_run';
  isConfirmedJitoBundle: boolean | null;
  jitoBundle: ForensicGraph['metrics']['jito'] | null;
  top10ConcentrationOfLoadedPage: number | null;
  acquisitionSpreadSeconds: number | null;
  amountSpreadRatio: number | null;
  sharedExitDestinations: Array<{ address: string; count: number }>;
  analysisLimits: { ownersChecked: number; transactionsPerOwner: number };
  signals: Array<{ level: 'high' | 'medium' | 'info'; title: string; detail: string }>;
  graph: ForensicGraph | null;
  security: TokenSecurityMetrics | null;
  dex: DexClassification[];
  aiVerdict: AIVerdict | null;
  cache: { hit: boolean; ttlSeconds: number };
  rpc: { provider: 'helius' | 'solana-public'; keyAttempt: number; rateLimitRotations: number };
  historical: { requested: boolean; scanAtSlot: number | null; limitations: string[] };
}

interface Credentials { heliusApiKey?: string; heliusApiKeys?: string[] }

const credentialPath = path.join(os.homedir(), '.config', 'cabalscan', 'credentials.json');

async function readHeliusKeys(): Promise<string[]> {
  const fromEnvironment = (process.env.HELIUS_API_KEYS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (fromEnvironment.length) return fromEnvironment;
  if (process.env.HELIUS_API_KEY) return [process.env.HELIUS_API_KEY];
  try {
    const credentials = JSON.parse(await fs.readFile(credentialPath, 'utf8')) as Credentials;
    if (credentials.heliusApiKeys?.length) return credentials.heliusApiKeys.filter(Boolean);
    return credentials.heliusApiKey ? [credentials.heliusApiKey] : [];
  } catch {
    return [];
  }
}

const modes: Record<ScanDepth, { holderLimit: number; signaturesPerHolder: number; concurrency: number; minIntervalMs: number }> = {
  quick: { holderLimit: 100, signaturesPerHolder: 0, concurrency: 1, minIntervalMs: 50 },
  standard: { holderLimit: 10, signaturesPerHolder: 10, concurrency: 1, minIntervalMs: 150 },
  deep: { holderLimit: 20, signaturesPerHolder: 20, concurrency: 2, minIntervalMs: 200 },
};

const SCAN_CACHE_TTL_MS = 3 * 60 * 1000;
const scanCache = new Map<string, { expiresAt: number; result: PipelineResult }>();
const inFlightScans = new Map<string, Promise<PipelineResult>>();

type ScanStageCode = 'E101_SUPPLY' | 'E102_HOLDERS' | 'E103_SECURITY_QUICK' | 'E201_GRAPH' | 'E202_SECURITY_FORENSIC' | 'E301_PUBLIC_FALLBACK';

async function runStage<T>(code: ScanStageCode, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(`[${code}]`)) throw error;
    throw new Error(`${message} [${code}]`);
  }
}

async function runForensicScanOnce(mint: string, depth: ScanDepth, key: string, scanAtSlot: number | undefined, keyAttempt: number, rpcEndpoint?: string): Promise<PipelineResult> {
  const mode = modes[depth];
  const endpoint = rpcEndpoint ?? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`;
  const connection = new Connection(endpoint, { commitment: 'confirmed', disableRetryOnRateLimit: true });
  const supplyInfo = await runStage('E101_SUPPLY', () => connection.getTokenSupply(new PublicKey(mint)));
  const supply = { amount: supplyInfo.value.amount, decimals: supplyInfo.value.decimals, uiAmount: supplyInfo.value.uiAmount, uiAmountString: supplyInfo.value.uiAmountString };
  const allHolders = await runStage('E102_HOLDERS', () => fetchTokenHoldersExtended(connection, mint, mode.holderLimit, key || undefined));
  if (depth === 'quick') {
    const security = await runStage('E103_SECURITY_QUICK', () => checkTokenSecurityMetrics(connection, mint));
    const quickAIReport: AIForensicReport = { mint, graph: { nodeCount: 0, edgeCount: 0, maxFundingDepth: 0, holderCount: allHolders.length, commonFundingSources: [], totalGroupHoldingPercent: null, totalGroupSoldPercent: null, synchronizedSelling: null, synchronizedBuyCluster: null, jito: { isConfirmedJitoBundle: false, qualifyingWalletCount: 0, slots: [] } }, security, dex: [] };
    return {
      configured: true, partial: true, scanDepth: depth, mint, supply, loadedAccounts: allHolders.length,
      uniqueOwners: new Set(allHolders.map((holder) => holder.owner)).size, riskScore: 0, confidence: 'not_run',
      isConfirmedJitoBundle: null, jitoBundle: null,
      top10ConcentrationOfLoadedPage: null, acquisitionSpreadSeconds: null, amountSpreadRatio: null,
      sharedExitDestinations: [], analysisLimits: { ownersChecked: 0, transactionsPerOwner: 0 },
      signals: [{ level: 'info', title: endpoint.includes('helius') ? 'Quick summary mode' : 'Quick summary via public Solana RPC', detail: endpoint.includes('helius') ? 'Transaction history was not requested.' : 'Helius rate limits were reached, so this limited summary uses the public Solana RPC. No indexed forensic history was requested.' }], graph: null, security, dex: [], aiVerdict: generateRuleBasedVerdict(quickAIReport, 0), cache: { hit: false, ttlSeconds: 180 }, rpc: { provider: endpoint.includes('helius') ? 'helius' : 'solana-public', keyAttempt, rateLimitRotations: Math.max(0, keyAttempt - 1) }, historical: { requested: scanAtSlot !== undefined, scanAtSlot: scanAtSlot ?? null, limitations: scanAtSlot === undefined ? [] : ['Quick mode uses the current holder snapshot; historical transaction history is not requested.'] },
    };
  }
  const holders = allHolders.slice(0, depth === 'deep' ? 50 : 20);
  const analyzer = new CabalForensicAnalyzer(connection, mint, holders, { signaturesPerHolder: mode.signaturesPerHolder, concurrency: mode.concurrency, minIntervalMs: mode.minIntervalMs, maxSlot: scanAtSlot });
  const graph = await runStage('E201_GRAPH', () => analyzer.analyze());
  const liquidityCandidates = [...new Map(graph.timeline.flatMap((event) => (event.venues ?? []).flatMap((venue) => event.counterparties.map((poolAddress) => [`${venue.venue}:${poolAddress}`, { venue: venue.venue, poolAddress }] as const)))).values()];
  const security = await runStage('E202_SECURITY_FORENSIC', () => checkTokenSecurityMetrics(connection, mint, { liquidityCandidates }));
  const dex = [...new Map(graph.timeline.flatMap((event) => event.venues ?? []).map((venue) => [venue.programId, venue])).values()];
  const metrics = graph.metrics;
  const sharedExitDestinations = metrics.commonProfitDestinations.map((item) => ({ address: item.address, count: item.eventCount }));
  const riskScore = Math.min(100, (metrics.commonFundingSources.some((item) => item.holderCount >= 3) ? 45 : metrics.commonFundingSources.length ? 20 : 0) + (metrics.synchronizedBuyCluster ? 25 : 0) + (metrics.synchronizedSelling ? 25 : 0) + (sharedExitDestinations.length ? 15 : 0));
  const signals: PipelineResult['signals'] = [];
  if (metrics.commonFundingSources.length) signals.push({ level: metrics.commonFundingSources.some((item) => item.holderCount >= 3) ? 'high' : 'medium', title: 'Shared funding source', detail: `Shared sources were found across ${metrics.commonFundingSources.reduce((sum, item) => sum + item.holderCount, 0)} links.` });
  if (metrics.synchronizedBuyCluster) signals.push({ level: 'medium', title: 'Synchronized buys', detail: `Buy spread: ${metrics.buySlotSpread ?? 0} slots.` });
  if (metrics.synchronizedSelling) signals.push({ level: 'medium', title: 'Synchronized sells', detail: `Sell spread: ${metrics.sellSlotSpread ?? 0} slots.` });
  if (sharedExitDestinations.length) signals.push({ level: 'medium', title: 'Repeated exit destinations', detail: 'Several sales point to the same destinations; this needs pool or router classification.' });
  if (metrics.jito.isConfirmedJitoBundle) signals.push({ level: 'high', title: 'Confirmed same-slot Jito bundle evidence', detail: `${metrics.jito.qualifyingWalletCount} wallets bought in one slot with Jito tip instructions.` });
  if (!security.mintAuthorityRevoked) signals.push({ level: 'medium', title: 'Mint authority is active', detail: 'The authority may be able to issue additional tokens.' });
  if (!security.freezeAuthorityRevoked) signals.push({ level: 'high', title: 'Freeze authority is active', detail: 'Token accounts may potentially be frozen by the authority.' });
  if (!signals.length) signals.push({ level: 'info', title: 'No confirmed links in this sample', detail: 'No strong shared structure was found in the available history window.' });
  const aiReport: AIForensicReport = {
    mint,
    graph: {
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      maxFundingDepth: Math.max(0, ...graph.edges.map((edge) => edge.fundingDepth ?? 0)),
      holderCount: holders.length,
      commonFundingSources: metrics.commonFundingSources,
      totalGroupHoldingPercent: metrics.totalGroupHoldingPercent,
      totalGroupSoldPercent: metrics.totalGroupSoldPercent,
      synchronizedSelling: metrics.synchronizedSelling,
      synchronizedBuyCluster: metrics.synchronizedBuyCluster,
      jito: { isConfirmedJitoBundle: metrics.jito.isConfirmedJitoBundle, qualifyingWalletCount: metrics.jito.qualifyingWalletCount, slots: metrics.jito.slots },
    },
    security,
    dex,
  };
  let aiVerdict: AIVerdict | null = generateRuleBasedVerdict(aiReport, riskScore);
  if (process.env.OPENAI_API_KEY) {
    try { aiVerdict = await generateAIVerdict(aiReport); } catch (error) { signals.push({ level: 'info', title: 'AI verdict unavailable; local rule engine used', detail: error instanceof Error ? error.message : 'Unknown AI service error.' }); }
  }
  return {
    configured: true, partial: true, scanDepth: depth, mint, supply, loadedAccounts: allHolders.length,
    uniqueOwners: new Set(allHolders.map((holder) => holder.owner)).size, riskScore,
    confidence: graph.timeline.length >= 3 ? 'medium' : 'low', top10ConcentrationOfLoadedPage: null,
    isConfirmedJitoBundle: metrics.jito.isConfirmedJitoBundle, jitoBundle: metrics.jito,
    acquisitionSpreadSeconds: metrics.buySlotSpread === null ? null : metrics.buySlotSpread * 0.4,
    amountSpreadRatio: null, sharedExitDestinations,
    analysisLimits: { ownersChecked: holders.length, transactionsPerOwner: mode.signaturesPerHolder }, signals, graph, security, dex, aiVerdict, cache: { hit: false, ttlSeconds: 180 }, rpc: { provider: endpoint.includes('helius') ? 'helius' : 'solana-public', keyAttempt, rateLimitRotations: Math.max(0, keyAttempt - 1) }, historical: { requested: scanAtSlot !== undefined, scanAtSlot: scanAtSlot ?? null, limitations: scanAtSlot === undefined ? [] : ['Holder balances and mint authorities are current RPC state; only fetched transaction records are filtered by slot.', 'A slot older than the returned signature window may produce an incomplete graph.', 'Historical token balances require an archive/indexed balance source and are not inferred from current balances.'] },
  };
}

function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /429|too many requests|rate.?limit|resource exhausted/i.test(message);
}

export interface ScanOptions { scanAtSlot?: number; }

export async function runForensicScan(mint: string, depth: ScanDepth, options: ScanOptions = {}): Promise<PipelineResult> {
  const scanAtSlot = options.scanAtSlot;
  if (scanAtSlot !== undefined && (!Number.isSafeInteger(scanAtSlot) || scanAtSlot <= 0)) throw new Error('scanAtSlot must be a positive integer.');
  const cacheKey = `${mint}:${depth}:${scanAtSlot ?? 'latest'}`;
  const cached = scanCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return { ...cached.result, cache: { hit: true, ttlSeconds: Math.max(0, Math.ceil((cached.expiresAt - Date.now()) / 1000)) } };
  if (cached) scanCache.delete(cacheKey);
  const existing = inFlightScans.get(cacheKey);
  if (existing) return { ...(await existing), cache: { hit: true, ttlSeconds: 180 } };
  const scanPromise = (async (): Promise<PipelineResult> => {
    const keys = await readHeliusKeys();
    if (!keys.length) throw new Error('No Helius API key is configured locally.');
    let lastError: unknown = null;
    for (const [index, key] of keys.entries()) {
      try {
        const result = await runForensicScanOnce(mint, depth, key, scanAtSlot, index + 1);
        scanCache.set(cacheKey, { expiresAt: Date.now() + SCAN_CACHE_TTL_MS, result });
        return result;
      } catch (error) {
        lastError = error;
        if (!isRateLimitError(error)) throw error;
      }
    }
    if (depth === 'quick') {
      const result = await runStage('E301_PUBLIC_FALLBACK', () => runForensicScanOnce(mint, depth, '', scanAtSlot, keys.length + 1, 'https://api.mainnet-beta.solana.com'));
      scanCache.set(cacheKey, { expiresAt: Date.now() + SCAN_CACHE_TTL_MS, result });
      return result;
    }
    throw lastError instanceof Error ? lastError : new Error('All Helius API keys were rate-limited.');
  })();
  inFlightScans.set(cacheKey, scanPromise);
  try { return await scanPromise; } finally { inFlightScans.delete(cacheKey); }
}
