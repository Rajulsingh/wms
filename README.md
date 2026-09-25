# WMS

A warehouse management system for Amazon (Easy Ship) sellers, built on Astro + Cloudflare Workers, D1, and R2.

Live at [wms.mailrajulsingh-in.workers.dev](https://wms.mailrajulsingh-in.workers.dev).

## What it does

- **Amazon order sync** — pulls orders from Amazon on a schedule (Cloudflare Cron, restricted to the warehouse's live picking/packing window) and keeps inventory/catalog in sync.
- **Picking & packing** — dedicated picker and packer stations with barcode scanning (`@zxing`), station assignment, and single-SKU batch packing.
- **Returns** — scan-verified returns intake with label/product photo capture, stored in R2, and CSV export.
- **Inbound & inventory** — inbound receiving and stock tracking.
- **Shipping** — bulk ship and label generation (`pdf-lib`, `jsbarcode`), plus Amazon Easy Ship pickup scheduling.
- **Attendance** — warehouse staff attendance tracking.
- **Admin dashboard** — orders, exceptions, reports, pick-list/pick-assign, users, org accounts, and settings.
- **Onboarding** — signup, password setup, connect-Amazon flow, and warehouse setup for new orgs.

## Stack

- [Astro](https://astro.build) (SSR) on the [Cloudflare Workers](https://developers.cloudflare.com/workers/) adapter
- [D1](https://developers.cloudflare.com/d1/) for the primary database
- [R2](https://developers.cloudflare.com/r2/) for returns intake photos (private, served through an auth-gated API route)
- Cloudflare Cron Triggers for scheduled Amazon sync

## Development

```sh
npm install
npm run dev
```

Copy `.dev.vars` (see repo owner for values — not committed) for local secrets.

## Deploy

```sh
npm run build
npx wrangler deploy
```

`wrangler.jsonc` runs `npm run build` automatically before deploy, so `./dist` is never stale.

See [HANDOFF.md](HANDOFF.md) for detailed operational notes, known issues, and history; [AGENTS.md](AGENTS.md) for dev-server conventions.
