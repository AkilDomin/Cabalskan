# CabalScan architecture

## Runtime layers

- `index.html`, `styles.css`, `app.js` — browser UI. It never receives the Helius key.
- `server.mjs` — small HTTP/API gateway and static-file server.
- `lib/helius.mjs` — credentials lookup, RPC transport and bounded retry on rate limits.
- `lib/forensics.mjs` — transaction-level observations for owners, acquisitions, sales and destinations.
- `lib/scan.mjs` — scan orchestration and explainable risk signals.
- future `on-chain/` — optional Solana/Anchor program only for publishing signed attestations or reputation data; it is not needed for private indexing.

## Scan modes

`GET /api/live-scan?mint=<MINT>&depth=quick|standard|deep`

- `quick`: supply and first 1000 token accounts; fastest response, no transaction history.
- `standard`: five largest owners and up to eight recent transactions per owner.
- `deep`: twenty largest owners and up to sixteen recent transactions per owner; slower and more expensive in RPC credits.

The UI should call `standard` for the first useful result and offer `deep` only after the user asks for stronger evidence. Unknown or missing data remains unknown; different exit addresses are not treated as proof of safety.

## Solana boundary

The indexer should stay off-chain because it needs historical RPC queries and private API credentials. A Solana program can be added later for a compact, verifiable report hash or public attestation, but putting the forensic scan itself on-chain would increase cost and reduce speed.
