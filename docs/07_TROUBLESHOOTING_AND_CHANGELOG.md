# 7. Troubleshooting & Change History

## Common problems

| Symptom | Likely cause | Fix |
|---|---|---|
| Page shows "no data" + small red "Unauthorized" toast | Session expired | Log in again. All authenticated routes must be in the `middleware.ts` matcher so this redirects automatically. |
| Build fails: `@prisma/client did not initialize` | Prisma `output` path / binaryTargets wrong for the machine | See "Prisma fix" in doc 06, then `yarn prisma generate`. |
| Login loops / `NEXTAUTH_URL` errors | `NEXTAUTH_URL` missing or wrong protocol/domain | Set it to the exact public URL; restart. |
| Kalshi 401 | Wrong key environment (demo key against production or vice versa), bad PEM, server clock skew | Re-enter key on Settings; sync clock (`timedatectl set-ntp true`). |
| Live NO-side order rejected | Live NO-side orders are intentionally blocked in code | Use paper mode or YES-side legs. |
| Polymarket order "invalid signature" | signatureType/funder mismatch with the private key | Settings → Polymarket; current setup is type 3 (POLY_1271) with the deposit wallet as funder. |
| AI research returns plain Poisson numbers | LLM call failing (credits/key) | Check `ABACUSAI_API_KEY`; server logs show the LLM error. App falls back automatically. |
| API-Football "Your account is suspended" | Burst rate limit | Built-in throttle/retry; reduce concurrent jobs; check plan quota. |
| FootyStats returns 0 matches | No leagues selected | Select leagues on the FootyStats website (**max 50**). |
| Value Tracker settle stuck on same rows | Postponed/suspended matches | Auto-voided after 7 days or when status is suspended/postponed/cancelled/abandoned. |
| External settle 504 | Long run behind proxy | Usually finishes server-side; check counts on Predictions page. |
| Correct-score legs without model probability | Older rows created before modelProb was stored | Historical only; excluded from calibration. |

## Settlement rules (quick reference)

- Games are checked only after kickoff + 12 h.
- Value Tracker: settle on FootyStats status `complete`; void on dead status or > 7 days.
- External predictions: settle via API-Football fixture result; NS/PST games stay open; void after 14 days.
- DNB voids on a draw; void picks are excluded from win-rate/ROI.

## Change history (major milestones)

| When (2026) | Change |
|---|---|
| early | Weather Dutch betting on Kalshi temperature markets using NWS forecasts; auto-bet one-click/full-auto; NWS CF6/CLI settlement checks. |
| — | Soccer Dutch, Kalshi Correct Score with AI research (Poisson + LLM + market blend); low-scoring consensus. |
| — | Polymarket correct-score and goals markets, CLOB V2 client, POLY_1271 deposit wallet support, paper mode. |
| — | Goals page, AI Tracker, shadow analyst (paper), calibration engine fed by graded predictions. |
| Sep | External predictions (API-Football + FootyStats) ingest/settle; FootyStats real key; league selection limited to 50. |
| Sep 19 | API-Football throttle + retry (fixes "suspended" bursts); team-name normalization; `maxDuration=300` on ingest/settle. |
| Sep | Value Tracker launched: Poisson on continuous xG / corner inputs (not FootyStats `_potential` sentinels); $10 paper stake. |
| Sep 26 | Middleware covers all newer pages; 401 → login redirect on Value Tracker; stale/suspended picks auto-void. |
| later | Value Tracker recalibrated: blend 40% model / 60% de-vigged market, EV ≥ 8%, odds 1.35–3.30 (see `lib/value-tracker.ts` constants and doc 03). |
| Nov | Source backup + this documentation set. |

For exact current thresholds always trust the constants at the top of each `lib/*.ts` file over this table.
