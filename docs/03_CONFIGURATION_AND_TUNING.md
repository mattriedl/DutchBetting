# 3. Configuration, Settings & Tuning

## Environment variables (`.env`)

Copy `.env.example` to `.env`. Never commit `.env`.

| Variable | Required | Used by | Notes |
|---|---|---|---|
| `DATABASE_URL` | yes | Prisma | PostgreSQL connection string `postgresql://user:pass@host:5432/db?schema=public`. |
| `NEXTAUTH_SECRET` | yes | NextAuth | Random 32+ byte string (`openssl rand -base64 32`). Changing it logs everyone out. |
| `ALLOW_SIGNUP` | no | signup route, login page | `true` shows "Sign up" and enables `/api/signup`. Default off: this is a private dashboard. |
| `NEXTAUTH_URL` | yes off-Abacus | NextAuth, `app/layout.tsx` | Public base URL, e.g. `https://bets.example.com`. Abacus sets it automatically, so it's absent from `.env` there. |
| `ABACUSAI_API_KEY` | for AI research | score/goals/polymarket research | LLM calls to `https://apps.abacus.ai/v1/chat/completions` (OpenAI-compatible). Without it, research falls back to a market-implied Poisson model. |
| `API_FOOTBALL_KEY` | recommended | api-football, low-scoring, predictions | api-sports.io key (Pro plan: 7,500 requests/day). |
| `FOOTYSTATS_API_KEY` | for Value Tracker / FootyStats predictions | value-tracker, external-predictions | football-data-api.com key. **Leagues are chosen on the FootyStats website (maximum 50 on this plan)**, not in code. |
| `THE_ODDS_API_KEY` | optional | odds-api | Sharp bookmaker de-vigged totals/BTTS. |
| `POLYMARKET_PRIVATE_KEY` | for live Polymarket | polymarket-api | Signer wallet private key. Paper mode works without it. |
| `POLYMARKET_API_KEY`, `POLYMARKET_API_SECRET` | legacy | — | Stale V1 creds. V2 derives L2 creds at runtime from the private key. |
| `AUTOMATION_SECRET` | for scheduled jobs | automation-auth | Shared secret sent as `x-automation-secret`. |
| `AUTOMATION_USER_EMAIL` | for scheduled jobs | automation-auth | Account automated runs act as (`mattriedl@hotmail.com`). |
| `THESTATBIBLE_EMAIL`, `THESTATBIBLE_PASSWORD` | unused | — | Kept for possible future scraping (site is behind Cloudflare). |

Kalshi credentials are **not** environment variables. Enter them on the **Settings** page (stored in the
`ApiCredential` table): Key ID + RSA private key (PEM) + environment demo/production.

## In-app settings (Settings page and per-page settings panels)

| Feature | Setting (DB field) | Default |
|---|---|---|
| Weather auto-bet | enabled, mode (one-click/full-auto), minProfitMargin %, minRating, maxStakePerBet $, maxDailySpend $, slippageCents, environment (demo/production) | off, one-click, 5%, good, $10, $100, 2¢, demo |
| Soccer | uses AutoBetConfig.environment. **demo = paper fills**, production = real Kalshi orders | demo |
| Correct Score / Polymarket Score | minProfitMargin (browse filter), minPicks/maxPicks, min/max stake, maxDailySpend, slippage, **minEdgeCents**, **minLowScore** (0 = off), includeAnyOther, **paperMode** | 5 picks, edge 2¢, low-score off |
| Polymarket wallet | signatureType (0 EOA, 1 Magic/email proxy, 2 Safe, **3 POLY_1271 deposit wallet**, currently used), funderAddress (deposit wallet) | see account |
| Goals | paperMode (default true), minEdge, lowScoringOnly, minLowScore, stake, slippage, source | paper |
| Display | oddsFormat: shares / payout / american | shares |

## Tunable constants in code

Change a value, run `yarn build` to check, then deploy.

### Value Tracker (`lib/value-tracker.ts`)
| Constant | Current | Effect |
|---|---|---|
| `VALUE_STAKE_CENTS` | 1000 ($10) | Flat paper stake per pick. |
| `VALUE_MIN_EV` | 0.08 | Minimum **calibrated** EV per $1. Higher = fewer, stronger picks. |
| `VALUE_MIN_PROB` | 0.5 | Minimum calibrated win probability. |
| `MODEL_WEIGHT` | 0.4 | Share of model in calibrated prob (rest is the de-vigged market). Lower = more conservative. |
| `MIN_ODDS` / `MAX_ODDS` | 1.35 / 3.3 | Decimal-odds band allowed. |
| `DROP_MARKETS` | double_chance, win_to_nil | Markets never picked. |
| `SETTLE_CUTOFF_MS` | 12 h | Only grade matches at least this long after listed kickoff. |
| `STALE_ABANDON_MS` | 7 days | Void picks whose match never completes. |
| `DEAD_MATCH_STATUSES` | suspended, postponed, canceled, cancelled, abandoned | Void immediately. |

Why calibration exists: the raw Poisson model was overconfident (picks rated 55–60% won about 44%), and the
first 2,037 picks returned −2.8% ROI. In a backtest, shrinking toward the market and raising the bar
turned that positive. Do **not** price EV off FootyStats `_potential` percentage fields. They are often
0/50/75/100 placeholder values and produce fake 100% probabilities.

### AI Shadow Tracker (`lib/shadow-analyst.ts`)
`SHADOW_STAKE_DOLLARS = 10`, `SHADOW_MIN_EDGE_CENTS = 3`, `SHADOW_MIN_PROB = 0.4`. `shadow/run` accepts
`{"limit": N}` (matches researched per run; the scheduled job uses 6).

### External Predictions (`lib/external-predictions.ts`)
`STALE_ABANDON_MS = 14 days` (void unresolvable rows). Settle cutoff is now − 12 h.

### Calibration (`lib/calibration.ts`)
`MIN_SAMPLE_FOR_PROB_CALIBRATION = 60`, `MIN_SAMPLE_FOR_CORRECTION = 25`, `MAX_ABS_XG_BIAS = 0.75`,
confidence scale clamp 0.6–1.15, probability slope clamp 0.35–1.25, `LOW_SCORING_THRESHOLD = 2` goals,
cache 5 min.

### Research engine (`score-research.ts`, `polymarket-score-research.ts`, `goals-research.ts`)
LLM model `gpt-5.4-mini` (string in each file's fetch body), Dixon-Coles `DC_RHO = -0.1`,
`GRID_MAX = 10` goals (goals research).

### Exchange fees (`lib/trading-fees.ts`, `lib/kalshi-fees.ts`)
Both exchanges charge takers `fee = contracts × rate × (P × (1 − P))^exponent`; makers pay nothing on soccer/climate.
- **Kalshi:** rate 0.07 (fee schedule effective 2026-07-07).
- **Polymarket:** per market from Gamma `feesEnabled` / `feeSchedule {rate, exponent}` (soccer = sports: 0.05, exponent 1);
  default 0.05 when a market doesn't say.

The app buys at the ask, so it pays the taker fee. Fees are added to the recorded cost of every bet (`feeCents` column on
Goals, Correct Score, Polymarket Score, Soccer, Auto-Bet orders and AI Tracker picks), so net profit is after fees, and
all opportunity analysis is net of fees: weather Dutch odds/margins/viability/ratings, Soccer favourite+draw margins,
Kalshi and Polymarket score basket cost/margin/EV (server + in-page recompute), Goals edges (per market) and AI Tracker
EV use `effectiveCents(price, fee)`. Stake sizing keeps cost + fees within the stake. Backtest and the Dashboard demo-pick
tracker add the fee to the "ask" (taker) scenario only. The Value Tracker prices against bookmaker odds (no exchange fee).

### API clients
- `api-football.ts`: `MIN_REQUEST_GAP_MS = 350` (~3 req/s; lowering it risks the provider's temporary
  "account suspended" rate-limit response), `CACHE_TTL_MS = 4 h`, negative cache 6 h,
  `FINISHED_STATUSES = FT/AET/PEN`.
- `low-scoring-consensus.ts`: cache 6 h. `odds-api.ts`: cache 30 min.
- `market-timing.ts`: `LOW_CUTOFF_HOUR = 8`, `HIGH_CUTOFF_HOUR = 17`.

### Market coverage lists
- Kalshi correct-score series: `SCORE_SERIES` (`lib/correct-score.ts`). Verify tickers with Kalshi
  `GET /series?category=Sports` (it does list series now) before adding them.
- Kalshi goals leagues: `GOALS_LEAGUES` (`lib/goals-markets.ts`).
- Kalshi soccer match series: `SOCCER_SERIES` (`lib/soccer-dutch.ts`).
- Weather cities/tickers: `CLIMATE_HIGH_TICKERS`, `CLIMATE_LOW_TICKERS` (`lib/kalshi-api.ts`) and
  `CITY_COORDINATES` (`lib/nws-api.ts`).
- FootyStats leagues: chosen on the FootyStats account website (maximum 50).

## Users
- Create a login: `SEED_USER_EMAIL=you@example.com SEED_USER_PASSWORD='10+ chars' yarn prisma db seed` (creates only if missing; the old hard-coded john@doe.com admin was removed).
- Public sign-up is off unless `ALLOW_SIGNUP=true`. All existing real bet data belongs to
  `mattriedl@hotmail.com`.
