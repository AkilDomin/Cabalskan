import { PublicKey } from '@solana/web3.js';
const JITO_TIP_ENDPOINT = 'https://mainnet.block-engine.jito.wtf/api/v1/getTipAccounts';
const TIP_CACHE_TTL_MS = 5 * 60 * 1000;
let cachedTips = null;
export function parsedInstructionInfo(instruction) {
    if (!('parsed' in instruction) || typeof instruction.parsed !== 'object' || instruction.parsed === null)
        return null;
    return instruction.parsed.info ?? null;
}
export function allInstructions(transaction) {
    return [
        ...transaction.transaction.message.instructions,
        ...(transaction.meta?.innerInstructions ?? []).flatMap((group) => group.instructions),
    ];
}
export async function getJitoTipAccounts(forceRefresh = false) {
    if (!forceRefresh && cachedTips && cachedTips.expiresAt > Date.now())
        return cachedTips.accounts;
    const configured = new Set((process.env.JITO_TIP_ACCOUNTS ?? '').split(',').map((value) => value.trim()).filter(Boolean));
    try {
        const response = await fetch(JITO_TIP_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTipAccounts', params: [] }),
        });
        if (response.ok) {
            const body = await response.json();
            for (const account of body.result ?? [])
                configured.add(account);
        }
    }
    catch {
        // The environment list remains a valid offline fallback.
    }
    cachedTips = { expiresAt: Date.now() + TIP_CACHE_TTL_MS, accounts: configured };
    return configured;
}
export function transactionHasJitoTip(transaction, tipAccounts) {
    return allInstructions(transaction).some((instruction) => {
        const info = parsedInstructionInfo(instruction);
        if (!info || !('program' in instruction) || instruction.program !== 'system' || info.type !== 'transfer')
            return false;
        const destination = info.destination;
        const lamports = info.lamports;
        return typeof destination === 'string' && typeof lamports === 'number' && lamports > 0 && tipAccounts.has(destination);
    });
}
/** A positive result is Jito-tip evidence, not proof of bundle membership by itself. */
export async function verifyJitoBundle(connection, txSignature) {
    const transaction = await connection.getParsedTransaction(txSignature, { maxSupportedTransactionVersion: 1 });
    if (!transaction)
        return false;
    return transactionHasJitoTip(transaction, await getJitoTipAccounts());
}
export async function fetchTokenHoldersExtended(connection, mintAddress, limit = 100, apiKeyOverride) {
    const mint = new PublicKey(mintAddress);
    const apiKey = apiKeyOverride ?? process.env.HELIUS_API_KEY;
    if (apiKey && connection.rpcEndpoint.includes('helius')) {
        const endpoint = connection.rpcEndpoint.includes('api-key=')
            ? connection.rpcEndpoint
            : `${connection.rpcEndpoint}${connection.rpcEndpoint.includes('?') ? '&' : '?'}api-key=${encodeURIComponent(apiKey)}`;
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenAccounts', params: { page: 1, limit, mint: mint.toBase58(), displayOptions: {} } }),
        });
        if (!response.ok)
            throw new Error(`Helius getTokenAccounts HTTP ${response.status}`);
        const body = await response.json();
        if (body.error)
            throw new Error(body.error.message ?? 'Helius getTokenAccounts failed');
        return (body.result?.token_accounts ?? []).flatMap((account, index) => {
            const rawAmount = account.amount ?? account.token_amount?.amount;
            if (!account.owner || !account.address || !rawAmount)
                return [];
            return [{ owner: account.owner, tokenAccount: account.address, rawAmount: BigInt(rawAmount), decimals: account.token_amount?.decimals ?? 0, rank: index + 1 }];
        });
    }
    const largest = await connection.getTokenLargestAccounts(mint);
    return largest.value.slice(0, limit).map((account, index) => ({ owner: account.address.toBase58(), tokenAccount: account.address.toBase58(), rawAmount: BigInt(account.amount), decimals: account.decimals, rank: index + 1 }));
}
