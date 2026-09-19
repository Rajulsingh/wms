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

## Recently done (2026-09-19) — full detail lives elsewhere, not repeated here

One long session. Each line is a pointer, not the story — see "What's built", "Design system",
or "Known bugs fixed / lessons" for the actual detail, including the real bugs found along the
way (a batch-completion check missing from `reportDamaged`; a blank order id on packing's
apply-labels screen). Don't re-litigate or redo any of these without a reason.

- **Admin UI rebuilt around Seller Flex screenshots** — sidebar shell (`AdminShell`/
  `AdminSidebar`), KPI stat cards, a real order-table with thumbnails, a pick-list stepper +
  scannable barcode. `/admin/*` only; `/picker`/`/packer`/`/login` untouched. See "Design system".
- **Admin was overflowing horizontally on phones** — two real CSS bugs, fixed (a stepper-line
  math error, missing `flex-wrap` on `.item-row`). See "Next steps" #7 for how to verify a future
  mobile complaint the same way (`scrollWidth`, not eyeballing).
- **Receiving's search now covers everything sold on Amazon**, not just SKUs an order has
  referenced — built as a manual "Sync Amazon catalog" sync (Listings Items API), not a live
  search (Amazon's catalog search isn't seller-scoped). See "What's built" → Inbound receiving.
- **Pick batches no longer fragment into single-order lists** — batching moved from eager
  (on every order arrival) to claim-time (`claimNextBatch`). See "What's built" → Claim-time
  pick-batch creation.
- **Picking is bulk/SKU-grouped**, not one card per order. See "What's built" → the picking entry.
- **Packing is bulk/multi-order per batch** (part 1 of a 3-part ask — parts 2/3 still open, see
  "Open items" #14). See "What's built" → the packing entry.

## Recently done (2026-09-19, later in the same day) — picker/packer UX pass

A second, separate round of work the same day, after the bulk-picking/packing redesign above.
User-requested: a reason dropdown on short/damaged picks, a clearer required-vs-picked display,
admin-assignable batches, a packer dashboard, no more "get next batch" click gate, and
instant-feeling taps. See "What's built" for the actual behavior; this is just the pointer list.

- **Picker "Report issue" is now a reason dropdown**, not a single "Damaged" button — "Damaged —
  none usable", "Low stock — not enough available", or "Other" (free-text note). Also fires
  automatically whenever the entered quantity is less than what's needed, not just from the
  standalone button. See "What's built" → the picking entry, and `confirmQuantity`/
  `confirmGroupQuantity`'s new `reason` parameter in `picker.ts`.
- **Required and Picked are now two explicit, always-visible numbers** on each SKU card, not a
  compact "M/N" fraction — a short pick used to just say "Done" with no indication it was short.
  See `renderSkuGroup` in `src/pages/picker/index.astro`.
- **Admin can hand-assign a specific pick batch to a specific packer** (`/admin/pick-list`, a new
  "Assigned to" control on the batch card) instead of every batch going into the general
  first-picker-who-asks pool. See `assignBatchToPacker` in `picker.ts`.
- **New packer dashboard** (`/packer/home`) — what's assigned to you, plus a read-only "pulled but
  not yet assigned" list so a packer can see work coming without claiming it early. See "What's
  built" → Packer dashboard.
- **The picker page is one continuous scroll of every batch you have**, not "claim one, finish it,
  click for the next." New batches (admin-assigned, or freshly auto-swept once you're caught up)
  just append at the bottom. See "What's built" → the picking entry, `getMyBatches` in `picker.ts`.
- **Picking/packing taps update the screen immediately**, not after the round trip — optimistic
  local update first, reconciled with the server's response a moment later, rolled back on
  failure. See `submitPick`/`submitDamaged` in `picker/index.astro`, `handleMarkPacked` in
  `packer/index.astro`.
- **The logo in the top bar is now a link back to a home page** — `/packer/home` for
  picker/packer, `/admin` for admin's sidebar logo (which was already admin's own home page).
- **Real bug found and fixed**: the new Required/Picked stat block on a SKU card overflowed
  horizontally on a 375px phone (`scrollWidth` 407 vs 375) — the thumb + name + stat block tried
  to fit in one row. Fixed by moving Required/Picked to their own row below the name instead of
  cramming everything into one `flex` row. Another instance of "verify with `scrollWidth` at
  375px, don't eyeball it" (see "Next steps" #7 below — this is the second time that's caught a
  real bug this project didn't see coming from a desktop screenshot).

## Recently done (2026-09-19, a third pass the same day) — the follow-up punch list

After the picker/packer UX pass above, the user asked for a punch list of what was still
outstanding, then said "fix them one by kne [one by one]." Four items, all fixed and verified live
in a local browser session (test orders created, exercised, then cleaned up — nothing left behind
in the local dev DB), **then deployed to production** (migration `0011` applied `--remote`,
`npm run build && npx wrangler deploy`) — this is the first of the day's three UX passes that
actually reached the live site before a follow-up bug report came in; see the next section.

1. **"Instant" extended beyond just picking/packing's Mark-done button.** Two different fixes
   depending on whether the outcome could be predicted:
   - Admin's "Import from Amazon", "Create pick batch", and the pick-list "Assign" button, plus
     packer's station tap-in buttons — none of these can be guessed optimistically (a real network/
     DB call decides the actual result), so instead they disable themselves and show a loading
     label ("Importing…", "Creating…", "Assigning…", "Connecting…") the instant they're tapped,
     rather than sitting inert until the round trip resolves. New helper: `withLoading()` in
     `src/lib/ui.ts`.
   - Packer's "Finish packing — apply labels" button *can* be predicted (once it's clickable,
     `completePackingBatch` always succeeds for exactly `state.orders` — the only failure mode is a
     real error, never a partial result), so it now jumps straight to the apply-labels queue before
     the network call resolves, reconciled after.
   - AWB scan/manual-entry is a hard-block safety check (duplicate/mismatch), so it deliberately
     stays *not* optimistic — but now shows an immediate "Checking &lt;code&gt;…" screen instead of
     looking inert while the check runs.
2. **Real bug fixed: partial short-picked items never reached the packing view.**
   `getPackBatchState`'s (and `getPackSessionState`'s) items query only matched `order_items.status
   IN ('picked', 'packed')` — a *partial* short pick (`status = 'short'`, `quantity_picked` between
   0 and required) was silently excluded even though real units were physically picked and needed
   to go in a box. Fixed by widening both queries to also match `status = 'short' AND
   quantity_picked > 0` (a fully-zero short/damaged line still correctly has nothing to pack). This
   was tracked as Open item #15 — now resolved, removed from that list. Verified live: a 5-of-8
   partial short pick correctly showed up in packing with the right quantity.
3. **Admin can now unassign a batch**, not just assign/reassign one. Reuses the same "Assigned to"
   control on `/admin/pick-list` rather than a separate button — picking "— Unassigned —" and
   submitting clears `assigned_picker_id` and puts the batch back to `status = 'pending'` (the
   general claim pool), same gate as assigning (blocked once a picker has actually started, i.e.
   `in_progress`). `assignBatchToPacker` in `picker.ts` now takes `packerId: string | null`.
4. **Per-order notes/special-instructions field**, the one explicitly-deferred piece from the
   picking/packing redesign earlier in the day. New `orders.notes` column (migration `0011`,
   nullable free text). Admin edits it inline on `/admin` — a compact "+ Add note" button per row
   (not an always-visible input in every row of what can be a 100-row table) that expands to a real
   input + Save/Cancel just for that cell. Surfaced to the floor on both `/picker` and `/packer` in
   the order-breakdown line under each SKU card, and additionally on packer's apply-labels/AWB
   screen (arguably the most useful spot for "free gift included" — it's the last thing seen before
   a box ships). **Real bug found and fixed while building this**: the admin orders table's 12s
   auto-refresh was rebuilding the whole table (and wiping out an in-progress note edit) before
   there was a chance to hit Save — reproduced directly while testing. Fixed by skipping that
   refresh tick while a note editor is open (`ordersTable.querySelector('.note-input')`), and added
   a Cancel button (previously there was no way to back out of an opened editor at all except
   letting a refresh clobber it).
   **Also fixed in the same pass, not asked for but found by inspection**: none of this note text
   was HTML-escaped before being dropped into `innerHTML` templates (a pre-existing gap — nothing
   in this app escapes user-entered strings before templating them into the DOM, and free-text
   notes were the first field that made this a *stored* XSS risk rather than a theoretical one,
   since an admin's note is later rendered on every picker's and packer's screen). New
   `escapeHtml()` helper in `src/lib/ui.ts`, used everywhere the note itself is rendered (admin's
   table cell and edit input, `/picker`'s and `/packer`'s order-breakdown lines, packer's AWB
   screen). Order IDs and scanned AWB codes picked up the same escaping while in there, since
   they're rendered the same way. This was **not** applied as a general audit of every other
   pre-existing unescaped field in the app (e.g. `first_item_name`'s title attribute on `/admin`)
   — only the new notes feature and what it touched. Worth a dedicated pass if the user wants one.

## Recently done (2026-09-19, a fourth pass) — real production bug, caught by the user

The user checked the deployed site on their phone right after the third pass went live and sent a
screenshot: on `/picker`, a real Amazon product photo (a guitar neck, not a small placeholder) was
rendering at full native resolution and blowing the whole card out sideways — the SKU name text
was pushed almost entirely off-screen to the right.

**Root cause**: `.thumb` in `src/styles/global.css` was scoped as `.item-row .thumb`, not a bare
`.thumb` rule. `/picker`'s and `/packer`'s SKU-group cards (and admin/inbound's selected-SKU
preview) use `<img class="thumb">` *without* an `.item-row` wrapper — so it got no sizing at all
and rendered at the image's native pixel dimensions. This bug **predates every change made in this
whole session** — the exact same markup was already there before any of today's work started. It
only became visible now because local testing all day used seed-data placeholder images (deliberately
small, 160×160 from placehold.co) which never triggered it, while the user's real catalog has
normal-sized Amazon product photos (hundreds of pixels), and this was the first time the redesigned
`/picker` page was checked against real data on a real phone.

**Fix**: made `.thumb` (44×44, `object-fit: cover`, rounded) the base rule instead of
`.item-row`-scoped, so it works wherever it's used, bare or wrapped. One-line-of-reasoning lesson
for next time: **seed/test data with small placeholder images can hide a real sizing bug that only
shows up against actual product photos** — worth occasionally checking a real image URL (or at
least a large one) when testing anything image-related, not just placeholders.

Verified locally against a 900×1200 test image on both `/picker` and `/packer` (mobile viewport,
`scrollWidth` checked against `innerWidth` — no overflow), then redeployed.

## Recently done (2026-09-19, a fifth pass) — SKU merge tool, from a real "short on stock" report

Right after the fourth pass deployed, the user hit "Create pick batch" for real orders and got "No
orders could be fully reserved — short on stock" for 4 SellerSKUs, even after they'd (they said)
already updated inventory. Investigated directly against the **production** D1 database
(`--remote`, read-only queries first) rather than guessing.

**Root cause, confirmed by querying production**: none of the 4 blocked SellerSKUs had *any*
`inventory` row at all — not "stock is 0", literally no SKU×location record has ever existed for
them. Each one turned out to be a **duplicate of a product already stocked under a different SKU
code** — e.g. `UP-SCCR-LE61` ("4 Tier Katana Wall Mount Holder") is the exact same product as
`KTN4`, which already had 15 units received. Amazon sent a SellerSKU string that didn't match the
code the user originally used for that product, so `importAmazonOrders`'s auto-create-on-order-import
logic (which matches strictly on `sku_code = sellerSku`) correctly-by-its-own-logic created a
brand-new, empty SKU instead of recognizing it as the same item — and `/admin/inventory` can only
edit *existing* stock rows, so the user's attempt to "update inventory" for these had nowhere to
land. This wasn't a one-off — it's a structural gap that would keep recurring for any product
Amazon ever references under more than one SellerSKU.

**Fix — a real SKU-merge feature, not just a one-time data fix** (user explicitly asked for this
over just unblocking the 4 orders):
- New `skus.merged_into_id` column (migration `0012`, self-referential, nullable). Merging never
  deletes the duplicate SKU row — it's flagged with `merged_into_id` pointing at the surviving SKU,
  so its `sku_code` keeps resolving correctly. This matters: if it were deleted, the *same*
  SellerSKU showing up on a future Amazon order would just spawn a fresh duplicate again, right
  back where this started.
- `src/lib/skus.ts` (new) — `resolveSkuIdByCode()` (looks up a `sku_code`, follows a
  `merged_into_id` redirect if present, returns null if the code doesn't exist at all) and
  `mergeSku()` (moves every `inventory` row — summing into the target's existing row at the same
  location if one exists, since `inventory` has a `UNIQUE (sku_id, location_id)` constraint — plus
  every `order_items` and `pick_tasks` row, from source SKU to target SKU; sets
  `merged_into_id`; logs an audit entry). `previewSkuMerge()` is the read-only version shown before
  committing.
- **Every place that auto-creates a SKU from an incoming code now goes through
  `resolveSkuIdByCode` first** instead of a bare `sku_code = ?` lookup — `importAmazonOrders`
  (`orders.ts`, the automatic-sync path that caused this), `syncAmazonCatalog`
  (`catalog-sync.ts`, updates the *surviving* SKU's name/image, not the dead one's), `receiveStock`
  (`inbound.ts`, so receiving against an old/duplicate code lands stock on the survivor), and the
  manual order-entry route (`api/admin/orders.ts`). Missing even one of these would leave a hole
  where the same bug could resurface.
- Merged-away SKUs are filtered (`WHERE merged_into_id IS NULL`) out of `/api/admin/skus`,
  receiving's SKU picker (`/api/admin/inbound` GET), and the reports stock table — so a merged
  duplicate doesn't linger as a confusing dead entry in any admin-facing list. (`/admin/inventory`
  needs no filter — a merged SKU has zero inventory rows left after the merge, so it never appears
  there regardless.)
- **New admin UI**: a "Merge duplicate SKUs" panel at the top of `/admin/inventory` — two SKU-code
  inputs (source to retire, target to keep), a "Preview merge" step showing exactly what will move
  (inventory locations/units, order lines, pick tasks) before anything happens, then "Confirm
  merge". `GET`/`POST /api/admin/sku-merge`.

Verified end-to-end locally: created a duplicate-SKU scenario matching the user's exact situation
(a stocked "canonical" SKU + an empty "duplicate" SKU with a pending order line), merged them
through the UI, confirmed the order line moved to the canonical SKU, confirmed a *second* new order
placed against the duplicate's code resolved straight to the canonical SKU with **no new duplicate
created**, confirmed the duplicate disappeared from `/api/admin/skus`, and confirmed
"Create pick batch" then succeeded for both orders using the canonical SKU's existing stock — the
exact failure mode reported, reproduced and fixed. Then applied migration `0012` to production and
redeployed.

The user then pushed back, correctly: "every other sku will face the same problem." Queried
production directly (read-only) to check scale before assuming it was just those 4 —
**41 duplicate-name groups out of 231 total SKUs**, roughly a third of the whole catalog. Manually
typing 41 pairs one at a time wasn't realistic, so built a scanner instead of just fixing the 4:

- `findDuplicateSkus()` in `lib/skus.ts` — groups every non-merged SKU by exact,
  case/whitespace-normalized name (deliberately **exact match only**, not fuzzy/similarity — a
  false-positive merge is a real mutation, and Amazon listing titles being byte-identical across
  two genuinely different products is effectively impossible in practice, whereas requiring only a
  fuzzy match risks merging two products that just happen to sound similar). This means it's not
  exhaustive — a duplicate with a slightly different title, like the `U8-9OI6-L4OE`/`GUNM-2` pair
  from the original incident (one has a trailing "(Classic)"), won't be caught by the scanner and
  still needs to be found and merged by hand the way that one was.
  Computes a `suggestedKeepId` per group (prefers whichever candidate already has stock, then more
  order history, then older) as a starting suggestion only — never auto-merges anything.
- `GET /api/admin/sku-duplicates` exposes it.
- `/admin/inventory`'s "Possible duplicate SKUs" panel: "Scan for duplicates" button, one row per
  group with a "Merge X → Y" action per non-suggested candidate. Clicking it **doesn't merge
  directly** — it fills the manual merge form above and fires the same preview step, so every
  merge, whether typed by hand or picked from the scan, goes through the identical
  human-reviewed preview-then-confirm flow. No bulk/one-click "merge all" exists on purpose.

Verified locally against the dev D1 (which turns out to already mirror much of production's real
catalog — the scan found 41 real-looking groups there too, plus a synthetic test pair added and
confirmed merging correctly). No new migration — reuses `merged_into_id` from the pass above.
Deployed.

**Update, same session**: user pushed back — "every other sku will face the same problem" — then,
after the scanner shipped and confirmed the real count (34 live groups / 70 SKUs at that moment;
the earlier "41" was a stale count from a few minutes earlier, since the 5-minute Amazon sync cron
keeps creating new SKUs the whole time this was being worked on), said "I have confirmed all you
may merge." All 34 exact-match groups (36 individual merges — two groups had 3 candidates each)
were executed directly against production: exported the scan data, generated a SQL script that
replicates `mergeSku()`'s exact logic (inventory summed at colliding locations, `order_items`/
`pick_tasks` redirected, `merged_into_id` set — never a raw `DELETE FROM skus`), ran it via
`wrangler d1 execute --remote --file=`. **D1 rejects explicit `BEGIN TRANSACTION`/`COMMIT` in a
`--file` run** ("use state.storage.transaction() instead") — it already wraps the whole file in one
transaction itself, so those two lines had to be stripped before it would run; the whole batch is
still atomic. Verified before and after: total `quantity_on_hand`/`quantity_reserved` across all
`inventory`, and total row counts in `order_items`/`pick_tasks`, were bit-for-bit identical
pre/post-merge (560 units, 31 order lines, 17 pick tasks, no change) — nothing created or lost, only
moved. Confirmed `remaining_duplicate_groups` = 0 afterward.
The 4th original pair (`U8-9OI6-L4OE` ↔ `GUNM-2`, the "(Classic)"-suffix one the exact-match scanner
can't see) was merged by hand the same way, but into `GN-HLDR` — not `GUNM-2` directly, since
`GUNM-2` had itself just been merged into `GN-HLDR` in the batch above; merging into an
already-merged SKU would have created a redirect chain, which `mergeSku`'s `loadMergeable` check
exists specifically to reject. Both the bulk batch and this one got a manual `audit_log` entry
(`action: 'sku.merge.bulk'` / `'sku.merge'`, `user_id: NULL`, same pattern as the sync job's own
`user_id: null` signature) since they didn't go through the API route that normally logs this.
**Net effect**: the catalog went from 41→34→0 live duplicate groups in one session. New duplicates
will still occur (every SellerSKU variant Amazon hasn't been seen under yet still auto-creates a
SKU on order import) — that's expected and by design, not a bug; `/admin/inventory`'s scanner is
the ongoing tool for catching them, not a one-time fix.

## Recently done (2026-09-19, a sixth pass) — packing loses "Get next batch" too

While the bulk SKU merge above was mid-flight, the user raised a separate complaint: `/packer`
still had the same "Get next batch" click-gate that `/picker` had already lost earlier in the
session — "it all orders should be on one page only infinite scroll and packer just sees them
sorted by batch." Applied the same continuous-scroll treatment to packing, but adapted to how
packing actually differs from picking:

- **Backend** (`packer.ts`): `startPackingBatch` (claimed one batch, singular) split into
  `claimNextPackBatch` (the claim-one-batch logic, now private) plus two new exports:
  `getMyActivePackBatchIds` (every pick_batch this packer has open at this station) and
  `getMyPackBatches` (returns all of them, auto-claiming when the packer has none). **Deliberately
  not** the same "one auto-swept batch at a time" restraint `claimNextBatch` uses for picking —
  picking's restraint exists specifically so admin's per-packer assignment (see the second pass
  above) isn't fought over; packing has no equivalent assignment mechanism, so `getMyPackBatches`
  sweeps and claims *every* currently-ready batch at once when the packer has zero active ones, in
  a loop. Without that change, a packer would only ever see one batch at a time anyway, one poll
  tick apart — same complaint, just slower.
- `/api/packer/start-session` now returns `{ stationId, batches: [...] }` instead of one
  `PackBatchState` — and doubles as the poll endpoint (called repeatedly with the same
  `stationQrToken`), same pattern as `/api/picker/claim-batch`.
- **Client** (`packer/index.astro`): each batch is now a self-contained unit that moves through
  `packing → labeling → done` **in place, inline, on the same page** — not a shared label queue
  across every batch. This was a deliberate choice, not the more obvious "one combined AWB queue":
  the real floor workflow (documented earlier in this file) is pack *this* batch's boxes, then
  label *this* batch's boxes, then move to the next — treating every ready batch's labels as one
  interleaved queue would contradict that. Clicking "Finish packing" on a batch card transforms
  just that card into an inline AWB-scan flow (own video element, own queue scoped to that batch's
  orders); once every label in it is applied it becomes a "Done" banner and stays visible (matches
  how `/picker` leaves resolved batches on screen, rather than making them vanish). Polling (8s,
  always on, same as picking) only appends genuinely new batch ids — it doesn't touch batches
  already rendered, so it can't interrupt an in-progress AWB scan or reset a half-typed quantity
  elsewhere on the page.
  "Finish packing" is still optimistic (jumps to the label phase immediately, reconciled after —
  unchanged from before), and AWB application is still deliberately non-optimistic (hard-block
  duplicate/mismatch check) — both behaviors carried over from the earlier picking work, not
  revisited here.
- Also fixed while touching this file: `errorBanner()`/AWB-mismatch screen weren't running
  `lastError`/the caught error message through `escapeHtml()` — same class of gap as the notes
  feature's escaping fix, caught by extension while rewriting this page, not a new report.

Verified locally end-to-end: two separate pick batches picked, tapped into a station and both
appeared together immediately (no "get next batch" anywhere), packed and finished one — its card
became an inline AWB scan while the other batch's SKU groups stayed fully interactive below it,
applied its label — it turned into a "Done" banner, packed and finished the second the same way,
ended on "All caught up — new batches will appear here automatically." No console errors, no
mobile overflow (`scrollWidth` checked at 375px).

## Recently done (2026-09-19, a seventh pass) — matching Amazon's own Seller Flex pack screen

The user shared real screenshots of Amazon's own Seller Flex tool (sellerflex.amazon.in — pick →
pack → "Update Box" bulk action on selected orders → "Bulk Pack Confirmation" modal → separate
Print/Download of invoice+label) and asked to match that pattern in our admin Easy Ship pages
(`/admin/ship`, `/admin/bulk-ship`) — still blocked on the SP-API role grant per item #1, so none
of this could be exercised against a real Amazon response; verified as far as it's possible to
verify without that (see below).

- **`/admin/bulk-ship` rewritten**: previously forced one box size and one weight onto every
  selected order via a single global dropdown — the backend (`scheduleEasyShipBulk`,
  `BulkScheduleOrderInput`) already accepted per-order `boxSizeId`/`weightValue`/
  `packageIdentifier`, the client just wasn't using that. Now each order row has its own box/
  weight/package-identifier, plus a bulk "Update box" action (select rows, pick a box + weight,
  one click applies both to every checked row) — the direct equivalent of Seller Flex's
  Action Center → Update Box.
- **New confirmation gate before generating a label** — `confirmDangerousAction()` in
  `src/lib/ui.ts` (title + warning text + a checkbox that has to be ticked before "Continue"
  enables), mirroring Seller Flex's own "Bulk Pack Confirmation" step. Added to **both**
  `/admin/bulk-ship` and the single-order `/admin/ship` (which had no confirmation step at all
  before this — scheduling fired straight off the slot-selection click). This is a UI-level
  reinforcement of the existing chat-level rule ("never purchase a real Amazon shipping label
  without the user's explicit go-ahead in that session") — the rule itself doesn't change, this
  just makes it harder to fire by an accidental click once that role is granted.
- **Real functional gap fixed, found while doing this**: `/admin/bulk-ship`'s result screen never
  actually gave admin a way to *get* the generated label — it showed a scheduled/failed status per
  order and stopped. `scheduleEasyShipBulk` already stores the label synchronously (bulk's
  `printableDocumentsUrl` path doesn't need the async Feeds/Reports polling the single-order flow
  uses), so `/api/admin/shipping/label-status?shipmentId=` already had everything needed — the
  result screen now calls it per successful order and renders **Print** (opens the label in a new
  tab) and **Download** (an `<a download>` on the data URL) next to each one, or a Download-only
  ZIP link for the couldn't-split-per-order fallback case.
- **Verified without touching any Amazon API**: per HANDOFF's own existing note ("getting pickup
  slots is free and safe to test; scheduling is not"), and to stay well inside that even further,
  testing here deliberately stopped *before* even fetching pickup slots — `confirmDangerousAction`
  was exercised directly (Continue starts disabled, ticking the checkbox enables it, Cancel
  resolves `false` and removes the modal, Continue resolves `true`), and the per-order box/weight/
  bulk-"Update box" UI was verified via direct DOM assertions (check a row → bulk bar appears →
  apply a box+weight → the checked row's own select/input reflect it). **Nothing in this pass
  called `listHandoverSlots`, `scheduleEasyShipPackage`, or `createScheduledPackageBulk`** — those
  remain genuinely untested against a live response, same as before this pass (see Open item #13).

## Recently done (2026-09-19, an eighth pass) — continuous flow, and a test-data reset button

The user pushed back on the "one batch at a time" feel that survived even after the seventh pass's
continuous-scroll rewrite: a picker/packer only ever saw a *new* batch once everything already on
their page was finished — new orders landing mid-walk (Amazon's 5-minute sync, an admin import) sat
invisible until then. Root cause: `getMyBatches` (picker.ts) and `getMyPackBatches` (packer.ts) only
attempted to claim/sweep additional work when the caller had **zero** active batches already —
correct on the very first load, wrong on every poll after that.

- **Fix**: `claimNextBatch` was split into the "resume my own batch" check plus a new
  `claimAvailableBatch` (the pending-claim-or-sweep-a-fresh-one logic). `getMyBatches` now calls
  `claimAvailableBatch` on *every* call, not just when the picker has none — since it's idempotent
  (returns `null` when nothing new exists), this is safe to run on every 8s poll and it's what makes
  the poll double as the continuous-flow mechanism. `getMyPackBatches` got the equivalent fix: the
  `if (!batchIds.length)` gate around the claim-everything-ready loop was removed outright, since
  `claimNextPackBatch`'s own query already excludes batches already claimed. No frontend changes
  needed — both pages already reuse the same poll endpoint for their 8s ticks.
- **Verified live in dev**: claimed a batch as a picker, left it unfinished, inserted a fresh order
  directly into D1, and confirmed the next 8s poll appended it as a *second* batch on the same page
  without touching the first. This is the actual behavior the user asked for — orders now show up as
  soon as they're pulled from Amazon, not after the picker clears their current work.
- **New admin button: "Reset picking & packing"** (`/admin`, next to "Create pick batch") — for
  repeatedly retesting the same orders without needing fresh Amazon test orders every time. Backend:
  `resetPickPackData` in `src/lib/reset.ts`. Reverts every order currently `allocated`/`batched`/
  `picking`/`picked`/`packing`/`packed`/`partial` back to `pending`, undoing exactly what
  picking/packing did to inventory (restores on-hand units `confirmPick` consumed, releases any
  outstanding reservation, un-marks bins `reportDamaged` flagged `damaged`), and deletes the
  pick_batches/pick_tasks/cart_slots/pack_sessions/packages/shipments/awbs rows so the next batch
  starts clean. Deliberately **stops at the shipping-label boundary** — orders already
  `ready_to_ship`/`shipped`, and `cancelled` orders, are left untouched, since a `ready_to_ship`
  order can carry a real Amazon-scheduled pickup/label (see `applyAwb`'s pre-purchased-label path in
  `packer.ts`) that resetting would desync us from, not just clear test state. Gated behind
  `confirmDangerousAction()` like the shipping pages. Verified end-to-end in dev: created a batch,
  did a partial short pick (3 of 5, reason "Low stock"), hit Reset, and confirmed inventory
  (on-hand + reserved), order/item status, and the pick_batch/pick_task rows all landed back exactly
  where they started.
- **Real bug caught while building the button, fixed before shipping**: the reset button's click
  handler read `e.currentTarget` *after* `await confirmDangerousAction(...)` to pass to
  `withLoading`. `Event.currentTarget` goes `null` once the event finishes dispatching — which
  happens well before that `await` resolves — so `withLoading(null, ...)` threw immediately on
  `btn.textContent`, and the actual reset API call never fired. Silent failure: the confirm modal
  closed, an error banner appeared, but nothing in the DB changed. Fixed by capturing `btn` in a
  `const` *before* the `confirmDangerousAction` call, matching the pattern `ship.astro` and
  `bulk-ship.astro` already used correctly (`btn.onclick = async () => { const ok = await ...`,
  closing over the outer `btn`, never reading it off the event afterward). **Lesson for next time**:
  any `async` click handler that does `await` before touching `e.currentTarget`/`e.target` has this
  bug — capture the element into a variable first, always.

## Recently done (2026-09-19, a ninth pass) — batches "all at once", and real packer visibility

The eighth pass's continuous-flow fix worked but only claimed **one** additional batch per poll —
so if more orders were open than one cart-load (`cart.slot_count`, 8 by default), a picker saw them
trickle in one batch every 8s instead of all together. Separately, the packer dashboard
(`/packer/home`) showed only "assigned to you" / "upcoming, already batched" — a freshly-imported
order that no picker's page had polled yet was invisible anywhere on it, and there was no way for a
packer to see what they'd actually finished that day.

- **`getMyBatches` (picker.ts) now loops** `claimAvailableBatch` until it returns `null`, exactly
  matching the loop `getMyPackBatches` (packer.ts) already used for packing. A picker opening the
  page (or polling) now gets *every* currently-batchable order swept in at once, split into as many
  cart-sized batches as needed, in one request — not one batch per tick. Verified live: inserted 12
  fresh orders (more than one cart-load) while a picker had 2 unrelated orders already open and
  unfinished, reloaded, and got all 3 batches (2+8+2 orders) on the same page in one shot.
- **New: `getUnbatchedOrderSummary` (orders.ts)** — counts orders that are `pending`/`allocated`
  but have no pick_batch at all yet (i.e. imported by the 5-minute Amazon sync cron but not yet
  swept in by any picker's poll). Surfaced on `/packer/home`'s "Upcoming" section as a banner ("N
  orders just pulled from Amazon (N units) — not yet batched") so a freshly-pulled order is visible
  immediately, not only once some picker happens to load their page. Verified live: inserted orders
  directly into D1 (simulating the cron), confirmed the banner appeared with the right counts before
  any picker had touched them.
- **New: `getPackerDailySummary` (packer.ts)** — every order *this* packer has actually finished
  packing today (`pack_sessions` completed today, `date(completed_at) = date('now')`), with a
  summary (orders/units packed) and a full list (order id, time, units, completed/partial outcome).
  Rendered as a "Today — what you've packed" table plus two stat cards at the top of
  `/packer/home`. This is the "so they know what they have done" piece — the dashboard previously
  only ever showed work still waiting, never a record of what was already done. Verified live
  against real pre-existing pack history in dev: 11 orders / 16 units rendered correctly with
  per-order time and outcome pills.
- Both new dashboard reads are scoped defensively: `getUnbatchedOrderSummary` never claims or
  mutates anything (read-only, same as `getUpcomingBatches`), and `getPackerDailySummary` only reads
  `pack_sessions` already marked `completed`/`partial` by the existing packing flow — neither
  changes any picking/packing behavior, only what's visible.

## Recently done (2026-09-19, a tenth pass) — picking by SKU across everything, packing by order

The user pointed out picking still felt batch/order-organized even after the ninth pass's "all at
once" fix — every batch rendered as its own section with its own "BATCH · N ORDERS" header, so a
picker still mentally worked through one batch, then the next, rather than one continuous SKU list.
Separately, packing had the *opposite* problem: it grouped by SKU across every order in a batch (a
carryover from picking's own bulk-by-SKU pattern), which hid whether any one order needed more than
one unit of something — exactly the thing a packer boxing up one order at a time needs to see.

- **Picking (`picker/index.astro`) now renders ONE flat list, zone/bin → SKU, with no batch
  sectioning and no order sectioning at all.** Every pick_task from every currently-open batch is
  flattened before grouping — the same SKU at the same bin needed by two different batches (or two
  different orders) merges into a single card with a single "Mark done" tap, instead of appearing
  as two separate cards in two separate batch sections. Order id only ever appears as the small
  breakdown line under a SKU card ("ORDER-A ×3 · ORDER-B ×2"), never as an organizing heading.
- This meant a bulk pick/damage submission can now span pick_tasks from more than one pick_batch in
  a single call (previously always exactly one, since the UI never merged across batches before).
  `confirmGroupQuantity`/`reportGroupDamaged` in picker.ts already had no batch restriction — the
  only thing that needed to change was the API layer: `/api/picker/mark-picked` and
  `/api/picker/report-damaged` no longer take a caller-supplied `batchId` (there may be several);
  instead a new `getBatchIdsForTasks` helper works out which batch(es) the submitted pick_task ids
  actually touch, and the response carries fresh rows for each of those, keyed by batch id, which
  the client patches back into whichever `batchList` entries they belong to.
- **Packing (`packer/index.astro`, `packer.ts`) now groups by order, not SKU.** Each batch's card
  lists its orders (sorted by external id); each order is its own card listing every SKU line it
  needs with the quantity right on the row ("Standard Gadget ×3") — a multi-quantity order is
  visible at a glance instead of being buried inside a cross-order SKU total. One "Mark order
  packed" tap per order submits every line on it at once (quantities default to what picking
  delivered, still editable down per line if something turns up missing/broken at the table).
  `markPackGroup`'s cross-order SKU pooling was removed outright (no longer reachable from
  anywhere) and replaced with `markPackOrder`, which updates a set of `{orderItemId, quantity}`
  lines scoped to one order — there was never a real "pool" to allocate within one order's own
  distinct SKU lines, unlike picking's genuinely-shared physical pile of one SKU across orders.
  Batch-level sectioning ("BATCH · N ORDERS") was left in place for packing — the user's ask here
  was specifically the SKU-vs-order axis, and each pick_batch already corresponds to one coherent
  pack→label→done unit from the eighth pass's design, which nothing about this change touches.
- **Verified live in dev, including the cross-batch merge**: claimed a batch with one order
  (3 units of a SKU), left it unfinished, inserted a second order needing 2 more of the *same* SKU
  at the *same* bin (landing in a separate batch via the ninth pass's sweep), reloaded, and got one
  merged card ("Required 5, Picked 0", both orders in the breakdown) instead of two separate ones.
  Picked 4 of 5 (a cross-batch short pick) and confirmed the split landed correctly — one order got
  its full 3, the other got 1 of its 2 and was marked short — proving the allocation and the
  per-batch response patching both worked across the batch boundary. Then confirmed packing: the
  now-picked orders showed up order-first with quantities visible inline, and "Mark order packed"
  correctly recorded and reflected the packed quantity.

## Recently done (2026-09-20, an eleventh pass) — batching removed as a concept, reserve at import

The user wanted batching gone entirely: reservation should happen the instant an order is
imported (not deferred to whenever a picker's page next polls), and — critically, as pickers,
orders, and inventory all grow — a hard guarantee that two people never end up picking or packing
the same order. Discussed the approach first (recorded in this session's plan); the design that
came out of it avoids a wide, risky schema migration entirely.

**The key trick: a "batch" now always means exactly one order.** Rather than ripping
`pick_batches`/`cart_slots`/`pack_sessions.pick_batch_id` out of the schema, each order gets its
own single-order `pick_batches` row created *at import time* instead of a multi-order sweep
created at claim time. Almost every existing function was already correct *per `pick_batch_id`* —
with a batch always exactly one order, those functions became correct *per order* for free, with
no changes: `claimNextBatch`'s atomic `UPDATE ... WHERE status = 'pending'` already guaranteed one
batch goes to exactly one picker (now = one order, guaranteed, to exactly one picker — verified
live with two picker accounts, see below); `checkBatchCompletion`, `claimNextPackBatch`,
`getPackBatchState`, `markPackOrder`, `completePackingBatch`, `applyAwb` were already scoped by
`pick_batch_id`, so an order now becomes pickable/packable/labelable the instant *it* is done,
never waiting on batch-mates. No migration needed either — `pick_batches.cart_id` and
`pick_tasks.cart_slot_id` were already nullable, so the new single-order path just skips
cart/cart_slot creation.

- **`reserveOrderForPicking` (orders.ts)** replaces `createPickBatch`'s multi-order sweep — reserves
  one order's items and creates its single-order batch + pick_tasks immediately, same all-or-
  nothing-per-order shortfall handling as before (rolls back and leaves the order `'pending'` on
  any shortage), called right after order+item insertion in both `importAmazonOrders` and the
  manual/CSV entry point (`api/admin/orders.ts` POST) — the only two places an order is created.
- **Two retry paths for a genuinely blocked (out-of-stock) order**: `retryBlockedOrdersForSku`
  fires automatically from `receiveStock` (inbound.ts) the moment stock arrives for the SKU that
  was blocking it — no picker/admin action needed. `retryBlockedOrders` is the admin-triggered
  version — repurposed the old "Create pick batch" button into "Retry blocked orders" (same POST
  endpoint, `api/admin/batches.ts`), since reservation is automatic now and that button would
  otherwise always report nothing to do.
- **`claimAvailableBatch` (picker.ts)**'s "sweep a new one" branch shrank to a self-healing safety
  net — it should basically never fire now (every order reserves at creation), but if one order
  somehow slips through unreserved it finds and reserves just that one, instead of the old
  cart-capacity-capped multi-order sweep.
- **`packer/index.astro`'s "BATCH · N ORDERS" wrapper is gone** — since a batch is always exactly
  one order now, the wrapper was pure redundant chrome; each order's card renders directly in the
  continuous list, same pattern `picker/index.astro` already used for SKU cards.
- **Dead code removed** rather than left behind: `createPickBatch`/`CreateBatchResult`, the
  `admin/index.astro` "Create pick batch" button's old handler, and `api/admin/carts.ts` (only
  caller was the cart lookup that button needed — carts/cart_slots stay in the schema, just
  unused going forward, since dropping them would've meant an actual migration).
- **Verified live end-to-end in dev**, all four scenarios from the pre-implementation plan:
  1. A manually-created order with enough stock reserved *immediately* (`status: 'batched'`)
     before any picker page was ever opened.
  2. A manually-created order exceeding stock stayed `'pending'`, surfaced as a "blocked — short on
     stock" banner on both `/admin` and `/packer/home`, then auto-resolved (no action taken) the
     instant a `receiveStock` call landed for that SKU.
  3. Two picker accounts (a temporary `TestPacker2` plus the seeded `packer`) each claiming from the
     same pool always got disjoint orders — one claiming everything currently open left the other
     with nothing, and a fresh order created afterward went to whichever one claimed next, never
     both.
  4. Picked one order fully while three siblings sat mid-pick/blocked/untouched; that one order
     reached packing, packing, AWB scan, and `ready_to_ship` completely independently, never
     waiting on any of the other three.
- **Known, accepted side-effect, not fixed this pass**: `admin/pick-list.astro`'s print dropdown
  now lists one entry per order (a single-order ticket) instead of a multi-order bundle — denser,
  prints one order's sheet at a time. Left as-is; revisit only if it turns out to matter in
  practice.

## Recently done (2026-09-20, a twelfth pass) — packing sort/highlighting, one shared label queue

Two fixes to `/packer` (`packer/index.astro`): a sort control for the now order-first list
(default by SKU, so orders needing the same product cluster together), highlighting for orders
that need more than one item or more than one unit of something, and a fix to a fragmentation
problem the eleventh pass's batching removal introduced — each order finishing packing on its own
now meant a separate "Finish packing → scan AWB" screen popped up after *every single order*, one
at a time, instead of once for the whole batch of orders a packer had just finished.

- **Sort control**: a `<select>` next to the summary pills, options "Sort by SKU" (default) and
  "Sort by order ID". Sorting now happens once, page-level, over every order across every
  currently-open entry flattened together (`flattenOrders()`) — SKU mode sorts by each order's
  lowest `sku_code` (so `flattenOrders`'s "nothing to pack" orders, with no SKU at all, sort last),
  order mode by `external_order_id`, matching what existed before this pass as the *only* option.
- **Multi-item/multi-qty highlighting**: a `status-warning` pill next to the order id — "Multi-item"
  when an order has more than one distinct SKU, "Multi-qty" when any line needs more than one unit.
  Both can show together. Purely visual, no behavior change — just makes an easy-to-under-pack
  order stand out before the packer boxes it up as if it were routine.
- **The real fix — one shared label queue instead of one per order**: "Mark order packed" no longer
  triggers labeling for that order by itself. Instead, a single page-level "Finish packing — apply
  labels (N)" button appears (N = how many orders across the whole page are currently packed and
  ready) the moment at least one order is ready — not gated on every order being done, so a packer
  can pack a few, finish-and-label those, and keep packing more without waiting. Clicking it
  completes every ready order's pack session in one pass (`completePackingBatch`, once per
  underlying `pick_batch_id`), removes those entries from the working list, and pushes all their
  orders into one shared `labelQueue` — the exact same scan-AWB screen as before, just fed from a
  combined list instead of one order's own singleton queue, so scanning steps through every order
  in one continuous flow instead of a fresh "Finish packing" click needed before each one.
  `renderLabelCard`/`handleAwb` dropped their `entry` parameter entirely in the process — AWB
  application was already keyed only by `packSessionId`, no batch context needed, so the whole
  per-entry indirection was unnecessary once the queue moved to the page level.
- **Verified live in dev**: three orders (one multi-item, one multi-qty, one plain) picked and
  moved to packing — confirmed the SKU-default sort ordering, both highlight badges appearing on
  exactly the right orders and neither on the plain one, the "Finish packing" count updating
  correctly as each order was individually marked packed (1 → 3, never appearing before the first
  was done), one click completing all three and opening one shared "3 left" scan screen, and
  scanning through all three in sequence down to an empty queue — all three reached
  `ready_to_ship`.

## Recently done (2026-09-20, a thirteenth pass) — the real "not fetching all the orders" bug

The user reported orders going missing from the WMS entirely — specifically worried about an order
whose Amazon Easy Ship pickup gets scheduled the night before but still needs to be physically
picked the next morning. Traced to two real bugs in `fetchUnfulfilledOrders` (`amazon.ts`), found
by testing against the real production SP-API account (read-only — `GetOrders`/`GetOrderItems`,
no scheduling/purchasing, per the standing safety rule):

- **The real root cause**: the per-order `GetOrderItems` call inside the fetch loop had no error
  handling — if it failed for even *one* order (a transient SP-API rate limit or 500; this endpoint
  has a tight per-second limit and the loop calls it once per order back-to-back with no
  throttling), the whole function *threw*, discarding every order already fetched in that same
  call — not just the failing one. `importAmazonOrders` got zero orders back for that entire sync
  tick, silently (the cron's own catch just `console.error`s and moves on). This is a very
  plausible explanation for orders seeming to vanish: one flaky order among several overnight
  arrivals could wipe out the whole batch's import, and it would only self-heal on a later cron
  tick if that same order didn't fail again. Fixed: a failing order's item-fetch is now caught,
  logged, and skipped — every other order in the same call still gets returned and imported.
- **`OrderStatuses` filter widened** from `Unshipped,PartiallyShipped` to
  `Pending,Unshipped,PartiallyShipped` — an order can sit as `Pending` overnight (payment/COD
  confirmation) and be released for fulfillment by morning; excluding it meant it never entered
  our system at all until its Amazon-side status happened to flip before some later sync caught it,
  which isn't guaranteed. `reserveOrderForPicking` handles a `Pending` order exactly like any
  other; if Amazon later cancels it, `syncOrderStatuses` (`amazon-sync.ts`) already catches that.
- **The Easy-Ship-scheduled-the-night-before scenario itself was already fine**, verified by
  reading the code path rather than guessing: `scheduleEasyShipForOrder` (`shipping.ts`) never
  touches `orders.status` at all — scheduling a pickup only ever creates local `packages`/
  `shipments`/`awbs` rows (with `pack_session_id` left `NULL`, matched up later by the packer's own
  AWB scan — see `applyAwb` in `packer.ts`). An order stays in the normal pick/pack pipeline exactly
  as if nothing had been scheduled; scheduling early doesn't fast-forward or hide it. Nothing to fix
  there — the actual bug was the fetch-loop one above.
- **Verified against the real account**: with both fixes in place, one real import call against
  production Amazon returned 30 real orders in one pass (0 silently dropped) — 30 of those came
  back reported as short-on-stock across a wide set of SKUs (`DOG-BKM-5`, `GWM-5`, `KTN3`,
  `U8-9OI6-L4OE`, `JC-82IW-CSC1`, and others), each with an exact "needs X, only 0 in stock"
  reason. **This is real, actionable backlog, not a bug** — those orders are correctly staying
  `pending`/blocked until stock is received for those SKUs (see the eleventh pass's retry
  mechanism — `retryBlockedOrdersForSku` will resolve each one automatically the moment stock
  lands, or admin can force it sooner via "Retry blocked orders"). Flagging here since it surfaced
  during this fix and the user should know: a real chunk of recent orders across many SKUs are
  currently unfulfillable for lack of stock.
- **Known limitation, not fixed this pass**: no throttling/backoff between the per-order
  `GetOrderItems` calls — the catch-and-skip fix tolerates an occasional failure but doesn't reduce
  how often one happens. Fine at the current order volume (a few dozen per sync); would need a
  small delay between calls (or batching) if volume grows enough to hit SP-API's rate limit
  routinely rather than occasionally.

## Recently done (2026-09-20, a fourteenth pass) — a real "orders vanish after Finish packing" bug

The user reported: click "Finish packing", the AWB-scan screen appears, then click browser-back —
there's no way back to scanning, and it should be mandatory. This was a real, not cosmetic, bug:
`completePackingBatch` moves an order's status past `'picked'` the instant "Finish packing" is
clicked — straight out of `getMyPackBatches`' own query. The soon-to-scan order was only ever
tracked in the browser tab's in-memory `labelQueue`; navigating away (back button, a reload, a
dropped connection) lost that memory with nothing server-side to recover it from. The order sat
`'completed'`/`'partial'` forever, invisible to the normal packing list, needing an AWB it could
never receive through the UI again.

- **`getPendingLabelQueue` (packer.ts)**: finds every pack_session this packer completed that
  still has no `packages` row referencing it (`applyAwb` is what sets that, whether matching a
  pre-purchased label or creating a fresh one) — i.e. exactly the "packed but not yet labeled"
  set. Added to `/api/packer/start-session`'s response (`pendingLabels`) alongside `batches`,
  so it's included on both the initial tap-in *and* every 8s poll.
- **`packer/index.astro`** now merges `pendingLabels` into `labelQueue` on both calls (dedup by
  order id on poll, full replace on a fresh tap-in) — and since `render()` already shows the
  label screen first whenever `labelQueue` is non-empty (from the twelfth pass), this makes
  scanning mandatory in the only way a plain web page realistically can: not by blocking the
  browser's own back button, but by *always* re-surfacing the outstanding scan queue the moment
  the packer lands back on `/packer`, before the normal packing list can even appear.
- **Verified live in dev**: packed and completed an order via direct API calls (bypassing the UI,
  simulating "already clicked Finish packing"), confirmed a fresh `start-session` call returned
  it in `pendingLabels` with zero batches, then loaded `/packer` fresh in the browser and tapped
  in — the mandatory scan screen appeared immediately with that exact order, scanned it, and it
  reached `ready_to_ship` normally.

## Recently done (2026-09-20, a fifteenth pass) — faster barcode scanning

The user reported the camera scanner (station labels, AWB codes — `scanner-client.ts`, shared by
`/packer` and `/admin/pick-list`) felt slow to actually catch a code. Three changes, all in
`scanOnce`:

- **`delayBetweenScanAttempts` dropped from ZXing's default 500ms to 75ms** — most of the "feels
  slow" experience is this gap, not the camera or the decoder itself: at 500ms, holding a barcode
  in frame could sit for up to half a second doing nothing before the next decode attempt even
  starts.
- **Restricted to the formats this app actually produces/reads** (`QR_CODE` for station/location
  labels, plus the common 1D symbologies for AWB/item barcodes — `CODE_128`, `CODE_39`, `EAN_13`,
  `EAN_8`, `UPC_A`, `UPC_E`, `ITF`) via `DecodeHintType.POSSIBLE_FORMATS`. Unscoped, ZXing's
  multi-format reader tries every format it knows on every frame, including several 2D formats
  (PDF417, Data Matrix, Aztec, MaxiCode, RSS) this app never uses — a real, measurable per-attempt
  cost for zero benefit.
- **Switched to `decodeFromConstraints`** with an explicit `{ width: 1280, height: 720 }` ideal
  resolution (the browser's unconstrained default is much lower, which was likely hurting
  recognition of small/far-away barcodes) and a best-effort `advanced: [{ focusMode: 'continuous' }]`
  constraint (ignored harmlessly where unsupported, e.g. Safari/iOS, rather than failing the
  request) so a phone held close to a barcode doesn't sit hunting for focus.
- **Verified in dev**: no camera hardware exists in the sandboxed browser used for testing, so real
  scan speed couldn't be measured end-to-end here — confirmed instead that the new constraints
  object is accepted as valid by `getUserMedia` (a real `NotFoundError` — "no camera" — not a
  `TypeError`/`OverconstrainedError` that would indicate a malformed constraint) and that the
  existing graceful fallback to manual entry still works unchanged. **Worth a real-device check**
  next time someone's on the floor with a phone.

## Recently done (2026-09-20, a sixteenth pass) — reset can now optionally include ready-to-ship

`resetPickPackData` (`reset.ts`) deliberately stopped at the shipping-label boundary since the
eighth pass — `ready_to_ship` orders were always left alone, since one might carry a real
Amazon-scheduled pickup/label that resetting would desync us from. The user wanted that boundary
to be optional rather than fixed, for retesting an order all the way through labeling.

- **New `includeReadyToShip` parameter** (`resetPickPackData`, defaults `false` — unchanged
  behavior unless explicitly opted into). When `true`, `'ready_to_ship'` joins the target status
  list; nothing else about the function changed — the existing packages/shipments/awbs cleanup
  already worked generically off whichever orders land in scope, since a `ready_to_ship` order's
  package is always already linked to its `pack_session` by the time `applyAwb` gets it there.
  `'shipped'` (a real carrier event, never self-reported — see `amazon-sync.ts`) and `'cancelled'`
  stay untouched either way.
- **New checkbox on `/admin`**: "Also reset ready-to-ship orders", unchecked by default, right next
  to the Reset button. Checking it swaps in a stronger warning in the `confirmDangerousAction`
  modal (explicitly calling out the real-Amazon-commitment risk) before the same button fires.
- **Verified live in dev, deliberately against real accumulated state, not an isolated test order**:
  took one fresh order through pick → pack → label to `ready_to_ship`, confirmed resetting
  *without* the checkbox left it untouched (`orderCount: 0`), then *with* it checked the reset
  correctly picked up **14** `ready_to_ship` orders at once (my one plus 13 pre-existing demo/test
  orders already sitting at that status from earlier passes this session) — all 14 landed back at
  `pending` cleanly, inventory restored correctly for all of them, no FK errors, no negative
  inventory anywhere afterward. A good real-world stress test of the generic cleanup logic across
  a genuinely varied set of orders, not just a single controlled case.

## Recently done (2026-09-20, a seventeenth pass) — floor-screen UI cleanup

A round of concrete UI feedback across the picker, packer, and dashboard screens:

- **Top nav simplified everywhere** (`picker/index.astro`, `packer/index.astro`,
  `packer/home.astro`): the username pill is gone from all three, replaced by a third "Scan"
  quick-access pill alongside "Pick"/"Pack" — Scan links to `/packer`, same as Pack, since that's
  genuinely the one place all scanning (station tap-in, AWB) already lives; the destination page
  already shows whichever phase is actually relevant (the mandatory label queue takes priority
  automatically — see the fourteenth pass), so the two labels are just different mental-model
  entry points into the same flow, not different pages.
- **`/packer/home`'s "Assigned to you" collapsed from one card+button per order to one aggregate
  card.** Since the eleventh pass's batching removal, a picker/packer claiming everything currently
  open could mean a dozen-plus individual "Go to picking" buttons stacked on the dashboard — now
  it's one card ("N orders in progress, M lines still to pick") and one button, still routing to
  picking or packing depending on whether any picking is still outstanding.
- **"Today — what you've packed" gets a product photo column** — `getPackerDailySummary`
  (`packer.ts`) now also returns each order's first item's `image_url` (same
  first-item-image pattern `admin/orders.ts` already uses), rendered via the existing
  `.table-thumb` class.
- **`/picker`'s SKU cards reworked**: photo grows from 44px to 72px (new `.thumb-lg` modifier in
  `global.css`, layered on the base `.thumb` rather than replacing it, so every other `.thumb` usage
  — admin tables, packer order lines — is untouched); SKU code now leads (bold, prominent) with the
  product name underneath, single-line-truncated instead of wrapping and dominating the card —
  the code plus a short glance at the photo is what a picker actually needs on the shelf, not the
  full Amazon listing title. Also fixed a real pre-existing gap while touching this line: `sg.sku_name`
  was rendered unescaped (a stored-XSS hole via Amazon catalog data) — now goes through `escapeHtml`
  like every other user-sourced string on this page.
- **The order-id breakdown line replaced with an aggregate count**: "N single-unit orders · M
  multi-unit orders" instead of listing every order id needing that SKU — a popular SKU could
  otherwise list a dozen order numbers with no real use to the picker. Order notes are the one
  exception still named individually (still operationally important — "Fragile", "gift wrap",
  etc.), and a short-pick outcome still names exactly which order(s) came up short and by how much,
  since that's precisely when knowing which order matters.
- **Verified live in dev**: two orders (one single-unit, one multi-unit with a note) landed in one
  merged SKU card reading "N single-unit orders · M multi-unit orders" plus the note called out
  separately; the dashboard's "Assigned to you" correctly collapsed 15 individually-claimed orders
  into one card/button; packed one order and confirmed its photo rendered in the "Today" table.

## Next steps — a prioritized plan

Rewritten 2026-09-20 (seventeen passes across two days — see "Recently done" entries above for the
full story behind each). What's actually not done yet, ordered by what's blocking vs. not. See
"Open items" below for full detail on each.

1. **Receive stock for the SKUs currently blocking real orders.** Surfaced by the thirteenth
   pass's fetch fix, not caused by it: `DOG-BKM-5`, `GWM-5`, `KTN3`, `U8-9OI6-L4OE`,
   `JC-82IW-CSC1`, and others are all at zero stock with real orders waiting on them. Receive stock
   for each via `/admin/inbound` — every matching blocked order resolves automatically the moment
   its SKU gets stock (no further action needed per order).
2. **Get the Amazon Easy Ship SP-API role granted.** Still the one thing blocking real use of
   shipping (single-order, bulk, everything) *and* packing's bulk-label piece (part 2 of 3, see
   "Open items" #14). It's on the user, not something to keep investigating from this end — check
   Seller Central's app-authorization page for an "Easy Ship" scope. Once granted, the very first
   thing to do is a live smoke test of `/admin/ship` on one real order, watching closely for: the
   real `labelFileType` Amazon returns, which page of the combined PDF is actually the label
   (currently assumes last), whether the `DocumentReportReferenceID` regex parse in
   `checkEasyShipFeed` matches Amazon's real feed-processing-report format, and — new since the
   seventh pass — whether `createScheduledPackageBulk`'s label ZIP actually splits 1:1 per order
   the way `scheduleEasyShipBulk` assumes (flagged since item 13, still unverified). None of that
   has ever been exercised against a live account. The bulk/single ship pages now have a
   confirmation step before anything fires, so this smoke test won't happen by accident.
3. **Work through the remaining SKU-duplicate merges.** The fifth pass fixed all 34 *exact*-name
   duplicate groups live in one sweep, but `/admin/inventory`'s scanner only catches exact matches
   — near-duplicates (a trailing "(Classic)", a punctuation difference) still need manual review.
   Run "Scan for duplicates" again next session to see what's accumulated since (new orders keep
   auto-creating SKUs for SellerSKU variants never seen before — that's expected, not a bug).
4. **Real box sizes.** Only demo/test boxes existed as of the start of this session — confirm with
   the user whether their actual box dimensions have been entered in `/admin/settings` yet.
5. **Confirm the ship-from address is real**, not a placeholder — check `/admin/settings` before
   the first real label purchase.
6. **Decide the 30-day data-disposal scope** (see open item, below) — this was *committed to
   Amazon in writing* with no enforcement code yet. Needs three scoping answers from the user
   before it can be built safely; the cron infrastructure already exists (`src/worker.ts`) so the
   actual job is easy to add once those answers exist.
7. **Ask-before-building items**: individually-strengthened admin auth (currently same weak PIN
   as floor workers), a public privacy policy URL for ecomglider.com, what should happen when an
   Amazon cancellation lands on an order already fully picked/packed (currently just an exception
   event for manual putback), whether the Amazon catalog sync should become automatic (periodic
   cron) rather than a manual button, and the broader HTML-escaping audit flagged as Open item #16
   (the notes feature is covered; older fields like `first_item_name`'s title attribute aren't).
   None of these are urgent; don't build them unprompted.
8. **Minor cleanup, low priority**: `src/pages/api/picker/scan-item.ts` (and `verifyItemScan` in
   `picker.ts`) is dead code from before the picker dropped mandatory scanning — nothing calls it.
   `Warehouse` type in `types.ts` is missing the `ship_from_*` columns (cosmetic, nothing breaks).
   No throttling between per-order `GetOrderItems` calls in `fetchUnfulfilledOrders` (see the
   thirteenth pass) — fine at current volume, revisit if SP-API rate-limit errors become frequent.
9. **If the user says the UI looks off somewhere**, the fix pattern is established (see "Design
   system") — reuse `AdminShell`/existing component classes. If it's a *mobile* complaint, verify
   with `document.documentElement.scrollWidth` at 375px before guessing — this has caught two real
   bugs this session that weren't visible on desktop (the Required/Picked stat block, and the bare
   `.thumb` sizing bug against a real product photo). **Also test image-related UI against a large
   real image, not just small seed placeholders** — the `.thumb` bug specifically hid behind
   160×160 placeholder images all session and only showed up against a real Amazon product photo.
   **Also: any `async` click handler that reads `e.currentTarget`/`e.target` *after* an `await`
   has a real bug** (it's `null` by then) — caught this in the eighth pass's reset button; capture
   the element into a variable before the first `await`, every time.

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
- **D1** for all relational data (`migrations/0001`–`0010`, applied in order — `--local` and
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
- `0010` — `pack_sessions.pick_batch_id`, so a pack session can cover a whole batch of orders
  instead of exactly one (see "What's built" → the packing entry).
- `0011` — `orders.notes`, nullable free text for the per-order notes/special-instructions field
  (see "What's built" → Order notes).
- `0012` — `skus.merged_into_id`, self-referential nullable FK for the SKU-merge tool (see "What's
  built" → SKU merge).

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
- **Tables vs. cards**: data tables (`<table>` + `.table-scroll` for horizontal overflow, plus
  `.table-thumb` for a product photo in a cell) are the default for admin screens (inventory,
  pick-list, and — since the sidebar redesign gave the content area real width — the dashboard
  order list too). The old `.order-card` pattern (avoiding tables because they wrapped/scrolled
  on long Amazon titles in the pre-sidebar ~720px column) is gone; the fix that actually solved
  that, now that there's room, is `.truncate-cell` (ellipsis + a `title` attribute for the full
  text on hover) on the product column, not avoiding `<table>` altogether. `.order-card-ship`
  (just the ship-action link's color) is the one surviving class from that pattern — still used,
  not dead code. If another screen wraps awkwardly, reach for `.truncate-cell` in a real table
  first, not a card-based workaround.
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
- **Reserve-at-import, no batching concept** (changed 2026-09-20 — see the eleventh pass above for
  the full design). An order reserves its own inventory and generates its own pick_tasks the moment
  it's created — `reserveOrderForPicking` (`orders.ts`), called from both `importAmazonOrders` and
  the manual order-entry POST route, immediately after inserting the order's items. Nothing waits
  for a picker to ask for work any more. Each order gets its own single-order `pick_batches` row
  (a "batch" is now just that order's reservation ticket, never a multi-order bundle) — `cart_id`
  is left `NULL`, no `cart_slots` row is created, since there's no sweep to bundle and no cart
  capacity to cap against. `createPickBatch` (the old capacity-capped multi-order sweep) and the
  `/admin` "Create pick batch" button are gone — replaced by "Retry blocked orders", which retries
  reservation for whatever's still stuck (almost always insufficient stock), since that's the only
  way an order can still be unreserved under this model.
  **Why this changed**: the user wanted stock locked the instant an order lands (not whenever some
  picker happens to next poll), and — as pickers/orders/inventory all grow — a hard guarantee that
  two people never end up picking or packing the same order. Reserving per order at creation time,
  with each order's own single-order batch claimed atomically, delivers both: shortages surface
  immediately instead of at claim time, and claiming one order's batch is claiming that order,
  full stop — no bundling means no way for two people to overlap on the same one.
  A genuinely out-of-stock order stays `pending` (all-or-nothing per order, same as before) and now
  has two ways to resolve: `retryBlockedOrdersForSku` fires automatically the instant `receiveStock`
  adds inventory for the SKU that was blocking it, or admin can trigger `retryBlockedOrders` for
  everything currently stuck via the "Retry blocked orders" button. `claimAvailableBatch`
  (`picker.ts`) keeps a much narrower self-healing fallback for the rare case an order somehow has
  no batch yet (reserves just that one order on the spot) — normal operation should never reach it.
  Verified end-to-end locally (see the eleventh pass above for the full list): immediate reservation
  on creation, correct all-or-nothing rollback and later auto-resolution on a stock shortage, two
  picker accounts always claiming disjoint orders never the same one, and one order reaching
  `ready_to_ship` completely independently of three siblings sitting mid-pick/blocked.
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
  what a picker actually works from.
  **Updated later the same day (2026-09-19)**: "Report issue" is now a reason dropdown — "Damaged
  — none usable", "Low stock — not enough available", or "Other" (free-text note) — not just a
  single "Damaged" button, and it opens automatically whenever the entered quantity is less than
  what's needed (not only from the standalone button), so a short pick can't complete silently
  without saying why. Each SKU card shows **Required** and **Picked** as two explicit numbers, not
  a compact fraction, so "needed 5, only got 2" is obvious rather than inferred from a "Done"
  banner. Whether "Damaged" writes off the whole task's inventory (`reportGroupDamaged`, the
  destructive path) or is just an annotation on an ordinary short pick (`confirmGroupQuantity` with
  a `reason` string, appended to the `short_pick` exception's notes) depends on whether anything
  was actually picked: quantity 0 → destructive write-off; quantity > 0 → annotated short pick,
  never both, since a task that already has units picked shouldn't have its whole required
  quantity marked damaged. See `renderSkuGroup`'s reason-panel logic in `picker/index.astro` and
  the `reason?: string` parameter threaded through `confirmQuantity`/`confirmGroupQuantity` in
  `picker.ts`.
  The picker page is also no longer "claim one batch, finish it, tap for the next" — it's every
  batch currently assigned to you (`getMyBatches`/`getMyActiveBatches` in `picker.ts`) rendered as
  one continuous scroll, polled every 8s for anything new (a fresh auto-sweep once you're caught
  up, or a batch admin hand-assigned — see below) which just appends at the bottom rather than
  replacing what's already on screen, so an open "why was this short" panel elsewhere on the page
  survives a quiet poll tick. Admin can now hand-assign a specific batch to a specific packer
  (`assignBatchToPacker` in `picker.ts`, UI on `/admin/pick-list` — see its own entry below)
  instead of every batch going through the general first-picker-who-asks pool; a batch admin
  assigns is excluded from that pool the moment its status leaves `pending`, so nobody else can
  claim it out from under the named packer. Marking a group done or reporting an issue updates the
  screen immediately (an optimistic local update before the network call resolves, reconciled with
  the server's response and rolled back on failure) instead of waiting on the round trip.
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
  **Updated 2026-09-19 (a sixth pass, same day)**: no more "Get next batch" click gate — every
  batch a packer has open at a station shows on one continuous page at once (`getMyPackBatches` in
  `packer.ts`, sweeps *all* currently-ready batches, not just one — packing has no per-packer
  admin-assignment mechanism the way picking does, so there's no reason to hold any back). Each
  batch moves through pack → label → done **in place, inline**, not via a page navigation or a
  batch-wide queue — see "Recently done" for why a shared cross-batch label queue was deliberately
  rejected in favor of this.
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
  **Bug found 2026-09-19, fixed later the same day**: `getPackBatchState`'s (and
  `getPackSessionState`'s) items query originally only included `order_items` with status
  `'picked'` or `'packed'` — an item that came back a *partial* short pick (status `'short'`, but
  `quantity_picked > 0`) never appeared in the packing view at all, even though real units were
  physically picked for it. Fixed by widening both queries to also match `status = 'short' AND
  quantity_picked > 0` (a fully-zero short/damaged line still correctly has nothing to pack — that
  edge case below is unaffected). See "Recently done" (the follow-up punch list) for the fix.
  **Updated later the same day (2026-09-19)**: SKU groups are now sorted by `sku_code` (server-side
  `ORDER BY` in `getPackBatchState`, plus a defensive client-side sort) so the packed-and-arranged-
  on-the-table order actually matches what the user described (see "Recently done" above for the
  full floor-workflow spec this is built against). "Mark done" also updates the screen immediately
  now, the same optimistic-then-reconcile pattern as picking.
- **Packer dashboard** (`/packer/home`, added 2026-09-19) — a packer's own home page: what's
  currently assigned to them (`getMyActiveBatches`, with a "Go to picking"/"Go to packing" link
  depending on whether picking is still outstanding), and a read-only "upcoming — pulled, not yet
  assigned" list (`getUpcomingBatches` — orders already reserved via `reserveOrderForPicking` at
  creation time that nobody has claimed or been assigned yet; visibility only, not a claim action).
  Since the eleventh pass, also shows a "blocked — short on stock" banner
  (`getUnbatchedOrderSummary`) and a "Today — what you've packed" summary/list
  (`getPackerDailySummary`) — see that pass's entry above for the full detail. The top-bar logo on
  every picker/packer/admin screen now links back to a home page (`/packer/home` for picker/
  packer via `TopBar`'s new `homeHref` prop, `/admin` for admin's sidebar logo) instead of being
  inert.
- **Admin batch assignment** (`/admin/pick-list`, added 2026-09-19) — an "Assigned to" control on
  the batch card lets admin hand a specific pending/assigned batch to a specific packer
  (`PATCH /api/admin/batches`, `assignBatchToPacker` in `picker.ts`) instead of leaving every
  batch to the general claim pool. Once assigned, it's excluded from that pool (status leaves
  `'pending'`) and surfaces automatically on the named packer's `/picker` page and dashboard next
  time they load or poll. The same control also unassigns — selecting "— Unassigned —" and
  submitting (`packerId: null`) puts the batch back to `'pending'`, same gate as assigning (blocked
  once a picker has actually started, `'in_progress'`). Button label follows the selection
  ("Assign" / "Update" / "Unassign").
- **Order notes** (`orders.notes`, migration `0011`, added 2026-09-19) — a free-text per-order
  field for what used to only exist on the admin's handwritten paper pick list ("free gift
  included", "multi-qty, double-check count"). Admin edits it inline on `/admin`'s orders table
  (`PATCH /api/admin/orders`) — a compact "+ Add note" button per row that expands to a real input
  + Save/Cancel just for that cell, not an always-visible input in every row of what can be a
  100-row table. Surfaced to the floor on both `/picker` and `/packer` in the order-breakdown line
  under each SKU card, and on packer's apply-labels/AWB screen. Threaded through
  `getPickListView`/`getPackBatchState` (`picker.ts`/`packer.ts`) as `order_notes`. All rendering
  goes through the new `escapeHtml()` in `src/lib/ui.ts` — see "Open items" #16 for the broader
  (pre-existing, not fully audited) escaping gap this only partially addresses.
- **SKU merge** (`skus.merged_into_id`, migration `0012`, added 2026-09-19) — for when the same
  physical product ends up under two SKU records (Amazon sends a SellerSKU that doesn't match the
  code already in use — see "Recently done," fifth pass, for the real incident that drove this).
  `/admin/inventory` has a "Merge duplicate SKUs" panel: enter the duplicate's code and the code to
  keep, preview what moves, confirm. `mergeSku()`/`previewSkuMerge()`/`resolveSkuIdByCode()` in
  `src/lib/skus.ts`. The duplicate SKU row is never deleted, only flagged — its code keeps
  resolving to the surviving SKU via `resolveSkuIdByCode`, which every SKU-auto-create path now
  goes through (`importAmazonOrders`, `syncAmazonCatalog`, `receiveStock`, manual order entry) so
  the same SellerSKU showing up again doesn't spawn a fresh duplicate. Merged-away SKUs are
  filtered out of `/api/admin/skus`, receiving's picker, and the reports stock table.
- **Pick/Pack tabs + notifications** — `/picker` and `/packer` are separate routes but present as
  tabs (`.tab-pill` in `TopBar`), each with a red badge dot when work is waiting on the *other*
  tab. `GET /api/packer/work-summary` (packer role) returns `{ pickable, packable }` counts,
  polled every 10s from both pages. Never shows price — see below.
- **Live auto-refresh** — polling, not push. `/admin` refreshes its orders list every 12s;
  `/packer`'s "No orders waiting" screen polls every 8s. `/picker` polls every 8s continuously
  (not just while empty, since 2026-09-19 — see "What's built" → the picking entry), but only
  re-renders when a batch not already on screen shows up, so it doesn't disturb an open panel.
  All skip the tick when the tab is backgrounded (`document.hidden`). Good enough for this team's
  volume; if it ever needs to feel more instant, Durable Objects WebSockets is the documented
  upgrade path (not needed yet).
- **Inbound receiving** (`/admin/inbound`, `inbound.ts`) — type-ahead product search (title or
  SKU code, results show photo + name + code + price) with a "can't find it, create new SKU"
  fallback. Puts stock directly into a bin, creating the SKU×location `inventory` row if it
  doesn't exist yet (`INSERT ... ON CONFLICT DO UPDATE`). A "Sync Amazon catalog" button
  (`POST /api/admin/sync-amazon-catalog`, `catalog-sync.ts`, `fetchAllListings` in `amazon.ts`)
  pulls the seller's full Amazon listings catalog (Listings Items API, paginated, capped at 1000)
  and upserts every SellerSKU into local `skus` — this is what makes the search above cover
  everything the seller sells, not just SKUs an order has referenced. Manual trigger, not an
  automatic cron yet (see "Next steps" #5). Refreshes name/image_url only; never touches the
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
  live** — see "Next steps" #1.
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
   packing's bulk-label piece (item 14 below). See "Next steps" #1.
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
15. ~~**Partial short-picked items never reach the packing view**~~ — **fixed** 2026-09-19, later
    the same day. See "Recently done" (the follow-up punch list) and "What's built" → the packing
    entry.
16. **No general HTML-escaping audit** (discovered 2026-09-19 while building the notes feature).
    Every picker/packer/admin screen in this app renders via `innerHTML` template strings rather
    than building DOM nodes, and — outside of what the notes feature now covers with `escapeHtml()`
    in `src/lib/ui.ts` — most pre-existing places that drop a user-entered string into one of those
    templates don't escape it first (e.g. `first_item_name`'s `title` attribute on `/admin`, quoted
    with a bare `.replace(/"/g, '&quot;')` rather than a full escape). Not a new risk introduced
    today, and not fixed beyond the notes feature itself — worth a dedicated pass if the user wants
    one, since the actual exposure (an admin's own free text rendered back to admin/floor-worker
    screens, not arbitrary public input) is limited but real.

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
