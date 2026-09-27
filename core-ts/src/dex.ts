import { PublicKey, type ParsedInstruction, type PartiallyDecodedInstruction, type ParsedTransactionWithMeta } from '@solana/web3.js';
import { allInstructions } from './module1.js';
import type { DexClassification, DexVenue } from './types.js';

export const DEX_PROGRAM_IDS: Readonly<Record<DexVenue, string>> = {
  raydium_amm_v4: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  raydium_cpmm: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  raydium_clmm: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  raydium_route: 'routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS',
  meteora_dlmm: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
  meteora_damm_v1: 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB',
  meteora_damm_v2: 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',
  orca_whirlpool: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  jupiter_v6: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  unknown: '',
};

const venueByProgram = new Map(Object.entries(DEX_PROGRAM_IDS).filter(([, id]) => id).map(([venue, id]) => [id, venue as DexVenue]));

function instructionProgramId(instruction: ParsedInstruction | PartiallyDecodedInstruction): string {
  return instruction.programId.toBase58();
}

export function classifyProgram(programId: string): DexVenue {
  return venueByProgram.get(programId) ?? 'unknown';
}

export function classifyTransaction(transaction: ParsedTransactionWithMeta): DexClassification[] {
  const counts = new Map<string, number>();
  for (const instruction of allInstructions(transaction)) {
    const programId = instructionProgramId(instruction);
    counts.set(programId, (counts.get(programId) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([programId, instructionCount]) => ({ programId, venue: classifyProgram(programId), instructionCount, confidence: venueByProgram.has(programId) ? 'high' as const : 'medium' as const }))
    .filter((item) => item.venue !== 'unknown')
    .sort((a, b) => b.instructionCount - a.instructionCount);
}

export function classifyTransactionPrograms(transaction: ParsedTransactionWithMeta): Set<string> {
  return new Set(allInstructions(transaction).map(instructionProgramId));
}

export function dexProgramId(venue: DexVenue): PublicKey | null {
  const value = DEX_PROGRAM_IDS[venue];
  return value ? new PublicKey(value) : null;
}
