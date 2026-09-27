import { Connection, PublicKey, type ParsedInstruction, type PartiallyDecodedInstruction, type ParsedTransactionWithMeta } from '@solana/web3.js';
import type { Address, Holder } from './types.js';

const JITO_TIP_ENDPOINT = 'https://mainnet.block-engine.jito.wtf/api/v1/getTipAccounts';
const TIP_CACHE_TTL_MS = 5 * 60 * 1000;
let cachedTips: { expiresAt: number; accounts: Set<Address> } | null = null;

interface HeliusTokenAccount { address?: string; owner?: string; amount?: string; token_amount?: { amount?: string; decimals?: number }; }

export function parsedInstructionInfo(instruction: ParsedInstruction | PartiallyDecodedInstruction): Record<string, unknown> | null {
  if (!('parsed' in instruction) || typeof instruction.parsed !== 'object' || instruction.parsed === null) return null;
  return (instruction.parsed as { info?: Record<string, unknown> }).info ?? null;
}

export function allInstructions(transaction: ParsedTransactionWithMeta): Array<ParsedInstruction | PartiallyDecodedInstruction> {
  return [
    ...transaction.transaction.message.instructions,
    ...(transaction.meta?.innerInstructions ?? []).flatMap((group) => group.instructions),
  ];
}

export async function getJitoTipAccounts(forceRefresh = false): Promise<Set<Address>> {
  if (!forceRefresh && cachedTips && cachedTips.expiresAt > Date.now()) return cachedTips.accounts;
  const configured = new Set((process.env.JITO_TIP_ACCOUNTS ?? '').split(',').map((value) => value.trim()).filter(Boolean));
  try {
    const response = await fetch(JITO_TIP_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTipAccounts', params: [] }),
    });
    if (response.ok) {
      const body = await response.json() as { result?: string[] };
      for (const account of body.result ?? []) configured.add(account);
    }
  } catch {
    // The environment list remains a valid offline fallback.
  }
  cachedTips = { expiresAt: Date.now() + TIP_CACHE_TTL_MS, accounts: configured };
  return configured;
}

export function transactionHasJitoTip(transaction: ParsedTransactionWithMeta, tipAccounts: Set<Address>): boolean {
  return allInstructions(transaction).some((instruction) => {
    const info = parsedInstructionInfo(instruction);
    if (!info || !('program' in instruction) || instruction.program !== 'system' || info.type !== 'transfer') return false;
    const destination = info.destination;
    const lamports = info.lamports;
    return typeof destination === 'string' && typeof lamports === 'number' && lamports > 0 && tipAccounts.has(destination);
  });
}

/** A positive result is Jito-tip evidence, not proof of bundle membership by itself. */
export async function verifyJitoBundle(connection: Connection, txSignature: string): Promise<boolean> {
  const transaction = await connection.getParsedTransaction(txSignature, { maxSupportedTransactionVersion: 0 });
  if (!transaction) return false;
  return transactionHasJitoTip(transaction, await getJitoTipAccounts());
}

export async function fetchTokenHoldersExtended(connection: Connection, mintAddress: string, limit = 100, apiKeyOverride?: string): Promise<Holder[]> {
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
    if (!response.ok) throw new Error(`Helius getTokenAccounts HTTP ${response.status}`);
    const body = await response.json() as { result?: { token_accounts?: HeliusTokenAccount[] }; error?: { message?: string } };
    if (body.error) throw new Error(body.error.message ?? 'Helius getTokenAccounts failed');
    return (body.result?.token_accounts ?? []).flatMap((account, index): Holder[] => {
      const rawAmount = account.amount ?? account.token_amount?.amount;
      if (!account.owner || !account.address || !rawAmount) return [];
      return [{ owner: account.owner, tokenAccount: account.address, rawAmount: BigInt(rawAmount), decimals: account.token_amount?.decimals ?? 0, rank: index + 1 }];
    });
  }
  const largest = await connection.getTokenLargestAccounts(mint);
  return largest.value.slice(0, limit).map((account, index) => ({ owner: account.address.toBase58(), tokenAccount: account.address.toBase58(), rawAmount: BigInt(account.amount), decimals: account.decimals, rank: index + 1 }));
}
