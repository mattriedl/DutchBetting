# 1. Overview & Feature Guide

DutchBetting is a private, login-protected dashboard for finding, tracking and (optionally) placing
prediction-market and sports bets. It has two halves:

- **Weather (Kalshi climate markets)**: Dutch-betting across daily high/low temperature bins on
  Kalshi, priced against National Weather Service (NWS) forecasts.
- **Soccer**: Kalshi and Polymarket soccer markets (match result, correct score, goals), plus three
  paper-only research trackers (AI Shadow Tracker, External Predictions, Value Tracker).

Live site: https://kalshi-dutch-betting-f4pmq6.abacusai.app (hosted on Abacus AI).
Owner account (owns all real bet data and automation runs): `mattriedl@hotmail.com`.

> **Safety model.** Most soccer features default to **paper/demo mode**: they simulate fills and store
> rows marked as paper, and place no real order. Real-money orders only happen when you switch a page to
> live/production mode in its settings **and** valid exchange credentials are configured.
> The AI Tracker, Predictions and Value Tracker pages are **always** paper-only.

---

## Sidebar pages

| Page | URL | What it does |
|---|---|---|
| Dashboard | `/dashboard` | Summary of current weather Dutch-bet opportunities, recent activity, and a refresh button that pulls Kalshi climate markets + NWS forecasts (`POST /api/refresh`). |
| Markets | `/markets`, `/markets/[city]` | Every Kalshi temperature market by city (high/low), odds chart per bin, NWS forecast overlay. |
| Opportunities | `/opportunities` | Weather Dutch baskets that clear the margin/rating filters. Edge cases (fewer than 3 bins, forecast > 4°F from centre bin) are flagged. |
| Analytics | `/analytics` | Charts: opportunities per city, profit-margin distribution. |
| History | `/history` | Past weather bets/predictions with resolution; `re-resolve` re-grades. |
| Auto-Bet | `/auto-bet` | Weather auto-betting config (one-click or full-auto, min margin, min rating, max stake, daily cap, slippage, demo/production). |
| Soccer | `/soccer` | Kalshi soccer match-result Dutch picks (favourite-win + draw legs). Demo env = paper fills. |
| Correct Score | `/correct-score` | Kalshi correct-score Dutch baskets (4–6 scorelines), AI research, edge/EV gate, low-scoring gate, calibration panel. Violet accent. |
| Goals Markets | `/goals` | Single-leg BTTS and Over/Under value bets on Kalshi and/or Polymarket, AI research, Refresh Price, demo/live. |
| Polymarket Score | `/polymarket-cs` | Polymarket exact-score Dutch baskets, wallet balance, research, demo/live. Indigo accent. |
| AI Tracker | `/ai-tracker` | AI Shadow Tracker: an autonomous LLM analyst records $10 paper picks twice a day and grades them. |
| Predictions | `/predictions` | External Predictions Tracker: stores predictions from API-Football and FootyStats, grades them and reports each source's hit rate. Filters include Open / Settled / Voided. |
| Value Tracker | `/value-tracker` | FootyStats +EV paper tracker: Poisson model calibrated to the de-vigged market, flat $10 paper stakes, ROI by market/model. |
| Backtest | `/backtest` | Historic backtest of the weather Dutch strategy. |
| Settings | `/settings` | Kalshi API credentials (key ID + RSA private key, demo/production), odds display format, per-feature configs and paper-mode toggles. |

Login: `/login` (email + password). Signup: `POST /api/signup`.

---

## Feature details

### Weather Dutch betting
- Kalshi climate series (`CLIMATE_HIGH_TICKERS` / `CLIMATE_LOW_TICKERS` in `lib/kalshi-api.ts`).
- NWS forecasts per city (`lib/nws-api.ts`, `CITY_COORDINATES`), climate history (`lib/nws-climate.ts`).
- Dutch maths (`lib/dutch-betting.ts`): stake_i = total × (1/odds_i) / Σ(1/odds_j). A basket is viable
  when Σ(1/odds) < 1. Ratings: excellent / good / marginal.
- Timing guard (`lib/market-timing.ts`): low-temp markets stop being bettable after 8 AM local, high-temp
  markets after 5 PM local (the extreme has already happened).

### Correct Score (Kalshi) and Polymarket Score
- Discovers all live soccer correct-score events (Kalshi: curated `SCORE_SERIES` list in
  `lib/correct-score.ts`; Polymarket: Gamma soccer tag 100639, `-exact-score` slugs, ended events
  filtered out with `end_date_min`).
- **Research button**: API-Football live stats + sharp bookmaker lines + external predictions are fed
  to an LLM, which estimates xG. A Dixon-Coles Poisson model (rho −0.1) turns xG into scoreline
  probabilities, blended with the market.
- **Gates**: a basket is only *recommended* if its EV is at least `minEdgeCents` and (optionally) the
  low-scoring score is at least `minLowScore`. Default basket size is 5 scorelines.
- You can remove scorelines before placing; the basket re-optimises.
- Settle routes grade baskets and store `finalScore`.

### Goals Markets
- Kalshi BTTS (`KX<LG>BTTS`) + totals ladder (`KX<LG>TOTAL`), plus Polymarket "more markets" totals/BTTS.
- Source selector: Kalshi / Polymarket / Both.
- Calibrated model probability (least-squares reliability curve) drives edge/EV.
- Live orders: **YES side only** (Under / No-BTTS are NO-side, so they are demo-only in live mode).
- Place re-checks the live price; a live order is rejected (409) if the price moved adversely by more than
  max(slippage, 3)¢.

### AI Shadow Tracker (`/ai-tracker`)
- `lib/shadow-analyst.ts`. Runs the research engine on upcoming games and records a $10 paper pick when
  edge ≥ 3¢ and probability ≥ 40%. Graded by `/api/shadow/settle`.

### External Predictions (`/predictions`)
- `lib/external-predictions.ts`. Sources: `api_football`, `footystats`, `footystats_math`.
- Grades match result, BTTS and total-goals predictions using the stored API-Football fixture ID first,
  then a team-name search.
- Rows that stay unresolvable 14+ days after kickoff are voided so they don't block the queue.
- `getExternalConsensus()` injects each source's realised hit rate into the research prompts.

### Value Tracker (`/value-tracker`)
- `lib/value-tracker.ts`. For every upcoming match in your FootyStats-selected leagues (maximum 50):
  1. Model probability from Poisson on FootyStats `team_a_xg_prematch` / `team_b_xg_prematch`
     (goals/result markets) and `corners_potential` (corners O/U).
  2. **Calibration**: calibrated = 0.4 × model + 0.6 × de-vigged market probability.
  3. Qualifies when calibrated EV ≥ +8%, calibrated probability ≥ 50%, and odds are between 1.35 and 3.30.
     Double chance and win-to-nil are excluded.
  4. Records a flat $10 paper pick; `run` re-evaluates every 6 h, `settle` grades finished matches.
- Matches still not complete 7 days after kickoff, or marked suspended/postponed/cancelled/abandoned, are voided.
- Kalshi/Polymarket prices for the same totals/BTTS line are shown for comparison only.

### Calibration panel (Correct Score, Goals, Polymarket Score)
- `lib/calibration.ts`, model `ModelCalibration`. Learns from settled bets: win rate vs implied, xG bias
  (applied to research), confidence scale, Brier score and probability reliability slope/intercept
  (applied to Goals). Recomputes automatically after settling, or on demand with the Recompute button.
