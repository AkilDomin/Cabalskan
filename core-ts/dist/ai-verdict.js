const SYSTEM_PROMPT = `You are CabalScan's forensic risk narrator for Solana token analysis.\n\nYour job is to translate only the supplied on-chain evidence into a short, cautious verdict for a beginner. Never call a token a scam as a fact. Never invent wallet ownership, IP addresses, bundle IDs, liquidity locks, or transactions. Distinguish observed evidence from inference and unknowns. An active mint or freeze authority is a security risk, not proof of fraud. A Jito tip is not by itself a rug proof; a confirmed bundle means the supplied threshold of same-slot buys with Jito tips was met. Unknown LP status must remain unknown.\n\nReturn JSON only with exactly these fields:\n{\n  "riskLevel": "high" | "medium" | "low" | "unknown",\n  "summary": string,\n  "evidence": string[],\n  "uncertainties": string[]\n}\n\nRules: summary must be 1-2 sentences in English and under 400 characters; evidence has 2-5 concrete items; uncertainties has 1-4 concrete limitations. If evidence conflicts, choose the safer uncertainty-aware level. Do not provide trading advice or a guaranteed safety claim.`;
export function generateRuleBasedVerdict(report, riskScore) {
    const evidence = [];
    const uncertainties = ['This is an analysis of a limited on-chain sample, not a guarantee of safety or profitability.'];
    if (report.graph.commonFundingSources.length > 0)
        evidence.push(`Shared funding sources were found across ${report.graph.commonFundingSources.reduce((sum, item) => sum + item.holderCount, 0)} holder links.`);
    if (report.graph.jito.isConfirmedJitoBundle)
        evidence.push(`Same-slot Jito bundle evidence was detected for ${report.graph.jito.qualifyingWalletCount} wallets.`);
    if (report.graph.synchronizedBuyCluster)
        evidence.push('Group purchases occurred within a narrow slot/time window.');
    if (report.graph.synchronizedSelling)
        evidence.push('Group sales occurred synchronously.');
    if (report.security.mintAuthority !== null)
        evidence.push('Mint authority is still active.');
    if (report.security.freezeAuthority !== null)
        evidence.push('Freeze authority is still active.');
    const unknownLiquidity = report.security.liquidity.filter((item) => item.status === 'unknown').length;
    if (unknownLiquidity > 0 || report.security.liquidity.length === 0)
        uncertainties.push('Liquidity status was not fully verified for every detected pool.');
    if (riskScore > 70)
        return { riskLevel: 'high', summary: 'High risk of a coordinated group or dump: multiple strong on-chain signals were detected. Manually review source transactions and liquidity before taking action.', evidence: evidence.length ? evidence.slice(0, 5) : ['Risk score is above 70 under the available rules.'], uncertainties, model: 'local-rule-engine' };
    if (riskScore >= 30)
        return { riskLevel: 'medium', summary: 'Moderate suspicious connections were detected. This does not prove fraud, but the token needs additional review of funding, buys, sells, and liquidity.', evidence: evidence.length ? evidence.slice(0, 5) : ['Risk score is in the medium range.'], uncertainties, model: 'local-rule-engine' };
    return { riskLevel: 'low', summary: 'No strong anomalies were found in the available sample. This lowers the observed risk, but does not prove safety or profitability.', evidence: evidence.length ? evidence.slice(0, 5) : ['No strong risk rules were triggered.'], uncertainties, model: 'local-rule-engine' };
}
function validResponse(value, model) {
    if (!value || typeof value !== 'object')
        throw new Error('AI response is not an object');
    const candidate = value;
    const levels = new Set(['high', 'medium', 'low', 'unknown']);
    if (typeof candidate.riskLevel !== 'string' || !levels.has(candidate.riskLevel))
        throw new Error('AI response has invalid riskLevel');
    if (typeof candidate.summary !== 'string' || candidate.summary.length === 0 || candidate.summary.length > 400)
        throw new Error('AI response has invalid summary');
    if (!Array.isArray(candidate.evidence) || !candidate.evidence.every((item) => typeof item === 'string'))
        throw new Error('AI response has invalid evidence');
    if (!Array.isArray(candidate.uncertainties) || !candidate.uncertainties.every((item) => typeof item === 'string'))
        throw new Error('AI response has invalid uncertainties');
    return { riskLevel: candidate.riskLevel, summary: candidate.summary, evidence: candidate.evidence, uncertainties: candidate.uncertainties, model };
}
export async function generateAIVerdict(report, options = {}) {
    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey)
        throw new Error('OPENAI_API_KEY is not configured.');
    const model = options.model ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
    const endpoint = options.endpoint ?? 'https://api.openai.com/v1/chat/completions';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
    try {
        const response = await fetch(endpoint, { method: 'POST', signal: controller.signal, headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, temperature: 0.1, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: JSON.stringify(report) }] }) });
        const body = await response.json();
        if (!response.ok)
            throw new Error(body.error?.message ?? `OpenAI HTTP ${response.status}`);
        const content = body.choices?.[0]?.message?.content;
        if (!content)
            throw new Error('OpenAI returned an empty verdict.');
        return validResponse(JSON.parse(content), model);
    }
    finally {
        clearTimeout(timeout);
    }
}
