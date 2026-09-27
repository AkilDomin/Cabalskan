import { Connection, PublicKey } from '@solana/web3.js';
import { getMint, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import type { Address, DexVenue, LiquiditySecurityResult, TokenSecurityMetrics } from './types.js';

const INCINERATOR = '1nc1nerator11111111111111111111111111111111';

export interface LiquidityCandidate {
  venue: DexVenue;
  poolAddress: Address;
  lpMint?: Address;
  creatorAddress?: Address;
  lockerAddresses?: Address[];
}

export interface TokenSecurityOptions {
  liquidityCandidates?: LiquidityCandidate[];
}

async function classifyLP(connection: Connection, candidate: LiquidityCandidate): Promise<LiquiditySecurityResult> {
  const evidence: string[] = [];
  if (!candidate.lpMint) return { venue: candidate.venue, poolAddress: candidate.poolAddress, lpMint: null, status: 'unknown', lpBalanceRaw: null, evidence: ['LP mint was not provided; a pool address alone cannot prove burn or lock.'] };
  const lpMint = new PublicKey(candidate.lpMint);
  const supply = await connection.getTokenSupply(lpMint);
  const topAccounts = await connection.getTokenLargestAccounts(lpMint);
  if (supply.value.amount === '0') return { venue: candidate.venue, poolAddress: candidate.poolAddress, lpMint: candidate.lpMint, status: 'burned', lpBalanceRaw: '0', evidence: ['LP token supply is zero.'] };
  let poolBalance = 0n;
  let creatorBalance = 0n;
  let lockerBalance = 0n;
  const lockers = new Set([...(candidate.lockerAddresses ?? []), INCINERATOR]);
  for (const account of topAccounts.value) {
    const parsed = await connection.getParsedAccountInfo(account.address);
    const data = parsed.value?.data;
    if (!data || typeof data !== 'object' || !('parsed' in data)) continue;
    const parsedInfo = (data as { parsed?: { info?: { owner?: string; tokenAmount?: { amount?: string } } } }).parsed?.info;
    const owner = parsedInfo?.owner;
    const amount = BigInt(parsedInfo?.tokenAmount?.amount ?? account.amount);
    if (owner === candidate.poolAddress) poolBalance += amount;
    if (owner === candidate.creatorAddress) creatorBalance += amount;
    if (owner && lockers.has(owner)) lockerBalance += amount;
  }
  if (lockerBalance > 0n) {
    evidence.push(`LP tokens found on locker/incinerator: ${lockerBalance.toString()}.`);
    return { venue: candidate.venue, poolAddress: candidate.poolAddress, lpMint: candidate.lpMint, status: 'locked', lpBalanceRaw: lockerBalance.toString(), evidence };
  }
  if (creatorBalance > 0n) {
    evidence.push(`LP tokens remain on the creator address: ${creatorBalance.toString()}.`);
    return { venue: candidate.venue, poolAddress: candidate.poolAddress, lpMint: candidate.lpMint, status: 'unlocked', lpBalanceRaw: creatorBalance.toString(), evidence };
  }
  if (poolBalance > 0n) evidence.push(`LP tokens found on the pool token account: ${poolBalance.toString()}.`);
  evidence.push('No automatically verified locker or burn was found.');
  return { venue: candidate.venue, poolAddress: candidate.poolAddress, lpMint: candidate.lpMint, status: 'unknown', lpBalanceRaw: poolBalance > 0n ? poolBalance.toString() : null, evidence };
}

export async function checkTokenSecurityMetrics(connection: Connection, mintAddress: string, options: TokenSecurityOptions = {}): Promise<TokenSecurityMetrics> {
  const mint = new PublicKey(mintAddress);
  const mintAccount = await getMint(connection, mint, 'confirmed', TOKEN_PROGRAM_ID);
  const liquidity = await Promise.all((options.liquidityCandidates ?? []).map((candidate) => classifyLP(connection, candidate)));
  const evidence: string[] = [
    mintAccount.mintAuthority === null ? 'Mint authority is disabled.' : `Mint authority is active: ${mintAccount.mintAuthority.toBase58()}.`,
    mintAccount.freezeAuthority === null ? 'Freeze authority is disabled.' : `Freeze authority is active: ${mintAccount.freezeAuthority.toBase58()}.`,
  ];
  const limitations: string[] = [
    'LP verification requires a detected pool address and LP mint; no candidate does not mean no liquidity.',
    'Burn and lock are different mechanisms. SPL burn reduces supply, while a locker holds LP tokens separately.',
    'An unknown locker is not automatically classified as safe.',
  ];
  return { mint: mintAddress, mintAuthority: mintAccount.mintAuthority?.toBase58() ?? null, freezeAuthority: mintAccount.freezeAuthority?.toBase58() ?? null, mintAuthorityRevoked: mintAccount.mintAuthority === null, freezeAuthorityRevoked: mintAccount.freezeAuthority === null, liquidity, evidence, limitations };
}
