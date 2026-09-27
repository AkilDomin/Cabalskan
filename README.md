# CabalScan

CabalScan is an explainable Solana forensic preview for detecting coordinated wallet activity around token launches.

## Local development

```powershell
npm install
npm run build
npm start
```

Open `http://localhost:8765`. The local server is `local-server.mjs`; Vercel uses the serverless route in `api/live-scan.mjs`.

## Vercel deployment

The project uses a Vercel serverless route at `/api/live-scan`. Configure these environment variables in the Vercel project settings:

```text
HELIUS_API_KEYS=key_one,key_two
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini
NODE_ENV=production
```

Do not commit `.env`, API keys, credentials files, or `core-ts/node_modules`.

The production endpoint is:

```text
/api/live-scan?mint=<MINT>&depth=quick|standard|deep
```

Optional historical cutoff:

```text
/api/live-scan?mint=<MINT>&depth=standard&scanAtSlot=<SLOT>
```

QUICK can fall back to the public Solana RPC when Helius is rate-limited. STANDARD and DEEP require Helius because they inspect indexed transaction history.

## Scope and limitations

The result is a forensic risk preview, not proof that a token is safe or fraudulent. Current balances are not historical balances, IP addresses are not present in Solana transaction data, and unknown liquidity status remains unknown.
