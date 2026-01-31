# Madison Internet Status

A warm, editorial dashboard for `https://madisonsadler.com/status` backed by Cloudflare Pages, Workers, and D1.

## Repo structure

```
/web        → Cloudflare Pages frontend (Astro)
/worker     → Cloudflare Worker (API + Cron)
/db
  └ schema.sql
```

## Configuration

1. Copy the sample environment file and add values:

```
cp .env.example .env
```

2. Update `/worker/wrangler.toml` with your D1 database ID and name.

## D1 setup

```
cd worker
wrangler d1 create madison-status
wrangler d1 execute madison-status --file ../db/schema.sql
```

## Worker deployment

```
cd worker
wrangler deploy
```

## Pages deployment

```
cd web
npm install
npm run build
```

Deploy the `web/dist` output directory to Cloudflare Pages. Configure the Pages project to proxy `/api/*` to the Worker (Pages "Functions" routes or project routing). Example:

```
# In the Pages dashboard → Settings → Functions → Routes
/api/*  →  madison-status-worker
```

## API usage

- `GET /api/status/summary` returns the latest tiles and incident log.
- `GET /api/status/history?key=uptime:site&range=24h` returns chart history.
- Admin endpoints require `Authorization: Bearer <ADMIN_TOKEN>`.

```
POST /api/admin/refresh
POST /api/admin/now
Body: { "text": "Calmly shipping." }
```

## Local development

```
cd worker
wrangler dev
```

```
cd web
npm install
npm run dev
```

Point your local Pages dev server to the Worker by configuring a proxy in your preview environment.
