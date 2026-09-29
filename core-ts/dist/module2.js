import { PublicKey } from '@solana/web3.js';
import { getJitoTipAccounts, parsedInstructionInfo, allInstructions, transactionHasJitoTip } from './module1.js';
import { classifyTransaction } from './dex.js';
class Semaphore {
    available;
    waiters = [];
    nextStartAt = 0;
    minIntervalMs;
    constructor(size, minIntervalMs) { this.available = Math.max(1, size); this.minIntervalMs = Math.max(0, minIntervalMs); }
    async run(job) {
        if (this.available === 0)
            await new Promise((resolve) => this.waiters.push(resolve));
        this.available -= 1;
        const now = Date.now();
        const waitMs = Math.max(0, this.nextStartAt - now);
        this.nextStartAt = Math.max(now, this.nextStartAt) + this.minIntervalMs;
        if (waitMs > 0)
            await new Promise((resolve) => setTimeout(resolve, waitMs));
        try {
            return await job();
        }
        finally {
            this.available += 1;
            this.waiters.shift()?.();
        }
    }
}
function transferInfo(instruction) {
    const info = parsedInstructionInfo(instruction);
    if (!info || !('program' in instruction) || instruction.program !== 'system' || info.type !== 'transfer')
        return null;
    const source = typeof info.source === 'string' ? info.source : null;
    const destination = typeof info.destination === 'string' ? info.destination : null;
    const rawLamports = info.lamports;
    if (!source || !destination || (typeof rawLamports !== 'number' && typeof rawLamports !== 'string'))
        return null;
    try {
        return { source, destination, lamports: BigInt(rawLamports) };
    }
    catch {
        return null;
    }
}
function accountKeys(transaction) { return transaction.transaction.message.accountKeys.map((key) => key.pubkey.toBase58()); }
function tokenDelta(transaction, mint, owner) {
    const before = new Map();
    const after = new Map();
    for (const balance of transaction.meta?.preTokenBalances ?? [])
        if (balance.mint === mint && balance.owner === owner)
            before.set(balance.accountIndex, BigInt(balance.uiTokenAmount.amount));
    for (const balance of transaction.meta?.postTokenBalances ?? [])
        if (balance.mint === mint && balance.owner === owner)
            after.set(balance.accountIndex, BigInt(balance.uiTokenAmount.amount));
    const indexes = new Set([...before.keys(), ...after.keys()]);
    return [...indexes].reduce((sum, index) => sum + (after.get(index) ?? 0n) - (before.get(index) ?? 0n), 0n);
}
function tokenCounterparties(transaction, mint, owner) {
    const keys = accountKeys(transaction);
    const tokenOwners = new Map();
    for (const balance of [...(transaction.meta?.preTokenBalances ?? []), ...(transaction.meta?.postTokenBalances ?? [])]) {
        if (balance.mint === mint && balance.owner)
            tokenOwners.set(keys[balance.accountIndex] ?? '', balance.owner);
    }
    const ownedTokenAccounts = new Set([...tokenOwners.entries()].filter(([, tokenOwner]) => tokenOwner === owner).map(([account]) => account));
    const counterparties = new Set();
    for (const instruction of allInstructions(transaction)) {
        const info = parsedInstructionInfo(instruction);
        if (!info || !('program' in instruction) || instruction.program !== 'spl-token')
            continue;
        const source = typeof info.source === 'string' ? info.source : '';
        const destination = typeof info.destination === 'string' ? info.destination : '';
        if (ownedTokenAccounts.has(source) && destination)
            counterparties.add(tokenOwners.get(destination) ?? destination);
    }
    return [...counterparties];
}
function uniqueOwners(holders) {
    const result = new Map();
    for (const holder of holders)
        result.set(holder.owner, (result.get(holder.owner) ?? 0n) + holder.rawAmount);
    return result;
}
export class CabalForensicAnalyzer {
    connection;
    mint;
    holders;
    options;
    rpc;
    signatureCache = new Map();
    transactionCache = new Map();
    visitedFundingDepth = new Map();
    fundingNodesVisited = 0;
    constructor(connection, mintAddress, holders, options = {}) {
        this.connection = connection;
        this.mint = new PublicKey(mintAddress);
        this.holders = holders;
        this.options = { maxHops: 3, signaturesPerHolder: 40, buyClusterMaxSlots: 3, sellClusterMaxSlots: 3, jitoMinimumWallets: 5, concurrency: 4, minIntervalMs: 75, maxFundingNodes: 500, minimumTransferLamports: 1_000_000, ...options };
        this.rpc = new Semaphore(this.options.concurrency, this.options.minIntervalMs);
    }
    async analyze() {
        const mint = this.mint.toBase58();
        const owners = [...uniqueOwners(this.holders).keys()];
        const nodes = new Map(owners.map((owner) => [owner, { address: owner, kind: 'holder' }]));
        const edges = [];
        const timeline = [];
        const tipAccounts = await getJitoTipAccounts();
        const fundingRoots = new Map();
        for (const owner of owners)
            await this.walkFunding(owner, 0, owner, edges, nodes, fundingRoots, timeline);
        const transactions = await this.loadHolderTransactions(owners);
        for (let index = 0; index < owners.length; index += 1)
            for (const transaction of transactions[index] ?? [])
                this.extractTokenEvents(transaction, owners[index], mint, tipAccounts, edges, timeline, nodes);
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
    async getSignatures(address) {
        const cached = this.signatureCache.get(address);
        if (cached)
            return cached;
        const request = this.rpc.run(() => this.connection.getSignaturesForAddress(new PublicKey(address), { limit: this.options.signaturesPerHolder }));
        this.signatureCache.set(address, request);
        return request;
    }
    async getTransaction(signature) {
        const cached = this.transactionCache.get(signature);
        if (cached)
            return cached;
        const request = this.rpc.run(() => this.connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 1 }));
        this.transactionCache.set(signature, request);
        return request;
    }
    async loadHolderTransactions(owners) {
        return this.mapLimited(owners, async (owner) => {
            const signatures = await this.getSignatures(owner);
            const records = await this.mapLimited(signatures.filter((signature) => this.options.maxSlot === undefined || signature.slot <= this.options.maxSlot), async (signature) => {
                const transaction = await this.getTransaction(signature.signature);
                return transaction ? { transaction, signature: signature.signature, slot: signature.slot, blockTime: signature.blockTime ?? null } : null;
            });
            return records.filter((record) => record !== null);
        });
    }
    async mapLimited(items, worker) {
        const results = [];
        let cursor = 0;
        const run = async () => { while (cursor < items.length) {
            const index = cursor;
            cursor += 1;
            results[index] = await worker(items[index]);
        } };
        await Promise.all(Array.from({ length: Math.min(this.options.concurrency, items.length) }, () => run()));
        return results;
    }
    async incomingFunding(address) {
        const signatures = await this.getSignatures(address);
        const records = await this.mapLimited(signatures.filter((signature) => this.options.maxSlot === undefined || signature.slot <= this.options.maxSlot), async (signature) => {
            const transaction = await this.getTransaction(signature.signature);
            return transaction ? { transaction, signature: signature.signature, slot: signature.slot, blockTime: signature.blockTime ?? null } : null;
        });
        const result = [];
        for (const record of records) {
            if (!record)
                continue;
            for (const instruction of allInstructions(record.transaction)) {
                const transfer = transferInfo(instruction);
                if (transfer && transfer.destination === address && transfer.lamports >= BigInt(this.options.minimumTransferLamports))
                    result.push({ record, transfer });
            }
        }
        return result;
    }
    async walkFunding(current, depth, rootHolder, edges, nodes, roots, timeline) {
        if (depth >= this.options.maxHops || this.fundingNodesVisited >= this.options.maxFundingNodes)
            return;
        const previousDepth = this.visitedFundingDepth.get(current);
        if (previousDepth !== undefined && previousDepth <= depth)
            return;
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
            const holdersForRoot = roots.get(source) ?? new Set();
            holdersForRoot.add(rootHolder);
            roots.set(source, holdersForRoot);
            await this.walkFunding(source, depth + 1, rootHolder, edges, nodes, roots, timeline);
        }
    }
    extractTokenEvents(record, owner, mint, tips, edges, timeline, nodes) {
        const transaction = record.transaction;
        const amount = tokenDelta(transaction, mint, owner);
        if (amount === 0n)
            return;
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
    calculateMetrics(timeline, edges, supplyRaw, fundingRoots) {
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
        const destinations = new Map();
        for (const edge of edges.filter((edge) => edge.kind === 'token_sell'))
            destinations.set(edge.to, (destinations.get(edge.to) ?? 0) + 1);
        const jitoBySlot = new Map();
        for (const buy of buys.filter((event) => event.hasJitoTip)) {
            const byOwner = jitoBySlot.get(buy.slot) ?? new Map();
            byOwner.set(buy.owner, buy);
            jitoBySlot.set(buy.slot, byOwner);
        }
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
    buildPhases(timeline, metrics) {
        const funding = timeline.filter((event) => event.kind === 'funding');
        const buys = timeline.filter((event) => event.kind === 'buy');
        const sells = timeline.filter((event) => event.kind === 'sell');
        const phase = (name, events, evidence) => ({ phase: name, firstSlot: events.length ? Math.min(...events.map((event) => event.slot)) : null, lastSlot: events.length ? Math.max(...events.map((event) => event.slot)) : null, eventCount: events.length, evidence });
        return [phase('funding', funding, funding.length ? 'observed' : 'unknown'), phase('bundle_buy', buys.filter((event) => event.hasJitoTip), metrics.jito.isConfirmedJitoBundle ? 'observed' : 'unknown'), phase('holding', buys, buys.length ? 'inferred' : 'unknown'), phase('synchronized_sell', sells, metrics.synchronizedSelling ? 'observed' : 'unknown'), phase('profit_extraction', sells.filter((event) => event.counterparties.length > 0), sells.length ? 'inferred' : 'unknown')];
    }
}
