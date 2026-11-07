# 6. Deployment, New-Server Setup & Migration

## Requirements

Node.js 20+ LTS (built and tested on 22), Yarn 4 via Corepack (`corepack enable`), PostgreSQL 14+, ~1 GB RAM for build (more is better), outbound HTTPS.
Stack: Next.js 14.2 (App Router), Prisma 6.7, NextAuth 4 (credentials, JWT), Tailwind/shadcn UI.

## A. Run locally

```bash
cp .env.example .env      # fill DATABASE_URL, NEXTAUTH_SECRET, NEXTAUTH_URL=http://localhost:3000, keys
yarn install
yarn prisma generate
yarn prisma db push       # creates tables on an empty database
yarn prisma db seed       # optional: scripts/safe-seed.ts (upserts, no deletes)
yarn dev                  # http://localhost:3000
```

## Prisma (done)

The Abacus-only Prisma `output` path has been removed and `binaryTargets = ["native"]`, so the client
generates into `node_modules/.prisma/client` on any machine. Add e.g. `"debian-openssl-3.0.x"` or
`"linux-musl-openssl-3.0.x"` only when building in Docker for a different OS.

## Other Abacus-specific bits (safe to leave or remove)

| Where | What | Action off Abacus |
|---|---|---|
| `next.config.js` | `distDir: process.env.NEXT_DIST_DIR`, `output: process.env.NEXT_OUTPUT_MODE` | Leave; unset vars = normal `.next` build. Set `NEXT_OUTPUT_MODE=standalone` for Docker. (Abacus error-reporter injection removed.) |
| `app/layout.tsx` | Abacus `appllm-lib.js` script tag | Removed. |
| `.yarnrc.yml` | Abacus global yarn cache folder | Removed; only `nodeLinker: node-modules` remains. |
| `NEXTAUTH_URL` | Abacus injects it per environment | **You must set it** to your public URL. |
| `ABACUSAI_API_KEY` | Abacus LLM | Keep (works anywhere) or switch provider (doc 05). |

## B. New Ubuntu server (VPS) — step by step

```bash
# 1. system packages
sudo apt update && sudo apt install -y curl git nginx postgresql
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs
sudo npm i -g pm2 && sudo corepack enable

# 2. database
sudo -u postgres psql -c "CREATE USER dutch WITH PASSWORD '<DB_PASSWORD>';"
sudo -u postgres psql -c "CREATE DATABASE dutchbetting OWNER dutch;"

# 3. code
sudo mkdir -p /opt/dutchbetting && sudo chown $USER /opt/dutchbetting
cd /opt/dutchbetting && unzip ~/DutchBetting_backup.zip && cd DutchBetting   # or git clone
cp .env.example .env && nano .env
#   DATABASE_URL=postgresql://dutch:<DB_PASSWORD>@localhost:5432/dutchbetting?schema=public
#   NEXTAUTH_URL=https://bets.example.com
#   NEXTAUTH_SECRET=$(openssl rand -base64 32)  ... plus API keys, AUTOMATION_SECRET, AUTOMATION_USER_EMAIL

# 4. install + build
yarn install
yarn prisma generate
yarn prisma db push          # only if NOT restoring a dump (step C)
yarn build

# 5. run with pm2
pm2 start "yarn start -p 3000" --name dutchbetting
pm2 save && pm2 startup     # follow printed command
```

### nginx + HTTPS

```nginx
server {
  server_name bets.example.com;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 900s;      # long ingest/settle calls
  }
}
```
```bash
sudo ln -s /etc/nginx/sites-available/dutchbetting /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx && sudo certbot --nginx -d bets.example.com
```

systemd instead of pm2:
```ini
# /etc/systemd/system/dutchbetting.service
[Service]
WorkingDirectory=/opt/dutchbetting/DutchBetting
ExecStart=/usr/bin/yarn start -p 3000
Restart=always
Environment=NODE_ENV=production
[Install]
WantedBy=multi-user.target
```

## C. Moving the data

```bash
# from a machine that can reach the current database (use the existing DATABASE_URL — keep it secret)
pg_dump --no-owner --no-acl -Fc "$OLD_DATABASE_URL" -f dutch.dump
# into the new database
pg_restore --no-owner --no-acl -d "$NEW_DATABASE_URL" dutch.dump
# then make sure schema matches the code
yarn prisma db push
```

This carries users (bcrypt hashes, so passwords keep working), Kalshi credentials, settings, bet history,
predictions, value picks and calibration. Large tables: `ExternalPrediction`, `ValuePick`, bet/order logs.

## D. Docker / Vercel options

- **Docker:** build with `NEXT_OUTPUT_MODE=standalone yarn build`, copy `.next/standalone`, `.next/static` → `.next/standalone/.next/static`, and `public` → `.next/standalone/public`; run `node server.js`. Include matching Prisma `binaryTargets`.
- **Vercel:** works; set env vars in project settings, `NEXTAUTH_URL` = your domain, use Vercel Cron or external cron for doc 04 jobs. Hobby plan caps functions at 60 s — long ingest needs Pro (300 s).

## E. Post-move checklist

1. Log in (owner account `mattriedl@hotmail.com`).
2. Settings: Kalshi key present, environment correct (demo vs production); Polymarket signature type/funder.
3. Dashboard refresh loads Kalshi weather markets.
4. Soccer / Goals / Correct Score pages load data (API-Football, Odds API).
5. Value Tracker → pull/run button (download icon) adds picks (needs FootyStats leagues selected, max 50).
6. Recreate the five scheduled jobs (doc 04) with the **new** BASE URL; run each once by hand and confirm `success:true`.
7. Turn off the Abacus scheduled tasks so jobs don't run twice against the same database.
8. Visit an authenticated page while logged out → must redirect to `/login` (middleware working).

## F. Shipping changes while still on Abacus

The live site deploys from the Abacus project, not from GitHub. Open the app's Abacus conversation, describe
or upload the change, and ask for it to be tested and deployed. Saving a checkpoint only updates the preview;
a deploy is needed for the public site.

## G. Adding a new page or route (reminder)

Add the page under `app/(authenticated)/<name>/`, add it to `components/sidebar.tsx` navItems, and **add
`/<name>/:path*` to the matcher in `middleware.ts`** — otherwise expired sessions won't redirect to login.
