# 4. Scheduled Tasks & Automation ("cron")

The app itself contains **no internal cron/timer**. All recurring work happens when an outside scheduler
calls an HTTP endpoint. Today that scheduler is **Abacus AI scheduled tasks** (run in the Abacus agent VM,
config in `/home/ubuntu/shared/betting_automation_config.json`, run logs in `/home/ubuntu/shared/*.jsonl`).
If you move servers, recreate these jobs with Linux `cron`, systemd timers, GitHub Actions, or any HTTP scheduler.

## How automated calls authenticate

`lib/automation-auth.ts` → `authorizeCaller(req)` accepts EITHER a logged-in session OR:

| Header | Value |
|---|---|
| `x-automation-secret` | must equal `AUTOMATION_SECRET` in `.env` |
| `Content-Type` | `application/json` |
| `User-Agent` | any browser-like string. **Cloudflare in front of the Abacus host returns 403 without it.** e.g. `Mozilla/5.0 (compatible; automation-bot/1.0)` |

The run acts as the user in `AUTOMATION_USER_EMAIL`. Success = HTTP 200 and JSON with `success: true, automated: true`.
To rotate the secret: change `AUTOMATION_SECRET` in `.env`, redeploy, and update every scheduler.

## The five jobs (times = America/Los_Angeles)

| # | Job | Endpoint(s) | Schedule | Timeout | Notes |
|---|---|---|---|---|---|
| A | Pull external predictions | `POST /api/external-predictions/ingest` | 07:00, 19:00 | 300 s (server `maxDuration=300`) | Pulls API-Football + FootyStats predictions into `ExternalPrediction`. Can run long; public URL may 504 at 300 s while work still completes server-side. |
| B | AI shadow analysis | `POST /api/shadow/run` body `{"limit":6}` | 09:00, 21:00 | ≥ 900 s client side | LLM "shadow analyst" scores upcoming matches (paper only). |
| C | Grade + calibrate | 1) `POST /api/external-predictions/settle` 2) `POST /api/shadow/settle` 3) `POST /api/calibration/recompute` — **in this order** | every 6 h | 300 s each | Settles finished games, then recomputes per-source/market calibration used by research prompts. |
| D | Value Tracker – pull picks | `POST /api/value-tracker/run` | 00:00, 06:00, 12:00, 18:00 | 300 s | Re-prices every FootyStats selection, records $10 paper picks that clear thresholds. Summary is in `summary`. |
| E | Value Tracker – grade picks | `POST /api/value-tracker/settle` | ~04:15, 10:15, 16:15, 22:15 | 300 s | Settles completed matches (12 h after kickoff); voids dead/suspended or >7-day-old matches. |

Abacus requires ≥ 1 h between runs of a task, which is why D/E are offset.

**Test site (dutchtest.wagerassistant.com)** runs every page on its own (systemd timers, calling 127.0.0.1 directly):

| Timer | When | Does |
|---|---|---|
| `dutch-staging-job@shadow` | hourly :05 | AI Tracker analysis, 10 matches/run |
| `dutch-staging-job@value-run` | hourly :15 | Value Tracker: find and log $10 paper picks |
| `dutch-staging-job@dashboard` | hourly :25 | `POST /api/refresh`: Kalshi + NWS pull, analysis, demo Dutch picks (Backtest → tracker), History grading |
| `dutch-staging-job@ingest` | hourly :35 | Predictions pull |
| `dutch-staging-job@grade` | every 3 h :50 | settle Dashboard demo picks, Value Tracker, Predictions, AI Tracker; recompute calibration |

`/api/refresh` and `POST /api/tracker` accept the automation secret. A scheduled refresh skips the real-money
full-auto step unless `ALLOW_SCHEDULED_LIVE_BETS=true`. The AI Tracker only takes pre-match picks and rests a
match for 6 h after finding no edge, so hourly runs work through the whole slate.

## curl template

```bash
BASE=https://YOUR-HOST            # e.g. https://kalshi-dutch-betting-f4pmq6.abacusai.app
SECRET='<AUTOMATION_SECRET>'

curl -sS --max-time 900 -X POST "$BASE/api/value-tracker/run" \
  -H "x-automation-secret: $SECRET" \
  -H "Content-Type: application/json" \
  -H "User-Agent: Mozilla/5.0 (compatible; automation-bot/1.0)" \
  -d '{}'
```

For job B send `-d '{"limit":6}'`.

## Linux crontab equivalent

Create `/opt/dutchbetting/cron-call.sh`:

```bash
#!/usr/bin/env bash
# usage: cron-call.sh <path> [json-body]
set -a; . /opt/dutchbetting/automation.env; set +a   # defines BASE and AUTOMATION_SECRET
BODY=${2:-'{}'}
TS=$(date -Is)
OUT=$(curl -sS --max-time 900 -w ' HTTP%{http_code}' -X POST "$BASE$1" \
  -H "x-automation-secret: $AUTOMATION_SECRET" -H 'Content-Type: application/json' \
  -H 'User-Agent: Mozilla/5.0 (compatible; automation-bot/1.0)' -d "$BODY")
echo "$TS $1 ${OUT: -300}" >> /var/log/dutchbetting-cron.log
```

`chmod 700` it, put `BASE=` and `AUTOMATION_SECRET=` in `automation.env` (`chmod 600`). Then `crontab -e`:

```cron
CRON_TZ=America/Los_Angeles
# A – external predictions
0 7,19 * * *   /opt/dutchbetting/cron-call.sh /api/external-predictions/ingest
# B – AI shadow analyst
0 9,21 * * *   /opt/dutchbetting/cron-call.sh /api/shadow/run '{"limit":6}'
# C – grade + calibrate (sequential)
30 1,7,13,19 * * * /opt/dutchbetting/cron-call.sh /api/external-predictions/settle && /opt/dutchbetting/cron-call.sh /api/shadow/settle && /opt/dutchbetting/cron-call.sh /api/calibration/recompute
# D – value tracker pull
0 0,6,12,18 * * * /opt/dutchbetting/cron-call.sh /api/value-tracker/run
# E – value tracker grade
15 4,10,16,22 * * * /opt/dutchbetting/cron-call.sh /api/value-tracker/settle
```

(`CRON_TZ` works on cronie/Debian cron; otherwise set the server timezone or convert to UTC.)
Note for job C: `curl` returns 0 even on HTTP 504, so the chain continues — that's intended (each step is idempotent).

## Self-hosted note on timeouts

On Abacus/Vercel-style hosting, `export const maxDuration = 300` caps a route at 300 s. On your own server
(`next start` behind nginx) there is no cap, but set nginx `proxy_read_timeout 900s;` for `/api/` or long ingests will 504 at the proxy.

## GitHub Actions (ready in this repo)

`.github/workflows/scheduled-jobs.yml` runs all five jobs (A–E) and can also be triggered by hand
(Actions → Scheduled jobs → Run workflow → pick a job). It does nothing until you set, under
Settings → Secrets and variables → Actions: secrets `DUTCH_BASE_URL` and `DUTCH_AUTOMATION_SECRET`,
and variable `DUTCH_AUTOMATION_ENABLED` = `true`. Turn the Abacus tasks off at the same time.
Its cron times are UTC set for PST; during PDT each job runs one hour later local time.

Minimal single-job example:

```yaml
# .github/workflows/value-tracker.yml
on:
  schedule: [{ cron: '0 7,13,19,1 * * *' }]   # UTC!
  workflow_dispatch: {}
jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl -sS --max-time 900 -X POST "${{ secrets.BASE }}/api/value-tracker/run" \
            -H "x-automation-secret: ${{ secrets.AUTOMATION_SECRET }}" \
            -H 'Content-Type: application/json' \
            -H 'User-Agent: Mozilla/5.0 (compatible; automation-bot/1.0)' -d '{}'
```
GitHub cron is UTC and can be delayed several minutes.

## Other automation inside the app

- **Weather auto-bet** (Settings → Auto-Bet): "one-click" or "full-auto" mode is triggered from the dashboard/refresh flow (`/api/refresh`, `/api/auto-bet/*`) while the page is open or when an endpoint is called — it is not a timer. If you want unattended weather betting, add a cron call to the relevant auto-bet endpoint (see doc 02 route list).
- Soccer/Correct-Score/Goals auto modes respect `paperMode` / environment demo — real orders only in production mode.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| 403 HTML page | Missing `User-Agent` header (Cloudflare). |
| 401 `Unauthorized` | Wrong/missing `x-automation-secret`, or `AUTOMATION_SECRET` not in the deployed `.env`. |
| 504 after ~300 s | Proxy timeout; work usually continues server-side. Check row counts afterwards. |
| Ingest adds 0 from api_football | API-Football returning "account suspended" (rate limit/plan). `lib/api-football.ts` throttles to ~3 req/s with retry; check plan at dashboard.api-football.com. |
| Value tracker adds nothing | No leagues selected on FootyStats account (max **50**), or FOOTYSTATS_API_KEY reverted to test key. |
| settle keeps reporting the same open rows | Postponed games; they auto-void after 7 days (value tracker) / 14 days (predictions). |
