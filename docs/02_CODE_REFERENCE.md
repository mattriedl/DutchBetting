# 2. Code Reference

Stack: React/TypeScript web app (Next.js 14 App Router), Prisma ORM on PostgreSQL, NextAuth (credentials +
JWT), Tailwind + shadcn/ui components, Recharts/Chart.js/Plotly charts. Package manager: **Yarn 4 via Corepack** (`corepack enable` once; see `packageManager` in package.json).

## Directory layout

```
app/
  layout.tsx, providers.tsx, page.tsx      root layout, session/theme providers, landing redirect
  login/                                   login page
  (authenticated)/<page>/page.tsx          each sidebar page; UI lives in _components/*-content.tsx
  api/<area>/<action>/route.ts             server API routes
components/                                sidebar, header, calibration panel, ui/ (shadcn)
lib/                                       all business logic + external API clients
prisma/schema.prisma                       database schema
scripts/seed.ts, safe-seed.ts              create the test user (upsert, no deletes)
scripts/direct-ingest.ts                   run External Predictions ingest from the command line
middleware.ts                              login redirect for protected pages
```

## lib/ modules

| File | Purpose |
|---|---|
| `db.ts` | Shared Prisma client (one instance per process). |
| `auth-options.ts` | NextAuth config: credentials provider (bcrypt), JWT sessions, `/login` page. |
| `automation-auth.ts` | `authorizeCaller(req)`: accepts a browser session OR header `x-automation-secret` = `AUTOMATION_SECRET`. Automated calls act as `AUTOMATION_USER_EMAIL`. |
| `kalshi-api.ts` | Kalshi REST client (prod `api.elections.kalshi.com`, demo `demo-api.kalshi.co`), RSA-PSS request signing, climate tickers, market parsing. |
| `nws-api.ts`, `nws-climate.ts` | NWS forecasts and climate history per city. |
| `dutch-betting.ts` | Dutch stake allocation, viability, rating, edge-case flags. |
| `market-timing.ts` | Whether a temperature market is still bettable today. |
| `soccer-dutch.ts` | Kalshi soccer match-result series and favourite+draw Dutch logic. |
| `correct-score.ts` | Kalshi correct-score discovery (`SCORE_SERIES`), basket analysis, edge gate. |
| `polymarket-api.ts` | Polymarket Gamma (discovery) + CLOB V2 (orders, balance/allowance, resolutions). |
| `polymarket-correct-score.ts` | Polymarket exact-score basket analysis. |
| `polymarket-goals.ts` | Polymarket totals/BTTS discovery, untraded-price guard, resolutions. |
| `goals-markets.ts` | Kalshi goals leagues (`GOALS_LEAGUES`), analyzeGoals, priceGoalsSide, stake calc. |
| `score-research.ts` | Kalshi correct-score research (LLM + Dixon-Coles + live data). |
| `polymarket-score-research.ts` | Same engine for Polymarket. |
| `goals-research.ts` | Goals research: LLM xG, Poisson grid, market + sharp blend, calibration. |
| `low-scoring-consensus.ts` | 0–100 low-scoring score from API-Football stats, H2H, predictions, sharp odds. |
| `api-football.ts` | API-Football client: throttled (350 ms gap) with rate-limit retry, team resolution, form/H2H/injuries, predictions, final scores by fixture ID or teams. |
| `odds-api.ts` | the-odds-api.com de-vigged totals/BTTS (30 min cache). |
| `external-predictions.ts` | Predictions ingest/settle/accuracy/consensus. |
| `value-tracker.ts` | Value Tracker model, ingest, settle, stats. |
| `shadow-analyst.ts` | AI Shadow Tracker run/settle. |
| `calibration.ts` | Compute/store/apply calibration. |
| `resolve-predictions.ts` | Resolves weather predictions. |
| `odds-format.ts`, `utils.ts`, `types.ts` | Helpers. |

## API routes (all under `/api`)

All routes need a signed-in session unless marked **(automation OK)**. Those also accept the
`x-automation-secret` header.

| Area | Routes |
|---|---|
| Auth | `auth/[...nextauth]`, `signup` |
| Weather | `refresh` (POST pull markets+forecasts), `markets`, `forecasts`, `opportunities`, `analysis`, `bets`, `history`, `history/re-resolve`, `backtest`, `tracker` |
| Settings | `config` (Kalshi credentials), `config/test`, `preferences` |
| Auto-bet (weather) | `auto-bet/config`, `auto-bet/place`, `auto-bet/orders`, `auto-bet/settle` |
| Soccer | `soccer/markets`, `soccer/place`, `soccer/orders`, `soccer/settle` |
| Correct score | `correct-score/{config,markets,research,consensus,place,orders,settle}` |
| Polymarket score | `polymarket-cs/{config,markets,research,balance,place,orders,settle}` |
| Goals | `goals/{config,markets,research,reprice,place,orders,settle}` (`markets?source=kalshi|polymarket|both`) |
| AI tracker | `shadow` (GET stats), `shadow/run` **(automation OK)**, `shadow/settle` **(automation OK)** |
| Predictions | `external-predictions` (GET), `external-predictions/ingest` **(automation OK)**, `external-predictions/settle` **(automation OK)** |
| Value tracker | `value-tracker/run` **(automation OK)**, `value-tracker/settle` **(automation OK)**, `value-tracker/stats` (GET `?status&market&model&limit`) |
| Calibration | `calibration` (GET), `calibration/recompute` **(automation OK)** |

Long-running routes declare `export const maxDuration = 300`. Routes that read the request/runtime
environment declare `export const dynamic = 'force-dynamic'`.

## Database models (prisma/schema.prisma)

| Model | Holds |
|---|---|
| User, Account, Session, VerificationToken | Login (NextAuth). `User.role` defaults to "user". |
| ApiCredential | Kalshi key ID, RSA private key, environment (demo/production), validity. |
| UserPreference | Odds display format (shares / payout / american). |
| MarketData, NwsForecast, Opportunity, BetPlacement, PredictionHistory, DutchBetTrack | Weather markets, forecasts, opportunities, bets, history. |
| BacktestEvent, BacktestResult | Weather backtests. |
| AutoBetConfig, AutoBetOrder | Weather auto-bet settings and orders (also drives Soccer demo/production env). |
| SoccerBetOrder | Kalshi soccer Dutch orders. |
| CorrectScoreConfig, CorrectScoreBetOrder | Kalshi correct-score settings/baskets (`paperMode`, `isPaper`, `finalScore`, `minEdgeCents`, `minLowScore`, `minPicks`). |
| PolymarketConfig, PolymarketBetOrder | Polymarket settings (wallet `signatureType`, `funderAddress`, `paperMode`) and baskets. |
| GoalsMarketConfig, GoalsBetOrder | Goals settings and bets (`source` kalshi/polymarket). |
| ModelCalibration | Learned calibration snapshots (`isActive`, xgBias, probSlope/probIntercept, Brier...). |
| ShadowPick | AI Tracker picks (unique app+matchKey). |
| ExternalPrediction | Predictions (unique source+matchKey+market; `rawPayload` JSON has fixtureId, teamAIsHome). |
| ValuePick | Value Tracker picks (unique `selKey`; status open/settled/void). |

### Making schema changes
1. Edit `prisma/schema.prisma`. Prefer **additive** changes (new optional fields or fields with `@default`).
2. `yarn prisma db push` (never `--accept-data-loss` / `--force-reset` on the live database without a backup).
3. `yarn prisma generate`.

## Adding a new page
1. Create `app/(authenticated)/<name>/page.tsx` + `_components/<name>-content.tsx`.
2. Add a nav item in `components/sidebar.tsx` (`navItems`).
3. **Add `'/<name>/:path*'` to the matcher in `middleware.ts`**. Otherwise an expired session shows an
   empty page full of 401s instead of redirecting to `/login`.
4. API routes: start with `getServerSession(authOptions)` (or `authorizeCaller` if a scheduled job must
   call it) and return 401 when unauthenticated.

## Conventions
- UI accents: violet = Kalshi, indigo = Polymarket, emerald = recommendations, amber = sharp bookmaker,
  cyan = calibration, teal→emerald = Value Tracker.
- Folders starting with `_` under `app/` are private and do not create routes.
- Never let `Date.now()`/`Math.random()` render during SSR (hydration errors). Use effects/client components.
