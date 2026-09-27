export type Address = string;
export type Evidence = 'observed' | 'inferred' | 'unknown';
export interface Holder { owner: Address; tokenAccount: Address; rawAmount: bigint; decimals: number; rank: number; }
export interface GraphNode { address: Address; kind: 'holder' | 'funding' | 'pool' | 'destination' | 'unknown'; }
export interface GraphEdge { from: Address; to: Address; kind: 'funding' | 'token_buy' | 'token_sell' | 'profit_extraction'; signature: string; slot: number; blockTime: number | null; amountRaw?: bigint; evidence: Evidence; fundingDepth?: number; }
export interface TimelineEvent { owner: Address; kind: 'funding' | 'buy' | 'sell'; signature: string; slot: number; blockTime: number | null; amountRaw: bigint; counterparties: Address[]; hasJitoTip?: boolean; venues?: DexClassification[]; }
export type DexVenue = 'raydium_amm_v4' | 'raydium_cpmm' | 'raydium_clmm' | 'raydium_route' | 'meteora_dlmm' | 'meteora_damm_v1' | 'meteora_damm_v2' | 'orca_whirlpool' | 'jupiter_v6' | 'unknown';
export interface DexClassification { venue: DexVenue; programId: Address; confidence: 'high' | 'medium'; instructionCount: number; }
export interface TokenSecurityMetrics { mint: Address; mintAuthority: Address | null; freezeAuthority: Address | null; mintAuthorityRevoked: boolean; freezeAuthorityRevoked: boolean; liquidity: LiquiditySecurityResult[]; evidence: string[]; limitations: string[]; }
export interface LiquiditySecurityResult { venue: DexVenue; poolAddress: Address | null; lpMint: Address | null; status: 'burned' | 'locked' | 'unlocked' | 'unknown'; lpBalanceRaw: string | null; evidence: string[]; }
export interface AIVerdict { riskLevel: 'high' | 'medium' | 'low' | 'unknown'; summary: string; evidence: string[]; uncertainties: string[]; model: string; }
export interface TimelinePhase { phase: 'funding' | 'bundle_buy' | 'holding' | 'synchronized_sell' | 'profit_extraction'; firstSlot: number | null; lastSlot: number | null; eventCount: number; evidence: Evidence; }
export interface JitoBundleEvidence { isConfirmedJitoBundle: boolean; slots: number[]; qualifyingWalletCount: number; qualifyingSignatures: string[]; reason: string; }
export interface ForensicMetrics { totalGroupHoldingPercent: number | null; totalGroupSoldPercent: number | null; synchronizedSelling: boolean | null; synchronizedBuyCluster: boolean | null; commonFundingSources: Array<{ address: Address; holderCount: number; maxHops: number }>; commonProfitDestinations: Array<{ address: Address; eventCount: number }>; buySlotSpread: number | null; sellSlotSpread: number | null; jito: JitoBundleEvidence; }
export interface ForensicGraph { mint: Address; nodes: GraphNode[]; edges: GraphEdge[]; timeline: TimelineEvent[]; phases: TimelinePhase[]; metrics: ForensicMetrics; limitations: string[]; }
export interface AnalyzerOptions { maxHops?: number; signaturesPerHolder?: number; buyClusterMaxSlots?: number; sellClusterMaxSlots?: number; jitoMinimumWallets?: number; concurrency?: number; minIntervalMs?: number; maxFundingNodes?: number; minimumTransferLamports?: number; maxSlot?: number; }
