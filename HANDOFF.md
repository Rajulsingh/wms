# WMS — Project Handoff

Last updated: 2026-09-19. Read this first in any new session on this project. This doc was
consolidated on this date from a much longer session-by-session log — if you're looking for the
blow-by-blow of *how* something was built rather than what's true now, that detail still exists
in this file's edit history, but the goal here is "what's actually true right now," not a diary.

## What this is

A custom warehouse management system for **ecomglider** (www.ecomglider.com), an Amazon.in
seller. Astro (frontend + API routes) on Cloudflare Workers, D1 (SQLite) for data. Deployed and
live, actively used against real orders.

**Live app:** https://wms.mailrajulsingh-in.workers.dev
**Repo:** `wms/` is now a git repository (`git init` done 2026-09-19, first commit `6cda9d0` on
`main`) — before that date there was no version control at all, so if you're looking at history
from before this commit, it never existed as tracked history; everything before it is only as
safe as the filesystem was.
**Cloudflare account:** Mailrajulsingh.in@gmail.com's Account (`4b311214e2fe3391a39f9f315aa10382`)
**D1 database:** `wms-db` (`d71d4717-e454-4fb6-ad12-34811583b577`)
**Demo logins:** admin / `1234`, packer / `1111` (seeded in `scripts/seed.sql`, local dev only)

## Next steps — a prioritized plan

Ordered by what's actually blocking vs. what's just not-yet-built. See "Open items" below for
full detail on each.

1. ~~**UI simplification**~~ — **done** (2026-09-19). The user shared Amazon Seller Flex
   screenshots (dashboard, pick-list detail with a stepper, product-thumbnail table) and the
   entire `/admin/*` section was rebuilt around them: a persistent dark sidebar
   (`AdminSidebar.astro`) + content top bar (`AdminShell.astro`) replaced the old hamburger-
   dropdown/`.screen` shell; the dashboard order list became a real table with thumbnails and a
   KPI stat-card row; the Pick List page got a batch-lifecycle stepper (Create → Picking →
   Picked — deliberately *not* a literal Create/Pack/Ship, since packing/shipping happen per
   order/shipment in this schema, not per batch), a real scannable Code128 barcode
   (`jsbarcode`, client-side only) encoding the batch ID, and a scan-to-open control reusing
   `scanOnce()` from `scanner-client.ts`. `AdminNav.astro` was deleted (fully superseded).
   **Scope was `/admin/*` only** — `/picker`, `/packer`, `/login` and `TopBar.astro` were
   deliberately left untouched (verified in-browser); that mobile tap-first floor UI is a
   separate, already-settled decision, not part of this pass. See "Design system" below for the
   new component names. **Not done, follow-up if asked**: reusing the new `.stepper-bar` on the
   `ship`/`bulk-ship` wizard flows (they still use their original sequential-render pattern,
   just re-shelled into the new sidebar layout) — flagged as a nice-to-have in the original plan,
   not required to hit the requested look.
2. ~~**Admin mobile layout was actually overflowing horizontally**~~ — **fixed** (2026-09-19,
   same day as the redesign above). The user reported "it's not mobile optimized"; verified via
   `document.documentElement.scrollWidth` at 375px on every admin page, not by eyeballing
   screenshots. Two real bugs, not vibes: (a) `.stepper-step-line` was positioned `left:50%;
   width:100%`, which overshoots the *last* step by 50% of its own width — harmless on a wide
   desktop card (absorbed by whitespace) but the actual cause of page-level horizontal overflow
   on a phone; fixed by flipping to `left:-50%` so the line correctly spans from the *previous*
   step's center instead of overshooting past its own. (b) `.item-row` (used by
   users/warehouse/settings/bulk-ship/inbound) had no `flex-wrap`, so a name + 2 status pills +
   an action button would push content off-screen instead of wrapping — added `flex-wrap: wrap`.
   Also added a `@media (max-width: 600px)` block tightening `.admin-main`/`.admin-topbar`
   padding. All 10 admin pages now confirmed `scrollWidth === clientWidth` at 375px. If a future
   mobile complaint comes in, **verify with `document.documentElement.scrollWidth` first** —
   don't just eyeball a screenshot, the overflow direction bug here wasn't visually obvious on
   desktop at all.
3. ~~**Receiving's product search only knew about SKUs that had already been received**~~ —
   **fixed** (2026-09-19). The user pointed out it should "match Amazon inventory," searchable by
   ASIN/SKU/name. Investigated Amazon's actual capabilities before building anything (verified
   against Amazon's own published JSON schemas, not guessed — see the comments in `amazon.ts`):
   the Catalog Items API's `keywords` search covers the *entire* Amazon catalog, not this
   seller's own inventory, and its `identifiers`/`identifiersType` mode only does exact lookups,
   not fuzzy search — neither fits a live type-ahead box scoped to "what this seller sells."
   Built instead as a **sync**, not a live search: `fetchAllListings()` in `amazon.ts` pulls the
   seller's full catalog from the Listings Items API (`GET /listings/2021-08-01/items/{sellerId}`,
   paginated, capped at 1000 items), `syncAmazonCatalog()` in `catalog-sync.ts` upserts it into
   the local `skus` table (refreshes name/image_url only — never touches admin-owned `price`/
   `reorder_point`), exposed via `POST /api/admin/sync-amazon-catalog` and a "Sync Amazon
   catalog" button on `/admin/inbound`. The *existing* instant local product search then covers
   everything synced — no new search UI needed. **Confirmed working live against the real
   account**: synced 227 real listings on the first run, images and titles render correctly in
   Receiving's search. One real gotcha hit and fixed along the way: the Listings API's
   `mainImage` field is nested inside each `summaries[]` entry, not a top-level field on the item
   — the published schema doesn't make this obvious; confirmed by logging one raw response
   before trusting it. **Not done yet**: this is a manual "Sync Amazon catalog" button, not an
   automatic periodic sync (deliberately — wanted to confirm the Listings Items SP-API role was
   actually granted against the live account before adding a new recurring cron job; it is
   granted, so wiring this into the existing 5-minute `sync-job.ts` cron alongside order sync is
   a reasonable low-risk follow-up if the user wants listings to stay fresh automatically).
4. ~~**Pick batches were fragmenting into many single-order lists**~~ — **fixed** (2026-09-19).
   Removed eager auto-batching-on-arrival; batching now happens at claim time (`claimNextBatch`
   in `picker.ts`), sweeping every currently-open order into one batch the moment a picker's
   ready for it, capped at the cart's real `slot_count`. See "What's built" → "Claim-time
   pick-batch creation" for the full writeup, including a known low-risk race-condition
   limitation that was inherited, not introduced.
5. ~~**Picking was one card per order; user wanted bulk-by-SKU**~~ — **fixed** (2026-09-19).
   Picker now sees one aggregate line per SKU per bin across every order needing it, one "Mark
   done" tap. See "What's built" → the picking entry for the full writeup, including a real
   pre-existing batch-completion bug this work found and fixed. **Packing got the same treatment,
   part 1 of 3** (2026-09-19, same conversation) — multi-order batch packing is done (see "What's
   built" → the packing entry), including a second real bug found/fixed there too (an order whose
   items were all short/damaged showed a blank order id on the apply-labels screen). **Parts 2 and
   3 are still open** — see "Open items" #14 (bulk label content — blocked on the Easy Ship role;
   direct thermal-printer printing via QZ Tray — needs the printer model and current QZ licensing
   confirmed first). Don't start on either without re-reading that item; the physical floor
   workflow it documents is the actual spec.
6. **Get the Amazon Easy Ship SP-API role granted.** This is the one thing blocking real use of
   shipping (single-order, bulk, everything) *and* packing's bulk-label piece above. It's on the
   user, not something to keep investigating from this end — check Seller Central's
   app-authorization page for an "Easy Ship" scope. Once granted, the very first thing to do is a
   live smoke test of `/admin/ship` on one real order, watching closely for: the real
   `labelFileType` Amazon returns, which page of the combined PDF is actually the label
   (currently assumes last), and whether the `DocumentReportReferenceID` regex parse in
   `checkEasyShipFeed` actually matches Amazon's real feed-processing-report format. None of that
   has ever been exercised against a live account.
7. **Real box sizes.** Only one demo box exists. Needs the user to enter their actual box
   dimensions in the "Manage" menu → Zones/racks/stations, or wherever box sizes ended up (check
   `/admin/settings`).
8. **Confirm the ship-from address is real**, not the placeholder used during testing — check
   `/admin/settings` before the first real label purchase.
9. **Decide the 30-day data-disposal scope** (see open item, below) — this was *committed to
   Amazon in writing* with no enforcement code yet. Needs three scoping answers from the user
   before it can be built safely; the cron infrastructure already exists (`src/worker.ts`) so the
   actual job is easy to add once those answers exist — it can piggyback on the same scheduled
   handler pattern as the Amazon sync, doesn't need new plumbing.
10. **Smaller, ask-before-building items**: individually-strengthened admin auth (currently same
    weak PIN as floor workers), a public privacy policy URL for ecomglider.com, whether the
    picker/packer "no mandatory scanning" philosophy needs any adjustment now that pickup-slot
    labels exist, what should happen when an Amazon cancellation lands on an order that's already
    been fully picked/packed (currently just flagged via an exception event for manual putback —
    see "Automatic Amazon sync" below), and whether the Amazon catalog sync (item 3 above) should
    become automatic (periodic cron) rather than a manual button. None of these are urgent; don't
    build them unprompted.
11. **Minor cleanup, low priority**: `src/pages/api/picker/scan-item.ts` (and `verifyItemScan` in
    `picker.ts`) is dead code from before the picker dropped mandatory scanning — nothing calls
    it. Safe to delete next time you're in that area, not worth a dedicated pass on its own.
    `Warehouse` type in `types.ts` is missing the `ship_from_*` columns (cosmetic, nothing
    breaks).
12. **If the user says the UI still looks off somewhere else**, the fix pattern is already
    established (see "Design system" below) — reuse `AdminShell`/the existing component classes
    rather than inventing new ones. If it's specifically a *mobile* complaint, verify with
    `document.documentElement.scrollWidth` at 375px before guessing at a fix (see item 2 above —
    the real bug there wasn't visually obvious on desktop at all).

Already done this session, not repeated here — see "What's built" for detail: the Cloudflare
Cron Trigger (confirmed firing in production, real orders synced to `shipped`), automatic order
fetching, and the order-status filter tabs on `/admin`.

## Read this before touching anything

- The original spec (heavy NFC + per-unit barcode scanning) was **explicitly rejected by the
  user** as too complex for real volume ("i cant barcode every single product unit"). Both
  picking and packing now use tap-to-confirm against a photo/name, not scanning. **Do not
  reintroduce mandatory per-item scanning** without the user asking for it again. The one
  exception is the AWB/shipping-label scan at the end of packing — that's a real system-generated
  barcode, not a product barcode, and the safeguard reasoning for it still holds.
- Two roles only: `admin` and `packer` (the `role` column is a CHECK constraint enforcing this).
  `packer` covers both picking and packing. Don't reintroduce `supervisor`/`picker`/`dispatcher`.
  Named per-person logins exist (`/admin/users`) alongside the two original shared logins —
  both work, neither was removed.
- **Never purchase a real Amazon shipping label (single or bulk) without the user's explicit
  go-ahead in that session.** It spends real money / makes a real pickup commitment. Getting
  pickup slots is free and safe to test; scheduling is not.
- Amazon SP-API credentials in `.dev.vars` are **production**, not sandbox
  (`AMAZON_SPAPI_SANDBOX=false`). Calls hit the user's real seller account and real order data.
- The shipping integration targets Amazon's **Easy Ship** program (Amazon arranges pickup), not
  the classic Merchant Fulfillment Network (MFN) API. This was a real, hard-won discovery — the
  original build targeted MFN and 403'd for reasons that looked like a permissions problem but
  were actually "wrong API entirely." The MFN code (`getEligibleShippingServices`,
  `purchaseShipment` in `amazon.ts`; `getRatesForOrder`, `purchaseLabelForOrder` in
  `shipping.ts`; `/api/admin/shipping/rates.ts` and `purchase.ts`) is left in place, fully
  working, but **nothing in the UI calls it anymore**. Don't be confused into "fixing" its 403
  again — that's not the bug.
- If you paste secrets into chat, the user will (rightly) push back — write them straight to
  `.dev.vars` / `wrangler secret put` instead, never echo values back.

## Architecture

- **Astro** (SSR, `output: 'server'`) + **@astrojs/cloudflare** adapter, deployed as a
  Cloudflare Worker via `wrangler deploy`.
- **Custom Worker entrypoint** (`src/worker.ts`, replacing the adapter's default
  `@astrojs/cloudflare/entrypoints/server`) — needed to add a `scheduled()` handler alongside
  `fetch` for the Cloudflare Cron Trigger (see "Automatic Amazon sync" below). Wires in the
  adapter's own `fetch` handler via the public `@astrojs/cloudflare/handler` subpath export
  (`{ handle }`), so the HTTP side is untouched. `wrangler.jsonc`'s `main` points here instead of
  the adapter's package path. **This works because `@astrojs/cloudflare` v14+ wraps
  `@cloudflare/vite-plugin`**, which reads `wrangler.jsonc`'s `main` at Astro-build time and
  bundles whatever's there through the real Vite pipeline (resolving the adapter's internal
  virtual modules correctly) — confirmed by inspecting `dist/server/entry.mjs` after a build and
  seeing both `fetch` and the custom `scheduled` handler correctly bundled together. If a future
  Astro/adapter major version changes this integration, re-verify by checking that same built
  file rather than assuming the pattern still holds.
- **D1** for all relational data (`migrations/0001`–`0009`, applied in order — `--local` and
  `--remote` are separate databases, apply both whenever you add one; local dev DB lives under
  `.wrangler/state`).
- **PIN-based session auth**, stateless signed cookies (HMAC), `src/lib/auth.ts`. No password
  manager, no OAuth — intentionally minimal for a small warehouse team.
- **No Durable Objects** (free Workers plan). Inventory locking is optimistic concurrency on
  `inventory.version` (compare-and-swap), `src/lib/inventory.ts`. Documented upgrade path if
  write contention on a hot SKU ever becomes real — not needed yet.
- **Scanning**: `src/lib/scanner-client.ts` wraps `@zxing/browser` (pure-JS, works on Safari/iOS
  where the native `BarcodeDetector` doesn't exist). Only used now for packing-station tap-in and
  the AWB scan at the end of packing — not for item-level picking or packing anymore.
- **PDF handling**: `pdf-lib` (label stamping, `src/lib/label-stamp.ts`) and `fflate` (unzipping
  the bulk-schedule label ZIP, `src/lib/shipping.ts`) — both pure-JS, Workers-compatible, no
  `nodejs_compat` flag needed.
- Bindings: `env.DB` (D1), `env.ASSETS`. Reached via `import { env } from 'cloudflare:workers'` —
  **not** `Astro.locals.runtime.env`, which doesn't exist in this Astro version and will throw.

## Data model

Core chain: `warehouses → zones → locations (racks/bins) → inventory (SKU×location, many-to-
many) → skus`. Orders: `orders → order_items → pick_batches → pick_tasks → cart_slots`.
Packing: `pack_sessions → packages → shipments → awbs`. Inbound: `inbound_receipts →
inbound_receipt_lines` (increments `inventory.quantity_on_hand` directly — the counterpart to
`reserveInventory`, which only ever takes stock out).

Full schema is the migrations, read in order — each one is a real fix or feature, not a rewrite.
Notable ones:
- `0003` — `cart_slots` uniqueness scoped per-batch, not per-cart-lifetime. The migration itself
  needed a detach/rebuild/reattach workaround for a D1 limitation (can't toggle
  `PRAGMA foreign_keys` mid-transaction) — the pattern's in the file if another table ever needs it.
- `0005` — shipping-label fields (ship-from address, box sizes, label storage) — originally built
  for MFN, largely reused by Easy Ship (see below).
- `0006` — `UNIQUE` index on `users.name` for named logins (a plain index, not a table rebuild —
  `name` isn't referenced by any FK).
- `0007` — `inbound_receipts`/`inbound_receipt_lines` for receiving.
- `0008` — Easy Ship state machine columns on `shipments` (`package_identifier`,
  `handover_slot_id/start/end/method`, `scheduled_package_id`, `label_status`, `label_feed_id`,
  `label_report_id`) plus `skus.price` (admin-set list/MRP price).
- `0009` — `skus.reorder_point` for low-stock alerts.

## Design system

Warm, high-contrast, built for a warehouse floor (min 56px tap targets, system font stack — no
web-font request on unreliable warehouse Wi-Fi). Lives in `src/styles/global.css`. The
56px-tap-target rule is specifically a `/picker`/`/packer` floor requirement — the `/admin/*`
shell below targets desktop admin use and doesn't follow it.

- **Admin shell** (`/admin/*` only, added 2026-09-19 during the Seller-Flex-style redesign) —
  `AdminShell.astro` (`Base` + persistent sidebar + content top bar + `<main>` slot) and
  `AdminSidebar.astro` (dark, grouped nav links with icons; off-canvas drawer below ~900px via
  `.admin-sidebar`/`.admin-sidebar-toggle`). Every admin page is now `<AdminShell title="..."
  current="...">...</AdminShell>` — don't reintroduce the old `Base`/`TopBar`/`AdminNav`/
  `.screen` boilerplate this replaced (`AdminNav.astro` no longer exists). Sidebar is always
  dark navy regardless of the light/dark app theme (`--sidebar-*` tokens) — it's chrome, not
  content, matching Seller Flex's own always-dark sidebar. New reusable component classes:
  `.stat-grid`/`.stat-card` (KPI row, colored left border), `.stepper-bar`/`.stepper-step`
  (horizontal step tracker — reusable for any linear status progression, not just pick
  batches), `.table-thumb` (product image sized for a `<td>`, vs. `.thumb` for flex/`.item-row`
  contexts), `.truncate-cell` (ellipsis + `title` attr, used for the dashboard's product
  column), `.scan-row`/`.barcode-wrap` (scan-to-open input + rendered Code128 barcode, see Pick
  List page). If another admin screen needs a KPI row, a step tracker, or a thumbnail column,
  reuse these rather than inventing new ones.
- **Explicit light/dark switch**, not system-preference-following. `Base.astro` defaults to
  light and renders a fixed sun/moon toggle (top-right, every page) that sets `data-theme` on
  `<html>` and persists to `localStorage['wms-theme']`. An inline `<script is:inline>` in
  `<head>` applies the stored theme before first paint (no flash). `--accent: #ad3e0f` (light) /
  `#e8823f` (dark) — a rust/amber that reads as ecomglider's own tool rather than a generic
  template, used deliberately sparingly (primary actions, active states) not as a wash.
- **Elevation**: `--surface` (cards) is meaningfully lighter than `--bg` in both themes;
  `--surface-inset` (darker than `--surface`) is for inputs specifically, so they read as
  recessed rather than disappearing into the card around them. `--shadow-btn-primary` is a crisp
  near-black shadow with a faint accent tint — not a colored glow (an earlier version bled the
  accent color at near-full opacity and read as a cheap template effect; fixed).
- **Radius scale**, shape borrowed from Vercel's Geist materials docs (small controls get a
  tighter radius than large surfaces, values are original): `--radius-sm` (8px, buttons/inputs)
  < `--radius` (12px, cards) < `--radius-lg` (16px, the auth card).
- **Status pills**: `.status-pill` + `.status-neutral/-progress/-success/-warning`, small colored
  dot + text, used for order/pick-task status everywhere.
- **Navigation**: `src/components/AdminNav.astro` — a hamburger icon (`<details>/<summary>`,
  no JS needed) opening a dropdown with every admin page, current page highlighted. Used on all
  admin pages via `<AdminNav current="..." />` in `TopBar`'s slot. This replaced an earlier
  pattern of hand-written `<a class="pill">` links that multiplied per page and wrapped onto a
  second line once there were enough admin pages — if you're adding a new admin page, add it to
  `AdminNav`'s link list, don't hand-roll a nav pill.
- **Tables vs. cards**: data tables (`<table>` + `.table-scroll` for horizontal overflow) are
  fine for admin screens meant to be scanned/scrolled (inventory, pick-list). The admin orders
  list specifically uses `.order-card` rows instead — a table there forced horizontal scroll and
  mid-word wrapping on real (long) Amazon product titles. If another screen gets flagged as
  "looks cheap" for the same reason, reuse `.order-card`, don't invent a new pattern.
- `src/components/TopBar.astro` — brand mark + "ecomglider" wordmark + page section label, used
  on every screen including login (`.auth-shell`/`.auth-card`).

## What's built (current state, verified live)

- **Amazon order import** (`amazon.ts`, `orders.ts`) — SP-API Orders API, pulls real orders from
  the live account. Auto-creates SKUs (with real title + image from Amazon's Catalog Items API)
  for SellerSKUs not seen before. Region-aware endpoint routing (`MARKETPLACE_REGION` —
  India is EU-region, not NA; extend this map if a new marketplace 403s the same way).
- **Automatic Amazon sync** (`src/worker.ts`, `src/lib/sync-job.ts`, `src/lib/amazon-sync.ts`) —
  a Cloudflare Cron Trigger fires every 5 minutes and, per warehouse: pulls new orders (same as
  the manual "Import from Amazon" button — orders land as `pending`, batching happens separately
  at claim time, see "Claim-time pick-batch creation" below), and separately checks Amazon's
  *current* `OrderStatus` for every local Amazon order that isn't yet `shipped`/`cancelled`
  (`fetchOrderStatuses` in `amazon.ts`, using the `AmazonOrderIds` targeted-lookup parameter, not
  a broad re-pull). Amazon is treated as authoritative **only for the two terminal states**:
  - `Shipped` → local `status` is set to `'shipped'`. This is the **only** place that transition
    ever happens — nothing in the pick/pack flow sets it directly, since "shipped" is a real
    carrier event our own floor process can't claim on its own. (Before this existed, orders
    topped out at `ready_to_ship` forever — a real, now-fixed gap.)
  - `Canceled` → local `status` is set to `'cancelled'`, and any reservation for units **not yet
    physically picked** is auto-released back to available stock (pick_tasks still
    `pending`/`location_confirmed` get cancelled, their inventory reservation released via
    `releaseReservation`). Units already picked are left alone inventory-wise — the system has no
    idea which cart/station they're physically sitting in, so it can't safely auto-return them —
    instead it logs an `order_cancelled` exception event so a human does the physical putback.
  Everything **before** those two terminal states (batched/picking/picked/packing/packed/
  ready_to_ship) stays under our own floor-progress tracking and is never regressed by a coarser
  Amazon status — Amazon showing `Unshipped` doesn't mean anything to us once we've already
  picked it. **Confirmed firing in production**: watched `wrangler tail` catch the scheduled
  event (`"*/5 * * * *" @ 1:30:41 PM - Ok`), then found real `order.shipped_sync` audit rows
  (`user_id: null`, the sync job's signature) created a few seconds later, and confirmed 5 real
  Amazon orders actually flipped to `status = 'shipped'` in production as a direct result — not
  a simulated/local test, the real thing running unattended.
- **Claim-time pick-batch creation** (changed 2026-09-19 — see below for why). Orders sit as
  plain `pending` the moment they arrive (Amazon import or manual entry) — nothing batches them
  automatically on a timer or on arrival anymore. Batching happens in `claimNextBatch`
  (`picker.ts`), the moment a picker asks for work and there's no batch already waiting: it
  sweeps every currently-open order into one fresh batch, capped at the active cart's
  `slot_count` (not an arbitrary number — a batch bigger than the cart can physically hold isn't
  walkable in one pass anyway), and hands it straight to that picker. `autoBatchNewOrders` (the
  old eager-batch-on-arrival function) no longer exists — removed from `orders.ts` and its three
  call sites (`sync-job.ts`'s cron, `import-amazon-orders.ts`, the manual order-entry POST route).
  The manual "Create pick batch" button on `/admin` still exists and is unchanged — it still calls
  `createPickBatch` directly, so admin can force a batch early (e.g. to preview/print before a
  picker starts) without waiting for one to be claimed.
  **Why this changed**: the user observed real fragmentation — "many lists with just one order."
  With eager batching, every 5-minute Amazon sync (or every manual order entry) that landed even
  one order closed the books immediately and spawned its own small batch, since anything already
  batched had its status flipped away from `pending`/`allocated` and dropped out of the sweep.
  Claim-time batching fixes this with no added latency (a picker who's ready gets work exactly as
  fast as before) while naturally consolidating whatever piled up since the last claim into one
  walk-efficient batch — which is what actually matters, since a picker's list was already sorted
  `location, then SKU` within a batch (`getPickListView`), so same-SKU items across orders were
  always adjacent; they just weren't landing in the same batch often enough for that to help.
  Verified end-to-end locally: three orders entered independently (simulating separate arrival
  events) stayed `pending` with zero batches created, then a single `claimNextBatch` call swept
  all three into one batch ("3 orders, 3 lines" on the picker's own screen) — also confirmed
  against a real Amazon import (6 real orders landed as `pending`, no batch auto-created).
  **Known pre-existing limitation, not introduced by this change**: `createPickBatch`'s "which
  orders are still open" read isn't wrapped in a transaction/lock, so two pickers calling
  `claimNextBatch` in the same instant with no batch waiting could theoretically both sweep and
  claim the same order into two different batches. This risk already existed under eager batching
  (a cron tick racing a manual import) and is unlikely for a small team; a real fix would need
  D1-level locking or a Durable Object, which HANDOFF already documents as a deliberate "not
  needed yet" upgrade path for the same reason inventory reservation uses optimistic concurrency
  instead.
- **Picking — bulk, grouped by SKU** (`/picker`, `picker.ts`; redesigned 2026-09-19). A picker no
  longer sees one card per order — every order in the batch needing the same SKU from the same
  bin collapses into one aggregate line ("KTN3 required 7, picked 0/7"), pre-filled with the full
  remaining quantity, one "Mark done" tap to confirm. Zone/bin sectioning is still the outer
  walking order (physically unavoidable); the change is that fragmentation *within* a bin visit is
  gone. Underneath, nothing about per-order reservation tracking changed: `confirmGroupQuantity`
  (`picker.ts`) allocates the confirmed total across the group's underlying `pick_tasks` in
  priority/created-at order and settles each one through the same `confirmQuantity` a single-task
  pick always used — so picking less than the group total falls out as a normal short pick on
  whichever order(s) didn't get their full share, not a new concept. `reportDamaged` got a group
  wrapper (`reportGroupDamaged`) the same way. The two picker API routes
  (`mark-picked.ts`/`report-damaged.ts`) now take `pickTaskIds: string[]` instead of a singular id
  — always an array now, even for a group of one. Admin's printable/interactive pick-list
  (`/admin/pick-list`) groups the same way (`groupRowsBySkuLocation`) so the printed sheet matches
  what a picker actually works from. "Report issue" is now just "Damaged — none usable" for the
  whole group; a partial short pick is just editing the quantity down before tapping "Mark done."
  **Real bug found and fixed during this work**: `reportDamaged` never checked/updated batch
  completion the way `confirmQuantity` did — if a batch's very last outstanding line resolved via
  damage-report instead of a normal pick, the batch stayed stuck at `assigned`/`in_progress`
  forever and its order never flipped to `picked`, so it would never reach packing, *and*
  `claimNextBatch`'s resumable-batch check would keep handing that stuck batch back to the picker
  on every future claim, silently blocking them from new work. This bug predates the redesign
  above (reportDamaged's logic was untouched by it) but making damage-report a normal one-tap
  action instead of a buried sub-flow made it far more likely to hit. Fixed by extracting a shared
  `checkBatchCompletion` helper and calling it from both `confirmQuantity` and `reportDamaged`.
  Verified live: reproduced the stuck-batch symptom with a real order, confirmed the fix resolves
  it (`pick_batches.status` → `completed`, `orders.status` → `picked`).
  **Packing was deliberately left unchanged in this pass** — the user asked for the same
  "sorted by SKU, bulk" treatment there too, but packing is structurally one-order-per-session
  today (`startNextPackSession` pulls one order, one AWB/label per session) since each order needs
  its own box and its own label regardless of how picking is grouped. Doing the equivalent there
  for real (sorting a picked batch's SKUs across several simultaneously-open order boxes, only
  seal/label each one once its own box is complete) is a materially bigger, higher-risk change —
  it touches the AWB/label-application path, which HANDOFF already flags as sensitive/undertested
  against a live account. Needs a scoping conversation before touching it, not a guess.
- **Packing — bulk, multi-order per batch** (`/packer`, `packer.ts`; redesigned 2026-09-19, "Open
  items" #14 part 1 of 3). Station tap-in is unchanged. What changed: a pack "session" now covers
  a whole `pick_batch` instead of one order — `startPackingBatch` opens one `pack_sessions` row
  per order in the batch (migration 0010 added `pack_sessions.pick_batch_id`; `packages`/
  `shipments`/`awbs` all stay order-scoped, unchanged, since each order still needs its own box
  and its own label), and the packer sees the same SKU-grouped bulk view picking uses — one
  aggregate line per SKU across every order in the batch needing it, one "Mark done" tap
  (`markPackGroup`, mirrors `confirmGroupQuantity` in picker.ts: allocates the confirmed total
  across the underlying `order_items` in priority/created-at order, no reservation/short-pick
  concept here since that already happened at picking — packing just records what physically went
  in each box, capped at what picking actually delivered). Labels are deliberately **not** applied
  per order as packing finishes — only once every order in the batch is fully packed
  (`completePackingBatch`, which reuses the exact same per-order `completePackSession` the old
  flow always used, just looped across the batch) does the packer move to a separate "apply
  labels" phase: a queue of the batch's orders, one AWB scan/manual-entry per order (`applyAwb`
  itself is completely unchanged — AWB application is inherently per-order, that was never going
  to change). This matches the floor workflow the user described: pack everything first
  (physically arranging finished boxes SKU-sorted on the table), then label everything at once
  matching that same order.
  **Edge case, worth knowing**: an order whose items all came back short/damaged during *picking*
  has nothing left with status `picked`/`packed`, so it legitimately shows zero SKU lines to pack
  — `getPackBatchState` treats it as vacuously "already packed" (nothing to do) and it goes
  straight into the apply-labels queue. The UI says so explicitly ("Nothing to pack — every item
  on these orders came back short or damaged while picking") rather than showing a bare "0 SKU
  lines" with no explanation, which is what it did before this was noticed and fixed during
  testing. Also fixed during testing: `getPackBatchState` used to derive an order's
  `external_order_id` from its (possibly nonexistent, in that same edge case) items instead of
  reading it directly from `orders` — showed up as a blank order id on the apply-labels screen for
  exactly the all-short/damaged case above.
  **Not built yet** — parts 2 and 3 of the same redesign (bulk label content: SKU-sorted, short
  SKU code stamped, invoice pages stripped; and direct thermal-printer printing, likely via QZ
  Tray). See "Open items" #14 for the full three-part breakdown and what's blocking each.
- **Pick/Pack tabs + notifications** — `/picker` and `/packer` are separate routes but present as
  tabs (`.tab-pill` in `TopBar`), each with a red badge dot when work is waiting on the *other*
  tab. `GET /api/packer/work-summary` (packer role) returns `{ pickable, packable }` counts,
  polled every 10s from both pages. Never shows price — see below.
- **Live auto-refresh** — polling, not push. `/admin` refreshes its orders list every 12s;
  `/picker`'s "No batches" and `/packer`'s "No orders waiting" screens poll every 8s. All skip
  the tick when the tab is backgrounded (`document.hidden`). Good enough for this team's volume;
  if it ever needs to feel more instant, Durable Objects WebSockets is the documented upgrade
  path (not needed yet).
- **Inbound receiving** (`/admin/inbound`, `inbound.ts`) — type-ahead product search (title or
  SKU code, results show photo + name + code + price) with a "can't find it, create new SKU"
  fallback. Puts stock directly into a bin, creating the SKU×location `inventory` row if it
  doesn't exist yet (`INSERT ... ON CONFLICT DO UPDATE`). A "Sync Amazon catalog" button
  (`POST /api/admin/sync-amazon-catalog`, `catalog-sync.ts`, `fetchAllListings` in `amazon.ts`)
  pulls the seller's full Amazon listings catalog (Listings Items API, paginated, capped at 1000)
  and upserts every SellerSKU into local `skus` — this is what makes the search above cover
  everything the seller sells, not just SKUs an order has referenced. Manual trigger, not an
  automatic cron yet (see "Next steps" #10). Refreshes name/image_url only; never touches the
  admin-owned `price`/`reorder_point` fields.
- **Inventory management** (`/admin/inventory`) — every SKU×location row with on-hand/reserved,
  editable on-hand (a direct correction, not a reservation-flow operation — for miscounts/damage
  write-offs, every edit audit-logged with before/after) and editable price.
- **Reports dashboard** (`/admin/reports`) — available/reserved stock per SKU, 7-day and 30-day
  pick velocity, an editable reorder point per SKU driving a low-stock banner (default threshold
  5 units if unset), and a daily-units-picked table. "Outbound" here means units *picked*
  (`pick_tasks.picked_at`) — the closest proxy this schema has to a ship date; there's no
  separate per-unit ship-confirmation timestamp. If the user ever wants true ship-date tracking,
  that's a new column, not a different query.
- **Admin management pages** — `/admin/users` (named per-person logins, create/deactivate,
  4-8-digit PIN, never a hard delete), `/admin/warehouse` (CRUD for zones, locations/bins,
  packing stations), `/admin/settings` (ship-from address, box sizes).
- **Order status filter tabs** on `/admin` — All / New / Processing / Ready to ship / Shipped /
  Cancelled, each with a live count, filtering the same already-fetched order list client-side
  (no extra API call per tab). The grouping buckets our more granular internal statuses under
  standard-WMS-style labels (`STATUS_GROUPS` in `admin/index.astro`) — e.g. "Processing" covers
  batched/picking/picked/packing/packed/partial. Purely a display filter, doesn't change what
  data is fetched or how status transitions work.
- **Shipping — Easy Ship** (`amazon.ts`, `shipping.ts`, `/admin/ship`, `/admin/bulk-ship`) —
  schemas confirmed against Amazon's published SP-API reference and (for the bulk endpoint) an
  actual Go SDK's generated types, not guessed. **Blocked on SP-API role grant, never exercised
  live** — see "Next steps" above.
  - Single order: `listHandoverSlots` → admin picks a slot → `scheduleEasyShipPackage` (no label
    in the response) → separate async Feeds/Reports pipeline to actually retrieve the label PDF
    (`requestEasyShipDocuments`/`checkEasyShipFeed`/`checkEasyShipReport`, polled from the UI,
    never awaited synchronously in one request — Amazon's processing time is unbounded).
  - Bulk (`/admin/bulk-ship`): `createScheduledPackageBulk` schedules multiple orders in one call
    and returns `printableDocumentsUrl` — a ZIP of every label, generated synchronously, no
    Feeds/Reports polling needed for this path. The ZIP is unzipped (`fflate`) and PDF entries
    are matched to orders **positionally** (an unconfirmed assumption); if the entry count
    doesn't match the order count, every scheduled shipment falls back to sharing the raw,
    unstamped ZIP rather than risk mis-assigning a label.
  - Label stamping: `stampPackageIdentifier` in `label-stamp.ts` prints an admin-entered package
    identifier (not SKU/qty — that was the original ask, superseded when the user clarified they
    wanted Amazon's own "Package Identifier" field instead) bottom-right on the label PDF.
- **Price visibility**: `skus.price` is an admin-set list/MRP price (not Amazon's actual
  per-order sold price, which isn't captured). Shown on `/admin` and `/admin/inventory`.
  **Packers never see it** — enforced by simple omission (picker/packer SELECT queries never
  include `price`); there's no central role-based field filter, so any new packer-facing query
  that joins `skus` must deliberately leave price out.

## Known bugs fixed / lessons (worth knowing, not just history)

- **Every path that resolves a pick_task's terminal state must check batch completion** — not
  just the "normal" one. `confirmQuantity` (a real/short pick) always checked whether the whole
  batch was done and flipped `pick_batches.status`/`orders.status` accordingly; `reportDamaged`
  didn't, for no principled reason — it just predated that check being added and nobody carried
  it over. If damage-report happened to resolve a batch's very last outstanding line, the batch
  got stuck at `assigned` forever, its order never reached `picked` (never showing up for
  packing), and `claimNextBatch`'s resumable-batch check kept re-handing that stuck batch to the
  picker on every future claim — a real dead end, not just stale data. Fixed by extracting
  `checkBatchCompletion` in `picker.ts` and calling it from both places. If picker.ts ever grows
  another way to resolve a pick_task (a new exception type, an admin override), it needs this
  same call — the bug is exactly "forgot this one call," easy to repeat.
- **D1 FK deletion order** — when deleting an order and everything under it, the safe order is:
  `exception_events` → `returns` → `awbs` → `shipments` → `packages` → `pick_tasks` →
  `cart_slots` → `pack_sessions` → `pick_batches` → `order_items` → `orders`. `cart_slots` and
  `pick_tasks` are easy to get backwards (`pick_tasks.cart_slot_id` references `cart_slots`, so
  `pick_tasks` must go first) — check migration `0001`'s `REFERENCES` clauses if unsure. D1 runs
  a whole `--file` as one transaction and rolls back cleanly on any FK violation, so a failed
  attempt is safe to just fix and retry.
- **D1 result typing isn't runtime-validated** — a camelCase TS interface over a snake_case D1
  query result type-checks fine and silently breaks every field access at runtime. Make interface
  field names match SQL aliases *exactly*. (Found via `packer.ts` once; keep double-checking new
  raw-SQL queries by eye.)
- **Bind-argument count mismatches** aren't caught by `astro check`, only at runtime (`Wrong
  number of parameter bindings`) — double-check placeholder count against `.bind()` args on every
  new raw insert.
- **`Astro.locals.runtime.env` doesn't exist** in this Astro version — use
  `import { env } from 'cloudflare:workers'`.
- **`cart_slots` uniqueness must be scoped per-batch**, not per-cart-lifetime (a physical cart is
  reused across batches) — see migration `0003` if another table needs the same fix pattern.
- **Marketplace region matters** — a request to the wrong SP-API regional endpoint 403s
  indistinguishably from a real permissions problem. Check `MARKETPLACE_REGION` in `amazon.ts`
  before assuming a 403 is a role/scope issue — this exact mistake ate significant time twice
  (once for MFN, understandably, since MFN actually was the wrong API entirely that time).
- **SP-API sandbox mode needs Amazon's literal magic values** if it's ever turned back on
  (`AMAZON_SPAPI_SANDBOX=true`) — `CreatedAfter=TEST_CASE_200`, and the *same* literal string as
  the order id path parameter for `getOrderItems`, not the real order id sandbox just handed
  back. Real dates/filters don't work in sandbox at all. Documented inline in `amazon.ts`.
  Currently off — production credentials are in use.

## Open items

Roughly in the order they'll come up; "Next steps" above is the short prioritized version of
this list.

1. **Amazon Easy Ship SP-API role not yet granted** — blocks all shipping (single + bulk) *and*
   packing's bulk-label piece (item 14 below). See "Next steps" #6.
2. **Real box sizes** not yet entered (only one demo box exists).
3. **Confirm ship-from address is the real one**, not a placeholder.
4. **30-day data disposal — committed to Amazon in writing, not yet built.** Needs three scoping
   decisions from the user before writing a Cloudflare Cron Trigger: (a) does 30 days purge just
   buyer PII or the whole order record (the latter conflicts with wanting sales/accounting
   history); (b) is the audit log (no PII, just picker/packer actions) exempt or also purged;
   (c) does the 30 days count from order creation or ship/completion date. Get these answered
   before writing the job — over-deleting loses records the user wants, under-deleting makes the
   stated Amazon policy false.
5. **Admin account has the same weak PIN auth as the floor-worker login** — flagged as a real gap
   in the compliance answers, not yet strengthened. Revisit if/when the user wants to act on it.
6. **Privacy policy URL** — Amazon's Data Protection Policy form asks for one; unclear whether
   ecomglider.com has a public one.
7. **No automated PII protection for test/dev data** — real customer PII was used directly from
   the live Amazon account during development. Flagged as worth moving to sandboxed/anonymized
   data going forward, not yet changed.
8. **DLP/USB monitoring, formal incident response plan, vulnerability-scan cadence, and a
   SAST/dependency-scanning pipeline** are unformalized — answered honestly as "not yet in place"
   on the compliance form, per the user's own "we'll build this as we move ahead." Intentional,
   acknowledged gaps, not oversights. `npm audit` was run once (0 vulnerabilities) as a one-off,
   not a recurring process.
9. **Cycle counting** (periodic stock audits, distinct from receiving) — explicitly out of scope
   when the inbound module was built. Real gap if the user ever wants periodic physical counts
   reconciled against system stock.
10. **Daily outbound is picking volume, not ship-date volume** — see "What's built" → Reports.
    Revisit only if the user specifically wants true ship-date tracking.
11. **Dead code**: `src/pages/api/picker/scan-item.ts` / `verifyItemScan` in `picker.ts` — left
    over from before the picker dropped mandatory scanning, nothing calls it. Safe to delete.
12. **Cosmetic**: `Warehouse` type in `types.ts` doesn't include the `ship_from_*` columns from
    migration `0005` — `shipping.ts` has its own local type for the query it needs, nothing
    breaks.
13. **Untested at scale / against a live Amazon account**: the entire Easy Ship integration
    (slots, single schedule, bulk schedule, label retrieval both paths). Everything UI-testable
    without live Amazon access has been checked (forms, order selection, package-identifier
    fields, polling); the actual Amazon calls have not. Treat the bulk ZIP-splitting logic in
    particular as higher-risk than the rest of the app until verified.
14. **Packing bulk/SKU-grouped treatment — part 1 of 3 done, 2 and 3 still open.** The user asked
    for the same bulk treatment picking got on packing too; scoped in conversation (2026-09-19)
    into three pieces. **Here's the actual floor workflow this is meant to replace**, as described
    by the user, since it's the spec for all three pieces: admin currently hand-writes a pick list
    (SKU + quantity, with multi-qty/free-item/special-requirement notes called out per line); the
    packer picks everything for the whole batch at once, then packs every order's box (not one
    order fully start-to-finish before starting the next), physically arranging finished-but-
    unlabeled boxes *in SKU order* on the table as they go; only once the whole list is packed does
    admin generate all the shipping labels for the batch in that same SKU order; the packer then
    walks the table matching labels to boxes in order (fast, because both are sorted the same way)
    and scans each AWB as they apply it to mark that order ready-to-ship.
    1. ~~**Multi-order batch packing**~~ — **done** (2026-09-19). See "What's built" → the packing
       entry for the full writeup. **Not included**: a real per-order notes/special-instructions
       field — today there's still nowhere to record "free gift included" or "multi-qty, double-
       check count," it only exists on the admin's handwritten paper. Small, additive, worth doing
       as a fast-follow if the user wants the paper list fully retired.
    2. **Bulk label content — blocked on the Easy Ship SP-API role** (same blocker as "Next
       steps" #2/#4). Once a batch is scheduled via `/admin/bulk-ship`, the resulting labels need
       to: be ordered to match the SKU-sorted packed boxes (not whatever order Amazon's bulk
       response happens to return — `createScheduledPackageBulk`'s ZIP-splitting is already
       flagged in item 13 as unverified against a live account, and this SKU-ordering requirement
       adds to what needs checking once real label content is finally visible); have the SKU's
       short code (not the arbitrary free-text "Package Identifier" `stampPackageIdentifier`
       stamps today) printed bottom-right; and have invoice pages stripped out of Amazon's
       combined label+invoice PDF so only the actual shipping-label page reaches the printer —
       none of this can be built with confidence until a real label PDF from this account can
       actually be inspected.
    3. **Direct thermal-printer printing — needs two answers from the user first, not blocked
       otherwise.** A Cloudflare Worker can't reach a printer sitting on the warehouse's local
       network; the realistic approaches are either the browser's own print dialog (sized to 4x6,
       admin/packer selects the printer once) or a local print-bridge app. **QZ Tray** (a small
       Java-based background app + a `qz-tray.js` library the web app talks to over a local
       WebSocket) was discussed and is a reasonable fit — it's the standard tool for silent
       browser-to-local-printer printing (raw ZPL/EPL for thermal printers, or rasterized PDF),
       which is exactly this use case, and there's no way to get *true* silent/automatic printing
       from a web app without some local bridge like it. Before building against it: (a) **the
       printer's make/model** — determines whether the integration sends raw ZPL (typical for
       Zebra-style thermal printers) or rasterized output; (b) **current QZ Tray licensing for
       this deployment's scale** — the core software is free/open-source, commercial digital-
       signing (avoids a security prompt on every print job) is a paid tier last this was
       discussed, but terms shift, so confirm current pricing on QZ's own site rather than trust
       a number here.

## Amazon Data Protection Policy questionnaire — what was submitted

Required before the Orders/Shipping SP-API roles would fully activate. Answers were drafted
collaboratively and submitted; worth knowing for next time:

- **Incident Management Point of Contact (IMPOC)**: Rajul Singh, ecomglider.com@gmail.com.
- **Data disposal**: committed to 30 days (see open item 4 — not yet enforced by code).
- **Approach taken on every question**: answer honestly from what's actually true of the system
  (verified facts — e.g. D1 has no public endpoint, Cloudflare handles encryption at rest, D1's
  Time Travel gives 30-day point-in-time recovery, `npm audit` found 0 vulnerabilities) rather
  than claiming enterprise-grade practices that don't exist. Several answers explicitly state
  "not yet formalized" (written IR plan, DLP monitoring, documented password policy). **Do not
  retroactively "upgrade" these answers to sound more mature than reality without the user
  asking** — they were deliberately honest, and Amazon can hold the seller to whatever was
  stated. This is the reference precedent for any future Amazon compliance question: split each
  question into "what I can verify about the actual system" vs. "what's an org-level fact only
  the user can state," and never fabricate specifics (named people, certifications, metrics) on
  the user's behalf.

## Commands

```bash
# local dev (background; check status/logs/stop with `astro dev status|logs|stop`)
npx astro dev --background

# type-check
npx astro check

# apply a new migration
npx wrangler d1 migrations apply wms-db --local    # local dev DB
npx wrangler d1 migrations apply wms-db --remote   # production DB — separate database, apply both

# seed local dev data (scripts/seed.sql) — not idempotent, don't run twice without checking

npx wrangler d1 execute wms-db --local --file=scripts/seed.sql

# build + deploy
npm run build && npx wrangler deploy

# set a production secret (never echo the value back to the user in chat)
echo "value" | npx wrangler secret put SECRET_NAME
```

## Secrets (values live in `.dev.vars`, gitignored — never in this file, never in chat)

`AMAZON_LWA_CLIENT_ID`, `AMAZON_LWA_CLIENT_SECRET`, `AMAZON_REFRESH_TOKEN`,
`AMAZON_MARKETPLACE_ID`, `AMAZON_SPAPI_SANDBOX`, `AMAZON_MERCHANT_ID` (used as the `sellerId`
path parameter for the Listings Items API catalog sync, added 2026-09-19 — see `fetchAllListings`
in `amazon.ts`), `SESSION_SECRET`. All mirrored as Worker secrets in production via
`wrangler secret put` — if you rotate one locally, push it to production too, they don't sync
automatically.
