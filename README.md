# DutchBetting — Kalshi / Soccer Betting Dashboard (backup)

Source snapshot of the dashboard live at https://kalshi-dutch-betting-f4pmq6.abacusai.app.
Secrets are NOT included — copy `.env.example` to `.env` and fill in your own values.

## Full documentation

See [`docs/README.md`](docs/README.md): features, code reference, settings, scheduled jobs (cron),
AI & API connections, moving to a new server, troubleshooting.

## Run locally

```bash
cp .env.example .env        # fill in DATABASE_URL, NEXTAUTH_SECRET, API keys, etc.
yarn install
yarn prisma generate
yarn dev                    # http://localhost:3000
```

Build check: `yarn build`

## Main areas

- `app/(authenticated)/` — pages (dashboard, markets, soccer, goals, predictions, value-tracker, ...)
- `app/api/` — API routes (ingest/settle/run endpoints used by the scheduled automations)
- `lib/value-tracker.ts` — calibrated +EV paper-pick model (40% model / 60% de-vigged market, EV >= 8%, odds 1.35–3.30)
- `lib/external-predictions.ts`, `lib/api-football.ts` — prediction ingest + settlement
- `prisma/schema.prisma` — database schema
- `middleware.ts` — every authenticated route must be listed here

## Pushing to GitHub (first time)

```bash
git init -b main
git add .
git commit -m "Initial backup"
git remote add origin https://github.com/mattriedl/DutchBetting.git
git push -u origin main
```

## Going live

The live site is hosted on Abacus AI and deploys from the Abacus project, not from GitHub.
To ship changes made here, bring the changed files into the Abacus conversation for the app
(paste or upload them) and ask for them to be tested and deployed.
