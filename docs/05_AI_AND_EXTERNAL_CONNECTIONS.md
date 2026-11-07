# 5. AI & External Connections

## AI / LLM

| Item | Value |
|---|---|
| Endpoint | `https://apps.abacus.ai/v1/chat/completions` (OpenAI-compatible Chat Completions) |
| Auth | `Authorization: Bearer $ABACUSAI_API_KEY` |
| Model | `gpt-5.4-mini` (string in each research file) |
| Typical params | `max_tokens` ≈ 1100, JSON-style answer parsed by the caller |

Where it is called:

| File | Purpose |
|---|---|
| `lib/score-research.ts` (~line 158) | Kalshi correct-score research: probability per scoreline, blended with Poisson + market |
| `lib/polymarket-score-research.ts` (~line 189) | Same for Polymarket correct-score markets |
| `lib/goals-research.ts` (~line 180) | Goals (O/U, BTTS) research |
| `lib/shadow-analyst.ts` | Shadow AI analyst (job B); calls `researchGoalsMatch` from goals-research (no separate endpoint); paper-only picks graded vs. results |

Prompts are enriched with `getExternalConsensus` (API-Football/FootyStats predictions + their measured hit
rates from the `Calibration` data). If the LLM call fails or credits run out, code falls back to the market-implied
Poisson model, so the app keeps working with lower-quality probabilities.

### Switching AI provider

1. Change the URL string in each file above (e.g. `https://api.openai.com/v1/chat/completions`).
2. Change the env var read for the key (e.g. `OPENAI_API_KEY`) and add it to `.env`.
3. Change the model string (`gpt-4o-mini`, etc.). Keep the response-parsing code; it expects `choices[0].message.content`.
4. Tip: grep for `apps.abacus.ai` and `gpt-5.4-mini` to find every occurrence.

Regenerating the Abacus key: https://apps.abacus.ai/chatllm/admin/api-keys, then update `.env` and redeploy.

## External data / trading APIs

| Service | Base URL | Key | Used in | Limits / notes |
|---|---|---|---|---|
| **Kalshi** (trading) | prod `https://api.elections.kalshi.com/trade-api/v2`, demo `https://demo-api.kalshi.co/trade-api/v2` | Key ID + RSA private key, entered on **Settings** page (DB `ApiCredential`) | `lib/kalshi-api.ts` | Requests signed RSA-PSS/SHA-256 over `timestamp + METHOD + path`; headers `KALSHI-ACCESS-KEY`, `KALSHI-ACCESS-TIMESTAMP`, `KALSHI-ACCESS-SIGNATURE`. Generate keys at kalshi.com → Account → API Keys. Demo keys are separate from prod keys. |
| **National Weather Service** | `https://api.weather.gov`, `forecast.weather.gov` CF6/CLI products | none (User-Agent recommended) | `lib/nws-api.ts`, `lib/nws-climate.ts` | Forecasts for weather markets; CF6/CLI for settlement verification. |
| **API-Football** (api-sports) | `https://v3.football.api-sports.io` | `API_FOOTBALL_KEY` (header `x-apisports-key`) | `lib/api-football.ts`, `lib/low-scoring-consensus.ts`, predictions settle | Pro plan 7,500/day. Throttled to ~3 req/s (`MIN_REQUEST_GAP_MS=350`) with backoff on 429/"suspended". Team search accepts only letters/digits/spaces (code normalizes). |
| **FootyStats** | `https://api.football-data-api.com` | `FOOTYSTATS_API_KEY` | `lib/value-tracker.ts`, `lib/external-predictions.ts` | Returns only matches from leagues selected **on the FootyStats website — select no more than 50 leagues.** `/todays-matches`, `/match?match_id=`. |
| **The Odds API** | `https://api.the-odds-api.com/v4` | `THE_ODDS_API_KEY` | `lib/odds-api.ts` | Optional sharp-book totals/BTTS, de-vigged. Monthly credit quota. |
| **Polymarket Gamma** | `https://gamma-api.polymarket.com` | none | `lib/polymarket-api.ts`, `lib/polymarket-goals.ts` | Market discovery. |
| **Polymarket CLOB V2** | `https://clob.polymarket.com` | `POLYMARKET_PRIVATE_KEY` + DB `PolymarketConfig` | `lib/polymarket-api.ts` (`@polymarket/clob-client-v2`, `ethers`) | Polygon chain 137. L2 API creds derived at runtime from the private key. |

### Polymarket wallet setup

- `signatureType` (Settings → Polymarket): 0 = plain EOA, 1 = Magic/email proxy, 2 = Gnosis Safe, **3 = POLY_1271 deposit wallet (current)**.
- `funderAddress` = the Polymarket deposit/proxy wallet holding USDC (currently `0x2f5F…eBf8e`); signer = address of `POLYMARKET_PRIVATE_KEY` (currently `0xa7dA…BD47`).
- To change wallets: export the new signer private key, put it in `.env`, update signatureType + funder in Settings, redeploy, then place a tiny test order with paperMode off.
- Paper mode needs no key at all.

### Rotating any key

1. Generate the new key in the provider dashboard.
2. Update `.env` (or Settings page for Kalshi/Polymarket config).
3. Redeploy / restart (`pm2 restart dutchbetting`). Env vars are read at process start.
4. Verify: run the related page refresh or call the scheduled endpoint once with curl (doc 04).

## Database

PostgreSQL via Prisma (`DATABASE_URL`). Abacus hosting uses a managed database shared by preview and production.
Limits there: ~25 connections, 5 s statement timeout. The code uses one shared Prisma client (`lib/db.ts`).
