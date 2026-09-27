import { Connection, PublicKey, type ConfirmedSignatureInfo, type ParsedInstruction, type PartiallyDecodedInstruction, type ParsedTransactionWithMeta } from '@solana/web3.js';
import { getJitoTipAccounts, parsedInstructionInfo, allInstructions, transactionHasJitoTip } from './module1.js';
import { classifyTransaction } from './dex.js';
import type { Address, AnalyzerOptions, ForensicGraph, ForensicMetrics, GraphEdge, GraphNode, Holder, TimelineEvent, TimelinePhase } from './types.js';

class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];
  private nextStartAt = 0;
  private readonly minIntervalMs: number;
  public constructor(size: number, minIntervalMs: number) { this.available = Math.max(1, size); this.minIntervalMs = Math.max(0, minIntervalMs); }
  public async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.available === 0) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.available -= 1;
    const now = Date.now();
    const waitMs = Math.max(0, this.nextStartAt - now);
    this.nextStartAt = Math.max(now, this.nextStartAt) + this.minIntervalMs;
    if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    try { return await job(); } finally { this.available += 1; this.waiters.shift()?.(); }
  }
}

interface FundingTransfer { source: Address; destination: Address; lamports: bigint; }
interface TransactionRecord { transaction: ParsedTransactionWithMeta; signature: string; slot: number; blockTime: number | null; }

function transferInfo(instruction: ParsedInstruction | PartiallyDecodedInstruction): FundingTransfer | null {
  const info = parsedInstructionInfo(instruction);
  if (!info || !('program' in instruction) || instruction.program !== 'system' || info.type !== 'transfer') return null;
  const source = typeof info.source === 'string' ? info.source : null;
  const destination = typeof info.destination === 'string' ? info.destination : null;
  const rawLamports = info.lamports;
  if (!source || !destination || (typeof rawLamports !== 'number' && typeof rawLamports !== 'string')) return null;
  try { return { source, destination, lamports: BigInt(rawLamports) }; } catch { return null; }
}

function accountKeys(transaction: ParsedTransactionWithMeta): Address[] { return transaction.transaction.message.accountKeys.map((key) => key.pubkey.toBase58()); }

function tokenDelta(transaction: ParsedTransactionWithMeta, mint: Address, owner: Address): bigint {
  const before = new Map<number, bigint>();
  const after = new Map<number, bigint>();
  for (const balance of transaction.meta?.preTokenBalances ?? []) if (balance.mint === mint && balance.owner === owner) before.set(balance.accountIndex, BigInt(balance.uiTokenAmount.amount));
  for (const balance of transaction.meta?.postTokenBalances ?? []) if (balance.mint === mint && balance.owner === owner) after.set(balance.accountIndex, BigInt(balance.uiTokenAmount.amount));
  const indexes = new Set([...before.keys(), ...after.keys()]);
  return [...indexes].reduce((sum, index) => sum + (after.get(index) ?? 0n) - (before.get(index) ?? 0n), 0n);
}

function tokenCounterparties(transaction: ParsedTransactionWithMeta, mint: Address, owner: Address): Address[] {
  const keys = accountKeys(transaction);
  const tokenOwners = new Map<Address, Address>();
  for (const balance of [...(transaction.meta?.preTokenBalances ?? []), ...(transaction.meta?.postTokenBalances ?? [])]) {
    if (balance.mint === mint && balance.owner) tokenOwners.set(keys[balance.accountIndex] ?? '', balance.owner);
  }
  const ownedTokenAccounts = new Set([...tokenOwners.entries()].filter(([, tokenOwner]) => tokenOwner === owner).map(([account]) => account));
  const counterparties = new Set<Address>();
  for (const instruction of allInstructions(transaction)) {
    const info = parsedInstructionInfo(instruction);
    if (!info || !('program' in instruction) || instruction.program !== 'spl-token') continue;
    const source = typeof info.source === 'string' ? info.source : '';
    const destination = typeof info.destination === 'string' ? info.destination : '';
    if (ownedTokenAccounts.has(source) && destination) counterparties.add(tokenOwners.get(destination) ?? destination);
  }
  return [...counterparties];
}

function uniqueOwners(holders: Holder[]): Map<Address, bigint> {
  const result = new Map<Address, bigint>();
  for (const holder of holders) result.set(holder.owner, (result.get(holder.owner) ?? 0n) + holder.rawAmount);
  return result;
}

export class CabalForensicAnalyzer {
  private readonly connection: Connection;
  private readonly mint: PublicKey;
  private readonly holders: Holder[];
  private readonly options: Required<Omit<AnalyzerOptions, 'maxSlot'>> & Pick<AnalyzerOptions, 'maxSlot'>;
  private readonly rpc: Semaphore;
  private readonly signatureCache = new Map<Address, Promise<ConfirmedSignatureInfo[]>>();
  private readonly transactionCache = new Map<string, Promise<ParsedTransactionWithMeta | null>>();
  private readonly visitedFundingDepth = new Map<Address, number>();
  private fundingNodesVisited = 0;

  public constructor(connection: Connection, mintAddress: string, holders: Holder[], options: AnalyzerOptions = {}) {
    this.connection = connection;
    this.mint = new PublicKey(mintAddress);
    this.holders = holders;
    this.options = { maxHops: 3, signaturesPerHolder: 40, buyClusterMaxSlots: 3, sellClusterMaxSlots: 3, jitoMinimumWallets: 5, concurrency: 4, minIntervalMs: 75, maxFundingNodes: 500, minimumTransferLamports: 1_000_000, ...options };
    this.rpc = new Semaphore(this.options.concurrency, this.options.minIntervalMs);
  }

  public async analyze(): Promise<ForensicGraph> {
    const mint = this.mint.toBase58();
    const owners = [...uniqueOwners(this.holders).keys()];
    const nodes = new Map<Address, GraphNode>(owners.map((owner) => [owner, { address: owner, kind: 'holder' }]));
    const edges: GraphEdge[] = [];
    const timeline: TimelineEvent[] = [];
    const tipAccounts = await getJitoTipAccounts();
    const fundingRoots = new Map<Address, Set<Address>>();
    for (const owner of owners) await this.walkFunding(owner, 0, owner, edges, nodes, fundingRoots, timeline);
    const transactions = await this.loadHolderTransactions(owners);
    for (let index = 0; index < owners.length; index += 1) for (const transaction of transactions[index] ?? []) this.extractTokenEvents(transaction, owners[index]!, mint, tipAccounts, edges, timeline, nodes);
    const supply = await this.rpc.run(() => this.connection.getTokenSupply(this.mint));
    const metrics = this.calculateMetrics(timeline, edges, supply.value.amount, fundingRoots);
    const phases = this.buildPhases(timeline, metrics);
    return {
      mint, nodes: [...nodes.values()], edges, timeline, phases, metrics,
      limitations: [
        'Funding traversal is bounded to three hops, the configured signature window and the maximum node budget.',
        'Jito confirmation requires five distinct holder wallets buying in one slot and each transaction carrying a tip to a current Jito tip account.',
        'A Jito bundle cannot be proven from a tip alone without a block-engine bundle identifier; this result is strict on-chain bundle evidence.',
        'IP addresses are not present in Solana transaction data.',
      ],
    };
  }

  private async getSignatures(address: Address): Promise<ConfirmedSignatureInfo[]> {
    const cached = this.signatureCache.get(address);
    if (cached) return cached;
    const request = this.rpc.run(() => this.connection.getSignaturesForAddress(new PublicKey(address), { limit: this.options.signaturesPerHolder }));
    this.signatureCache.set(address, request);
    return request;
  }

  private async getTransaction(signature: string): Promise<ParsedTransactionWithMeta | null> {
    const cached = this.transactionCache.get(signature);
    if (cached) return cached;
    const request = this.rpc.run(() => this.connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 }));
    this.transactionCache.set(signature, request);
    return request;
  }

  private async loadHolderTransactions(owners: Address[]): Promise<TransactionRecord[][]> {
    return this.mapLimited(owners, async (owner) => {
      const signatures = await this.getSignatures(owner);
      const records = await this.mapLimited(signatures.filter((signature) => this.options.maxSlot === undefined || signature.slot <= this.options.maxSlot), async (signature) => {
        const transaction = await this.getTransaction(signature.signature);
        return transaction ? { transaction, signature: signature.signature, slot: signature.slot, blockTime: signature.blockTime ?? null } : null;
      });
      return records.filter((record): record is TransactionRecord => record !== null);
    });
  }

  private async mapLimited<T, R>(items: T[], worker: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = [];
    let cursor = 0;
    const run = async (): Promise<void> => { while (cursor < items.length) { const index = cursor; cursor += 1; results[index] = await worker(items[index]!); } };
    await Promise.all(Array.from({ length: Math.min(this.options.concurrency, items.length) }, () => run()));
    return results;
  }

  private async incomingFunding(address: Address): Promise<Array<{ record: TransactionRecord; transfer: FundingTransfer }>> {
    const signatures = await this.getSignatures(address);
    const records = await this.mapLimited(signatures.filter((signature) => this.options.maxSlot === undefined || signature.slot <= this.options.maxSlot), async (signature) => {
      const transaction = await this.getTransaction(signature.signature);
      return transaction ? { transaction, signature: signature.signature, slot: signature.slot, blockTime: signature.blockTime ?? null } : null;
    });
    const result: Array<{ record: TransactionRecord; transfer: FundingTransfer }> = [];
    for (const record of records) {
      if (!record) continue;
      for (const instruction of allInstructions(record.transaction)) {
        const transfer = transferInfo(instruction);
        if (transfer && transfer.destination === address && transfer.lamports >= BigInt(this.options.minimumTransferLamports)) result.push({ record, transfer });
      }
    }
    return result;
  }

  private async walkFunding(current: Address, depth: number, rootHolder: Address, edges: GraphEdge[], nodes: Map<Address, GraphNode>, roots: Map<Address, Set<Address>>, timeline: TimelineEvent[]): Promise<void> {
    if (depth >= this.options.maxHops || this.fundingNodesVisited >= this.options.maxFundingNodes) return;
    const previousDepth = this.visitedFundingDepth.get(current);
    if (previousDepth !== undefined && previousDepth <= depth) return;
    this.visitedFundingDepth.set(current, depth);
    this.fundingNodesVisited += 1;
    const incoming = await this.incomingFunding(current);
    for (const item of incoming) {
      const { source, destination, lamports } = item.transfer;
      const signature = item.record.signature;
      const slot = item.record.slot;
      const blockTime = item.record.blockTime;
      nodes.set(source, nodes.get(source) ?? { address: source, kind: 'funding' });
      edges.push({ from: source, to: destination, kind: 'funding', signature, slot, blockTime, amountRaw: lamports, evidence: 'observed', fundingDepth: depth + 1 });
      timeline.push({ owner: rootHolder, kind: 'funding', signature, slot, blockTime, amountRaw: lamports, counterparties: [source] });
      const holdersForRoot = roots.get(source) ?? new Set<Address>();
      holdersForRoot.add(rootHolder);
      roots.set(source, holdersForRoot);
      await this.walkFunding(source, depth + 1, rootHolder, edges, nodes, roots, timeline);
    }
  }

  private extractTokenEvents(record: TransactionRecord, owner: Address, mint: Address, tips: Set<Address>, edges: GraphEdge[], timeline: TimelineEvent[], nodes: Map<Address, GraphNode>): void {
    const transaction = record.transaction;
    const amount = tokenDelta(transaction, mint, owner);
    if (amount === 0n) return;
    const signature = record.signature;
    const slot = record.slot;
    const blockTime = record.blockTime;
    const kind = amount > 0n ? 'buy' : 'sell';
    const counterparties = tokenCounterparties(transaction, mint, owner);
    const hasJitoTip = kind === 'buy' && transactionHasJitoTip(transaction, tips);
    for (const counterparty of counterparties) {
      nodes.set(counterparty, nodes.get(counterparty) ?? { address: counterparty, kind: kind === 'sell' ? 'pool' : 'unknown' });
      edges.push({ from: owner, to: counterparty, kind: kind === 'buy' ? 'token_buy' : 'token_sell', signature, slot, blockTime, amountRaw: amount > 0n ? amount : -amount, evidence: 'observed' });
    }
    timeline.push({ owner, kind, signature, slot, blockTime, amountRaw: amount > 0n ? amount : -amount, counterparties, hasJitoTip, venues: classifyTransaction(transaction) });
  }

  private calculateMetrics(timeline: TimelineEvent[], edges: GraphEdge[], supplyRaw: string, fundingRoots: Map<Address, Set<Address>>) {
    const buys = timeline.filter((event) => event.kind === 'buy');
    const sells = timeline.filter((event) => event.kind === 'sell');
    const buySlots = buys.map((event) => event.slot);
    const sellSlots = sells.map((event) => event.slot);
    const buySlotSpread = buySlots.length ? Math.max(...buySlots) - Math.min(...buySlots) : null;
    const sellSlotSpread = sellSlots.length ? Math.max(...sellSlots) - Math.min(...sellSlots) : null;
    const supply = BigInt(supplyRaw);
    const currentGroup = uniqueOwners(this.holders);
    const currentGroupRaw = [...currentGroup.values()].reduce((sum, amount) => sum + amount, 0n);
    const soldRaw = sells.reduce((sum, event) => sum + event.amountRaw, 0n);
    const sourceRows = [...fundingRoots.entries()].filter(([, holderSet]) => holderSet.size >= 2).map(([address, holderSet]) => ({ address, holderCount: holderSet.size, maxHops: this.options.maxHops }));
    const destinations = new Map<Address, number>();
    for (const edge of edges.filter((edge) => edge.kind === 'token_sell')) destinations.set(edge.to, (destinations.get(edge.to) ?? 0) + 1);
    const jitoBySlot = new Map<number, Map<Address, TimelineEvent>>();
    for (const buy of buys.filter((event) => event.hasJitoTip)) { const byOwner = jitoBySlot.get(buy.slot) ?? new Map<Address, TimelineEvent>(); byOwner.set(buy.owner, buy); jitoBySlot.set(buy.slot, byOwner); }
    const qualifying = [...jitoBySlot.entries()].filter(([, byOwner]) => byOwner.size >= this.options.jitoMinimumWallets);
    const jitoSlots = qualifying.map(([slot]) => slot);
    const jitoEvents = qualifying.flatMap(([, byOwner]) => [...byOwner.values()]);
    return {
      totalGroupHoldingPercent: supply > 0n ? Number((currentGroupRaw * 10000n) / supply) / 100 : null,
      totalGroupSoldPercent: supply > 0n ? Math.min(100, Number((soldRaw * 10000n) / supply) / 100) : null,
      synchronizedSelling: sellSlotSpread === null ? null : sellSlotSpread <= this.options.sellClusterMaxSlots,
      synchronizedBuyCluster: buySlotSpread === null ? null : buySlotSpread <= this.options.buyClusterMaxSlots,
      commonFundingSources: sourceRows,
      commonProfitDestinations: [...destinations.entries()].filter(([, count]) => count >= 2).map(([address, eventCount]) => ({ address, eventCount })),
      buySlotSpread, sellSlotSpread,
      jito: { isConfirmedJitoBundle: qualifying.length > 0, slots: jitoSlots, qualifyingWalletCount: Math.max(0, ...qualifying.map(([, byOwner]) => byOwner.size)), qualifyingSignatures: jitoEvents.map((event) => event.signature), reason: qualifying.length > 0 ? 'At least five distinct holder wallets bought in one slot and every qualifying transaction contained a Jito tip.' : 'No slot met the five-wallet plus Jito-tip threshold.' },
    };
  }

  private buildPhases(timeline: TimelineEvent[], metrics: ForensicMetrics): TimelinePhase[] {
    const funding = timeline.filter((event) => event.kind === 'funding');
    const buys = timeline.filter((event) => event.kind === 'buy');
    const sells = timeline.filter((event) => event.kind === 'sell');
    const phase = (name: TimelinePhase['phase'], events: TimelineEvent[], evidence: TimelinePhase['evidence']): TimelinePhase => ({ phase: name, firstSlot: events.length ? Math.min(...events.map((event) => event.slot)) : null, lastSlot: events.length ? Math.max(...events.map((event) => event.slot)) : null, eventCount: events.length, evidence });
    return [phase('funding', funding, funding.length ? 'observed' : 'unknown'), phase('bundle_buy', buys.filter((event) => event.hasJitoTip), metrics.jito.isConfirmedJitoBundle ? 'observed' : 'unknown'), phase('holding', buys, buys.length ? 'inferred' : 'unknown'), phase('synchronized_sell', sells, metrics.synchronizedSelling ? 'observed' : 'unknown'), phase('profit_extraction', sells.filter((event) => event.counterparties.length > 0), sells.length ? 'inferred' : 'unknown')];
  }
}
