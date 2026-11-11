# DutchBetting — working notes for Claude

Private, login-protected Next.js dashboard for Kalshi/Polymarket prediction-market betting:
weather Dutch baskets (Kalshi temperature bins vs NWS forecasts) and soccer (match result,
correct score, goals) plus paper-only research trackers. Moved from Abacus.ai; Claude owns all
work on it now. Full docs: `docs/README.md` (read the relevant numbered doc before a change).

## Stack and commands
- Next.js 14.2 App Router, TypeScript (strict), Prisma 6.7 on PostgreSQL, NextAuth 4
  (credentials + JWT), Tailwind + shadcn/ui, Recharts/Chart.js/Plotly.
- Package manager is **Yarn 4 via Corepack** (`packageManager` in package.json; lockfile v8).
  Run `corepack enable` once, or prefix commands with `corepack yarn`. Do not use Yarn 1 or npm.
- `yarn install` · `yarn prisma generate` · `yarn dev` · `yarn build` (the build check;
  type errors fail it, lint is skipped).
- Build without a database: set dummy `DATABASE_URL`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`.

## Layout
- Pages: `app/(authenticated)/<page>/page.tsx`, UI in `_components/<page>-content.tsx`.
- API: `app/api/<area>/<action>/route.ts`. Business logic and API clients: `lib/`.
- Schema: `prisma/schema.prisma` (27 models). Sidebar nav: `components/sidebar.tsx`.

## Rules that are easy to break
- **New page** → add it to `components/sidebar.tsx` navItems AND to the matcher in
  `middleware.ts` (`'/<name>/:path*'`), or expired sessions show empty pages of 401s.
- **API routes** start with `getServerSession(authOptions)`, or `authorizeCaller(req)`
  (`lib/automation-auth.ts`) if a scheduled job calls it; return 401 when unauthenticated.
  Long routes: `export const maxDuration = 300`; request-dependent: `dynamic = 'force-dynamic'`.
- **Real money.** Paper/demo is the default. Never change a default from paper to live, never
  loosen live-order guards (NO-side block, price-move 409 check, daily spend caps) unless the
  user explicitly asks. AI Tracker, Predictions and Value Tracker are always paper-only.
- **Schema changes are additive** (optional fields or `@default`). `prisma db push` only;
  never `--accept-data-loss` / `--force-reset` against the real database.
- No `Date.now()` / `Math.random()` during SSR render (hydration errors).
- Don't price EV off FootyStats `_potential` fields (placeholder 0/50/75/100 values).
- Trust the constants at the top of each `lib/*.ts` file over any doc table.
- Design: follow `STYLE_GUIDE.md`; theme tokens, never hard-coded colours. Accents:
  violet = Kalshi, indigo = Polymarket, emerald = recommendation, amber = sharp bookmaker,
  cyan = calibration, teal→emerald = Value Tracker.

## External services
- LLM: `apps.abacus.ai/v1/chat/completions`, model `gpt-5.4-mini`, key `ABACUSAI_API_KEY`, called
  in `lib/score-research.ts`, `lib/polymarket-score-research.ts`, `lib/goals-research.ts`.
  Falls back to a market-implied Poisson model when the call fails.
- Kalshi keys live in the DB (Settings page), not env. Polymarket uses CLOB V2 with
  signatureType 3 (POLY_1271 deposit wallet). See doc 05.

## Hosting status and workflow
- **Test site:** https://dutchtest.wagerassistant.com on Matt's Ubuntu server (173.249.54.18), deploys
  the **`staging`** branch automatically within ~2 min of a push (`/usr/local/bin/dutch-staging-sync`,
  timer `dutch-staging-sync.timer`; status `/var/log/dutch-staging-sync.status`, build log
  `/var/log/dutch-staging-build.log`). Broken builds never replace the running site.
  Runs as user `dutchstage` from `/opt/dutch-staging/app`, service `dutch-staging` on 127.0.0.1:3470,
  own PostgreSQL DB `dutch_staging` (separate from the Abacus database). No Kalshi/Polymarket trading
  credentials there, so it cannot place real orders — keep it that way (use Kalshi *demo* keys if needed).
- **Workflow:** make changes on `staging` → check them on the test site → merge to `main`.
- **Live site** still runs on Abacus (`kalshi-dutch-betting-f4pmq6.abacusai.app`) and does not deploy
  from GitHub.
- Scheduled jobs still run as Abacus tasks. On the test site they are NOT scheduled (to avoid spending
  API quota twice); run one by hand with `dutch-staging-job ingest|shadow|grade|value-run|value-settle`.
  `.github/workflows/scheduled-jobs.yml` stays inert until `DUTCH_AUTOMATION_ENABLED=true`.
- Server scripts are versioned in `deploy/`; copy to `/usr/local/bin` after changing them.
