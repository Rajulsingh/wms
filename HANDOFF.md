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

## Recently done (2026-09-20, an eighteenth pass) — multi-unit highlighting, bulk packing

Two more pieces of concrete floor-UI feedback, one for picking and one for packing:

- **`/picker`'s multi-unit orders are now their own highlighted badges, not folded into a count.**
  Previously "N multi-unit orders" was a single plain-text number; now every multi-unit order gets
  its own `status-warning` pill showing its actual quantity ("3×", "2×", ...) next to a "Multi-unit:"
  label, so a picker sees exactly how many to set aside for each one at a glance, not just that some
  exist. The single-unit count stays as before, plain text. Also renamed the primary action button
  from "Mark done" to **"Picked"** — the reason-flow button (short/damaged) and the packing side's
  own "Mark order packed" are unchanged, this was specifically the picker's default confirm button.
- **`/packer` gets multi-select + bulk "Mark N packed"**: a checkbox on every order card that's
  still selectable (not already packed, has something to pack) — same eligibility as its own
  individual button. Selecting any brings up a toolbar ("N selected · Clear · Mark N packed").
  Bulk-marking submits every selected order at its own full required quantity in one action
  (`handleBulkMarkPacked`, packer/index.astro) — no per-line adjustment in the bulk flow; a packer
  who needs to short-pack one specific order still does that individually via its own button,
  which stays untouched and fully independent of the bulk one. Selection is pruned automatically
  on every render against whatever's currently selectable, so a stale selection (an order that
  became packed some other way, or scrolled out of the list) never lingers in the count.
- **Verified live in dev**: three orders needing quantities 1/2/3 of the same SKU rendered as "1
  single-unit order" (the qty-1 order) plus two separate highlighted badges, "2×" and "3×" (the
  other two), and the button read "Picked"; selected three separate packing orders via checkbox, confirmed the "3 selected"
  toolbar and correct button label, clicked "Mark 3 packed" once, and confirmed all three flipped to
  `Packed` server-side (`order_items.status`, order status `'packing'` — same as marking each
  individually, just in one tap) with the selection cleared and checkboxes correctly gone once
  packed.

## Recently done (2026-09-20, a nineteenth pass) — AWB scanning decoupled into its own record-keeping Scan section

The user's objection to the fourteenth pass's inline scan screen: it made a packer pre-select "this
specific order, now scan its label," one at a time, with a fresh click per order — "how is one
supposed to match order id and scan label to that order id, this matching system makes less sense."
Confirmed directly: **"this is just for record keeping"** — no clever verification wanted, just a
packer scanning a pile of already-packed, already-labeled boxes continuously, with the system
logging each one and building a table live. Planned in EnterPlanMode given the real design fork
(what happens when a scanned code doesn't match anything) and a genuine accuracy question worth
getting right before touching the shipping pipeline; simplified once during planning after the
"record keeping" clarification dropped a tracking-id verification branch that wasn't wanted.

- **Matching is pure FIFO, nothing smarter**: a scanned code always resolves to whichever order has
  been sitting in the pending-label pool the longest (`getPendingLabels`, warehouse-wide — any
  packer's completed order, not just the scanning packer's own), via the new
  `applyAwbByScan(db, userId, warehouseId, awbCode)` (`packer.ts`). Replaces the old
  `applyAwb(packSessionId, awbCode)`, which required a pre-selected order and did a mismatch check
  against an expected tracking id — both gone.
- **One wrinkle handled without reintroducing verification**: if admin already pre-purchased a real
  Amazon label for the FIFO-matched order (`scheduleEasyShipForOrder`, before or during packing), a
  `packages` row already exists for it with `pack_session_id` still `NULL`. `applyAwbByScan` looks
  this up **by order id**, not by comparing codes, and links to that existing row instead of
  creating a second one — otherwise the real purchased label would end up orphaned and untracked.
  Verified live: pre-inserted a fake unlinked package+shipment (`tracking_id =
  'REAL-AMZN-TRACKING-999'`) for a pending order, scanned that exact code, and confirmed the
  *existing* shipment id came back — no duplicate package created.
- **New `awb_scans` table** (migration `0013`, applied to both `--local` and `--remote`) — the
  "separate database of scanned awb" the user asked for: a pure append-only log (code, matched
  order, packer, timestamp), independent of `awbs` (one row per shipment). Deliberately never
  deleted by `resetPickPackData` — a real gap found and fixed mid-verification: the reset's
  `includeReadyToShip` path (sixteenth pass) hit a fresh FK violation the moment it tried to delete
  shipments that `awb_scans` now referenced. Fixed the same way `exception_events` already handles
  this — null the FK columns (`order_id`, `shipment_id`) before deleting the rows they point to,
  keeping the scan log itself permanent.
- **New `/packer/scan` page** — a real third destination, not just the "Scan" pill routing back to
  `/packer` (the eighteenth pass's actual bug, now fixed on all three TopBars: `picker/index.astro`,
  `packer/index.astro`, `packer/home.astro`). Shows "N waiting to be scanned" plus a compact preview
  (photo, order id, SKU code, unit count) of what's coming, oldest first. "Start scanning" opens the
  camera via a new `startContinuousScan` (`scanner-client.ts` — same hints/constraints as `scanOnce`
  but never stops after the first hit); every detected code auto-submits with **no click required
  per box**, flashes a one-line result, and prepends to a results table rebuilt from `getTodayScans`
  on every load so nothing is lost on refresh. A manual-entry text field stays live alongside the
  camera as a fallback. A real implementation bug caught and fixed before shipping: the first draft
  called a full-page re-render after every scan, which would have destroyed and reopened the live
  `<video>` element on every single box — exactly the per-box friction this page exists to remove.
  Fixed by splitting the page into a `#scan-area` (built once when scanning starts, never touched
  again until "Stop scanning") and a `#results-area` updated independently after each scan.
- **`/packer`'s "Finish packing"** no longer builds a label queue or navigates into a scan screen —
  it just completes the pack session(s) and shows a plain success banner pointing to `/packer/scan`.
  Button relabeled from "Finish packing — apply labels (N)" to **"Finish packing (N)"**.
- **Verified live end-to-end in dev**: packed and finished three orders roughly 2 seconds apart,
  confirmed the Scan page listed them oldest-first with photo/SKU/units; scanned two arbitrary codes
  and confirmed they matched the two oldest orders in order (never the same one twice); the
  pre-purchased-package case above; a duplicate-code scan correctly rejected without touching the
  still-pending order; and a full page reload correctly rebuilt the "scanned today" table from the
  database rather than losing it.

## Recently done (2026-09-20, a twentieth pass) — over-pick bug fix, and a manual (file-based) Easy Ship path alongside the SP-API one

Two unrelated items this pass.

**Real bug: picker's over-pick block fired with the wrong number.** User report: "6 qty was rqd
and i picked 6 in it 2 single unit and 2 2x qty" but got "Cannot pick more than the required 4."
Traced (not reproduced from a live report — the failed attempt itself is never audit-logged, since
`confirmGroupQuantity` throws before writing anything) to `renderSkuGroup` in `picker/index.astro`:
`remainingNeeded` was `required - picked` summed over *every* row in the card, but a row already
resolved earlier as a short pick (`quantity_picked` left at 0, status no longer `'pending'`) still
counts its full `quantity_required` toward `required` without contributing to `picked` — so the
input's shown ceiling didn't match what `pendingIds` (the tasks actually submitted) could accept,
which is exactly what the server's real check enforces. Fixed: `remainingNeeded` is now the sum of
`quantity_required` over `pendingRows` only. Deployed, verified against no other regressions via
`npx astro check`.

**The bigger piece: Amazon Seller Central has its own manual, file-based Easy Ship flow that needs
no SP-API access at all** — Order → Upload Order Related Files → Schedule Pickup. The user found
this as a better near-term path than waiting on the still-ungranted SP-API role (see "Next steps"
#3, below — that path is *not* removed, just no longer the only option). Built a parallel pipeline:

- **Generate the Schedule Pickup file.** New `/admin/schedule-pickup` (nav: Fulfillment → Schedule
  pickup) — same per-order box/weight-row UI as `bulk-ship.astro`, plus an invoice id (defaults to
  the order's digits-only external order id, editable) and a pickup date/slot (Amazon only accepts
  "11:00 AM"/"2:00 PM"). `generateScheduleFile` (`lib/schedule-pickup.ts`) creates local
  `packages`/`shipments` rows (same loose "committed" status semantics the SP-API path already
  uses — see `scheduleEasyShipForOrder`) and returns a tab-delimited `.txt`, exact column order
  confirmed against Amazon's own template (`order_id`, `invoice_id`, `package_weight`,
  `package_length/width/height`, `schedule_pickup_date`, `schedule_pickup_time`,
  `merchant_additional_identifier`, `transparency_code`), largest-dimension-first per Amazon's
  stated assumption, chunked at 500 rows/file per Amazon's stated cap. New table
  `schedule_pickup_batches` + `shipments.invoice_id`/`schedule_batch_id`/`manual_schedule_status`
  (migration `0014`, free-form status column — deliberately not fighting `shipments.status`'s
  existing CHECK enum for a sub-state it was never meant to carry).
- **Split/match/stamp the label PDF that comes back.** Admin uploads the label+invoice PDF
  downloaded from Seller Central (outside the app, after Amazon processes the file). New
  `lib/label-pdf.ts`: `extractPageTexts` (via `unpdf` — added as a dependency specifically because
  it's built for edge/serverless runtimes; **confirmed working under the real `workerd` runtime**
  via a throwaway spike route hit through both `astro dev` — Node — and a real `wrangler dev`
  instance, not just assumed) pulls per-page text; `matchPagesToOrders` assigns each page to
  whichever of *that batch's own* pending orders' `order_id`/`invoice_id` appears in its text — not
  a generic order-id-shaped regex, since the exact small candidate set is already known. A page
  with no id of its own (a trailing invoice/compliance page) inherits whichever order's pages came
  immediately before it; a page with nothing preceding it either goes to the "unmatched" list for
  manual assignment via a new `assign-page` endpoint. Matched pages get copied into a fresh small
  PDF (`pdf-lib`) and stamped with the package identifier + SKU short-code summary — extended
  `label-stamp.ts`'s single-line `stampPackageIdentifier` into a shared `stampCornerLines` so both
  paths draw the same way. Stores the result on the *same* `shipments.label_base64`/`label_status`
  columns the SP-API path uses (deliberately sets `label_status = 'document_ready'` too, not just
  `manual_schedule_status`) — confirmed `/api/admin/shipping/label-status` and bulk-ship's own
  print/download UI work unchanged against a manually-produced label without knowing which path
  made it.
- **Real bug caught mid-spike, not by symptom report**: `unpdf`/pdf.js **detaches the input
  `ArrayBuffer`** after extracting text (confirmed directly with a Node repro — not documented
  anywhere) — a second read of the same bytes (e.g. `pdf-lib` loading them afterward to build the
  stamped per-order PDF) throws "No PDF header found" against what looks like the identical buffer.
  Fixed by giving `extractPageTexts` a `.slice()`'d copy, never the original.
- **Verified live end-to-end in dev** against real seeded orders: generated a file for 2 real
  orders, uploaded a synthetic 4-page PDF (label+invoice for order A, label+invoice-lookalike for
  order B where the invoice page repeats only the *invoice id*, not the order id, plus a trailing
  unrelated "warranty terms" page) — confirmed correct 2-page grouping per order (the trailing
  unrelated page correctly inherited into whichever order's pages preceded it, matching the
  intentional "don't assume a fixed page pattern" design, not a bug); confirmed the stamp text
  (SKU code + order id) actually appears on the rendered PDF's last page; confirmed a genuinely
  *leading* unmatched page (nothing before it to inherit from) was correctly surfaced rather than
  silently dropped, and that manual assignment resolves it. Old `/admin/ship`/`/admin/bulk-ship`
  confirmed to still load with zero changes.
- **Not yet seen**: a real Amazon-exported label+invoice PDF. The matching logic is deliberately
  text-based rather than positional so it should tolerate whatever the real page layout turns out
  to be, but this is still unverified against a genuine Seller Central export — check this first
  the next time a real pickup goes through this path.

## Recently done (2026-09-20, a twenty-first pass) — station is now a fixed account property, pack list matches pick list, +/- steppers everywhere

Three requests: (1) packers were tapping/scanning into a packing station every time they moved
from Pick to Pack — "each packer id is assigned a station and it does not need to show everywhere
its just for reports data and references." (2) the pack list's item rows showed product name first,
SKU code second, small thumbnail — inconsistent with the pick list's SKU-code-led, big-thumbnail
convention from an earlier pass. (3) every quantity-picked/quantity-packed input should have +/-
buttons, not just a bare number field.

- **Station is now `users.station_id`** (migration `0015`), assigned once by admin in `/admin/users`
  (a new dropdown next to each packer row, `packing_stations`-backed, PATCHable independently of
  active/inactive) rather than a `stationQrToken` the packer scans/types into every session.
  `getMyPackBatches` (`lib/packer.ts`) and `/api/packer/start-session` now take the station straight
  off the authenticated user record — no more "unknown station" verification, since it's no longer
  client-supplied. `/packer` (Pack tab) dropped its entire "Tap in" screen (`renderStationPrompt`,
  the scan/manual-entry/pick-a-station-from-a-list flow, `renderManualEntry` with it — all dead code
  once nothing calls it) — landing on Pack now goes straight to the packing list, or a plain message
  if the account has no station assigned yet. The now-unused `/api/packer/stations.ts` (packer-facing
  station list) was deleted; `/api/admin/stations.ts` (admin-facing) is unaffected.
- **Pack list item rows now match the pick list's card style**: `thumb` → `thumb-lg`, SKU code as the
  bold primary line (was the product name), product name as the muted secondary line underneath (was
  the SKU code) — same layout `picker/index.astro`'s `renderSkuGroup` already established. Also fixed
  an incidental gap while touching this code: `sku_name`/`sku_code` were being interpolated into
  `innerHTML` unescaped (a real stored-XSS surface for catalog data pulled from Amazon) — now routed
  through `escapeHtml` like every other user/catalog-derived string in this app.
- **+/- steppers on every pick/packed quantity input** — the only two: picker's per-SKU-group pick
  quantity, packer's per-line pack quantity. New shared `qtyStepperHtml`/`wireQtySteppers` in
  `lib/ui.ts` (wraps the exact same `<input>` markup with two buttons, clamps to that input's own
  min/max, fires a real `input` event) rather than each page rolling its own — reused as-is in both
  `picker/index.astro` and `packer/index.astro`, wired once per re-rendered card.
- **Real production issue caught before it became a silent outage**: migration `0015` alone would
  have locked out every real packer the moment it deployed — production had **zero packing stations**
  and both active packer accounts (`packer`, `Anshul`) had no station to inherit. Caught by checking
  prod state before calling this done, not by a bug report. Fixed with the user's explicit go-ahead:
  created one default `Station 1` and assigned both to it (station/assignment is trivially editable
  going forward from `/admin/users` and `/admin/warehouse` — this was just an unblock, not a design
  decision about how many stations they actually have).
- **Verified live in dev** end-to-end: picked a full real batch of 13 orders (steppers used and
  confirmed functioning, no over-pick regressions), confirmed Pack loaded straight to the list with
  no station prompt, confirmed the new card style and steppers render and work on real order/SKU
  data, marked an order packed successfully. Local test-data reset back to `pending` via the existing
  reset tool afterward.

## Recently done (2026-09-20, a twenty-second pass) — a critical deploy bug, exception visibility, and follow-up fixes from a live user report

The user came back with a live report bundling several things: the new Schedule Pickup admin page
wasn't visible at all; picked orders weren't showing up in packing; and short-picks/damage/notes
logged on the floor have never been visible anywhere on the admin side.

**Root cause, and the most important thing in this pass: `wrangler deploy` does not run `astro
build` first.** `main: src/worker.ts` bundles fresh every time, but the actual page/API routes come
from whatever's already sitting in `dist/` — and `@astrojs/cloudflare`'s adapter generates its own
deploy config (`dist/server/wrangler.json`) that wrangler resolves at deploy time. Several passes
this session ran `npx astro check` (a type-check, not a build) immediately before `wrangler deploy`,
which looks identical in output to a real deploy but silently ships stale routes — this is exactly
why `/admin/schedule-pickup` 404'd in production despite being "deployed" twice. Confirmed via
`curl -o /dev/null -w "%{http_code}"` against the live URL, not assumed. **Fixed two ways**: (1)
added `"build": { "command": "npm run build" }` to `wrangler.jsonc` so a build runs automatically
before every `wrangler deploy`/`wrangler dev`; (2) going forward, always run `npx astro build`
explicitly immediately before `npx wrangler deploy` regardless of the hook, since the hook's
interaction with the adapter's redirect-config file showed a rough edge under `--dry-run` with an
empty `dist/` (fails loud in that specific case rather than silently — an acceptable trade, still
strictly better than the silent-stale-deploy failure mode it replaces, but don't rely on it alone).
**This means several earlier "Recently done" entries this session may have been live later than
their own timestamp suggests** — the fix is a full fresh build+deploy, which picks up all current
source regardless of what was stale before, so everything described in this file is confirmed live
as of this pass's deploy (Version `44e02ecd`), not necessarily earlier.

**"Orders picked not showing up in packing" was a real, separate consequence of the same
incident, compounded by the empty-`packing_stations` gap already found and fixed in the twenty-first
pass**: until the fresh build actually went out, production was still running the *old* tap-in-
station code, which requires a valid `packing_stations` row to match against — and production had
zero. So packing was blocked two ways at once (old code needing a station that didn't exist; new
code not deployed yet to remove that requirement) until this pass's real deploy landed. Should be
resolved now — next real pick should flow into packing normally. Verified the fix's shape (not the
live account, since real packer PINs aren't something to guess/test with) via the local dev
end-to-end pass in the twenty-first pass, plus confirming the deployed route now correctly redirects
like every other admin page instead of 404ing.

**New: `/admin/exceptions`** — every short pick, damage report, wrong-location/SKU scan, pack
mismatch, duplicate AWB, etc. has been logged to `exception_events` since the very first pass
(`logException`, `lib/db.ts`) but nothing ever read it back until now — confirmed by grepping the
whole codebase for readers before building this (only `reset.ts`, which just nulls FKs on reset).
New `src/pages/api/admin/exceptions.ts` resolves the order an exception belongs to via whichever of
its three optional FKs is populated (`order_id` directly, or `pick_task_id`/`pack_session_id`
indirectly — a historical exception can outlive the order it was about, since reset nulls those
FKs rather than deleting the row), plus the SKU when a `pick_task_id` is available. The page
(`src/pages/admin/exceptions.astro`, new "Orders" nav entry) defaults to unresolved-only, oldest-
unresolved-first-ish (actually resolved-status-then-recency), with a "Resolve"/"Reopen" toggle
(`PATCH`, never deletes — the row stays for history either way) and a "show resolved too" checkbox.
Verified live in dev against 9 real historical exceptions already sitting in the database from
earlier passes' testing — resolve/reopen both round-tripped correctly.

**Follow-up, same pass**: the user came back immediately after with a second, worse report — "you
have messed up big time... all orders are not showing in pick list", plus "retry blocked orders"
falsely reporting real-stock orders as short. Investigated directly against production data (not
guessed): found **all 35 currently-`pending` orders had already been fully picked** — their
`order_items`/`pick_tasks` were `'picked'` and their `pick_batches` `'completed'`, but `orders.status`
alone said `'pending'`, with no `pack_sessions` created. That single wrong field explained both
symptoms at once: they'd vanished from Pick because they weren't actually waiting to be picked (they
needed packing, not picking), and `retryBlockedOrders`/`reserveOrderForPicking` correctly refused to
re-reserve their (already real-picked, no-longer-pending) items, surfacing as a confusing "No items
to reserve" reason the admin UI unconditionally mislabeled "short on stock" even though it had
nothing to do with stock. **Root-caused to a real race in `resetPickPackData`**: it snapshots target
orders once, then does many sequential awaited writes across a loop — if any of those orders finish
picking for real (genuine floor activity, and the timestamps show picking *did* happen close in time
to two admin resets) before the function's final blind `UPDATE orders SET status = 'pending' WHERE id
IN (...)` runs, that write stomps the order's status back to `'pending'` while its already-completed
`pick_tasks`/`pack_sessions` — captured in an *earlier* snapshot, before they existed or changed —
never get cleaned up, since it thinks they're plain old leftover rows. **Fixed the reset function**
by re-guarding that final UPDATE with `AND status IN (...)` (the same status list the initial SELECT
used), so an order that's moved on since the snapshot is simply left alone instead of mislabeled.
**Repaired the 35 already-affected orders in production** (with the user's explicit go-ahead, since
it's a real-order data write) — checked first that this was purely a label problem (item/task/
inventory state was internally consistent and correct, no reservation double-counting risk) before
setting `orders.status` back to `'picked'` for exactly those 35, touching nothing else. Confirmed
live, immediately: a real packer's app auto-claimed all 35 into `pack_sessions` within seconds of the
fix landing. Also softened the admin UI's "retry blocked orders" message (`admin/index.astro`) to not
claim every failure is a stock issue, and gave `reserveOrderForPicking`'s "no pending items" case a
clearer reason string distinguishing "already processed, not a stock problem" from a genuinely empty
order.

## Recently done (2026-09-20, a twenty-third pass) — a stale cancelled-order pick bug, and a business-hours-only sync schedule

Two more items from a live user report, screenshot included.

**"Why is this short unresolved still showing"** — a screenshot showed a SKU card stuck permanently
at "Short — 2 unresolved" for order `402-0638176-4789928`. Checked production directly: the order's
own `status` was `'cancelled'`, and its one `pick_task` was correctly `'cancelled'` too (Amazon
cancelled it while its task was still `'pending'`, and `cancelOrderFromSync` — `amazon-sync.ts` —
handled that correctly), but **`getPickListView`'s query never filtered by order status at all**, so
a cancelled order's task kept appearing on the picker's screen forever. Worse, the picker UI's "done
but short" rendering (`picker/index.astro`) only checks `picked < required`, not the task's actual
status — so a `'cancelled'` task displays identically to a genuine unresolved short pick, with no way
to tell them apart or clear it. Fixed at the source: `getPickListView` now excludes
`o.status = 'cancelled'` outright, regardless of the task's own status — covers this case and any
other pre-cancellation task status (short, damaged, picked) in one place, rather than needing
`cancelOrderFromSync` to handle every individual status. Confirmed live: exactly one stale task
existed in production, and the fixed query now correctly excludes it.

**Sync schedule narrowed to business hours.** The user confirmed 5 minutes is fine, but pointed out
the warehouse only does live picking/packing ~9:00 AM-2:00 PM IST (Amazon Easy Ship's own cutoff) —
checking Amazon every 5 minutes around the clock is pure waste outside that window. Cloudflare Cron
Triggers always run in UTC with no timezone setting, and IST (UTC+5:30) doesn't land on a whole hour,
so the precise 9:00-2:00 window needed 3 cron expressions — which hit a real, confirmed-by-a-failed-
deploy wall: the account's Workers Free plan caps cron triggers at **5 total, shared across every
Worker on the account**, not per-worker. Collapsed to one expression, `*/5 3-8 * * *` (8:30 AM-2:30
PM IST) — slightly wider than asked on both ends rather than narrower, so nothing near the cutoff is
ever missed. An order placed overnight still isn't missed either way — `sync-job.ts`'s own 24-hour
lookback picks it up on the first run of the day regardless of exactly when that first run fires.
The precise 3-expression version is in git history if the account ever moves to Workers Paid (1,000
cron trigger limit) and the extra precision becomes worth spending on.

## Recently done (2026-09-20, a twenty-fourth pass) — blocked-order retry made automatic, not manual

User report: "36 orders blocked — short on stock" sitting on the packer dashboard, asking why
batching "takes so long" and wanting it "quick and auto" so a packer opening the app just sees
work waiting. Checked production directly rather than assuming: **stock was never actually the
problem** — every blocked SKU had far more available than needed (e.g. one needed 8, had 1224
available). The real issue: `reserveOrderForPicking` is a one-shot attempt at import time: if it
fails, the order sits at `'pending'` until *something* retries it, and until now the only things
that ever did were an admin manually clicking "Retry blocked orders" or a picker's own page
polling (`claimAvailableBatch`'s orphan-recovery in `picker.ts` — real, but only fires while that
specific page happens to be open). The packer *dashboard*'s "blocked" banner (`getUnbatchedOrderSummary`)
is a pure count/display query — it never retries anything itself, so it could sit there indefinitely
even once stock was genuinely available, looking exactly like a stuck/slow system when really nobody
had retried it yet. Watched this resolve live and unprompted mid-investigation (a real picker's page
polling triggered the existing orphan-recovery) — direct proof the retry mechanism itself works fine
the moment something actually calls it.

**Fixed by making retry automatic**: `runAmazonSyncJob` (`sync-job.ts`) now calls
`retryBlockedOrders` for each warehouse after every import/status-sync — so blocked orders self-heal
within one cron tick (~5 min, business-hours-only per the twenty-third pass) regardless of whether
any admin or picker session happens to be active. `SyncJobResult` gained `retried`/`retrySucceeded`
fields for observability. Also softened the packer dashboard's banner wording (`packer/home.astro`)
— no longer asserts "short on stock" or "ask admin to retry" (both were often simply wrong, and the
latter is now often unnecessary), instead explains it rechecks automatically and only points at
receiving stock if it's *still* there after a while. Confirmed live: the 36 orders this report was
about all reached `'packing'` shortly after.

## Recently done (2026-09-20, a twenty-fifth pass) — a shared "Today" overview, every role

The user wanted a "meta dashboard" any user (not just admin) can open to see the whole warehouse's
current-day state at a glance — pending/picking/packed/shipped etc., "and other things."

- **New `/dashboard`** ("Today" pill, added to every packer-flow TopBar — `picker/index.astro`,
  `packer/index.astro`, `packer/scan.astro`, `packer/home.astro` — plus a new "Today's overview" link
  at the top of `AdminSidebar.astro`) and **`GET /api/dashboard/today`** (`lib/dashboard.ts`,
  `getTodaySummary`) — deliberately **no role restriction** (`requireUser` with no `allowedRoles`),
  unlike everything under `/admin`, since the whole point is a packer and an admin seeing the same
  picture.
- Two different kinds of number, on purpose: a **live snapshot** of `orders.status` counts (pending
  through ready-to-ship) — which *is* today's picture in a same-day pick/pack/ship operation, not a
  separate "today" query — plus real **calendar-day activity counts** (shipped today via
  `audit_log`'s `order.shipped_sync`, cancelled today via `order.cancelled_sync`, units/orders picked
  today via `pick_tasks.picked_at`, units/orders packed today via `pack_sessions.completed_at`,
  mirroring `getPackerDailySummary`'s pattern but warehouse-wide instead of per-packer). Reuses
  `getUnbatchedOrderSummary` (blocked count) and the same exception-resolution query
  `api/admin/exceptions.ts` uses (open count) rather than duplicating either.
- Admin-only follow-up links (`Receive stock`, `review in Exceptions`) only render for `role ===
  'admin'` — a packer sees the same counts and banners but without a dead link to a page
  `requireAdminPage` would just bounce them out of.
- Verified live in dev (both roles) and on a mobile viewport (375px, two-column stat grid, no
  overflow) before deploying.

## Recently done (2026-09-20, a twenty-sixth pass) — assign picking by SKU, not one order at a time

The user's complaint: assigning pick work to packers meant opening `/admin/pick-list.astro`'s batch
dropdown and assigning one order at a time — with dozens of small orders that's dozens of clicks,
and the dropdown itself showed nothing but a timestamp per order, no idea what was actually in it.
Separately, the packer dashboard's "Upcoming" section had the same problem from the other side: one
row per order (always "1 order" per row, since one batch is always exactly one order), which doesn't
scale and tells a packer nothing about what they're about to pick.

Considered a full switch to SKU-based batches (replacing "1 batch = 1 order" as the core unit) but
that would ripple into inventory reservation, order-completion detection, and packing handoff — real
risk for a workflow-UI problem. Built the lighter version instead: **keep every order's own
`pick_batch` exactly as it is** (reservation, `checkBatchCompletion`, packing, all untouched), and add
a SKU-grouped *view + bulk-assign action* on top of it.

- **`getUnassignedSkuDemand`** (`lib/picker.ts`) — every SKU with at least one still-`'pending'`
  pick_task in a still-`'pending'` (unclaimed) batch, grouped by SKU with image, order count, and
  units needed. Replaces `getUpcomingBatches`/`UpcomingBatchSummary` (deleted — one row per order,
  always "1 order", exactly the useless case the user flagged).
- **One shared endpoint, `GET /api/picker/sku-demand`** (no role restriction), used by *both* the new
  admin screen and the packer dashboard — "things should not contradict each other" was the user's
  own words, so there's exactly one query computing this number, not two that could drift apart.
- **`assignSkusToPacker`** (`lib/picker.ts`) — admin selects one or more SKUs and a packer; finds
  every still-unclaimed order needing any of them and assigns that whole order to that packer
  (reuses `assignBatchToPacker` unchanged, looped, one failure doesn't abort the rest). An order
  keeps moving as one unit — no attempt to split a single order's own SKUs across two packers, since
  that's exactly the riskier path that was avoided. If an assigned order also needed a SKU outside
  the selected set, the result says so explicitly (`ordersWithOtherSkus`) rather than the admin
  discovering it later.
- **New `/admin/pick-assign.astro`** ("Assign picking" in the sidebar, above "Pick lists") — the SKU
  table with checkboxes, photos, order/unit counts, a packer picker, and one "Assign selected"
  action instead of dozens of individual ones.
- **`packer/home.astro`'s "Upcoming" section** now renders the same SKU-grouped rows (photo, SKU
  code/name, units needed, order count) instead of the old one-row-per-order list.
- Verified live in dev: reset+retried local test data to get real unclaimed batches, selected 2 SKUs
  on the new admin screen, assigned to a packer — confirmed the exact expected order count, correctly
  flagged the one order that also carried an unselected SKU, and confirmed the packer dashboard's own
  "Upcoming" list reads from the identical live query (watched it correctly go to zero once the only
  active test packer's own polling swept up everything else too — expected with a single packer, not
  a bug).

## Recently done (2026-09-20, a twenty-seventh pass) — SKU merge tool couldn't tell duplicates from variations

The user's complaint: SKUs feel "synced wrong" — the duplicate-scan and merge screens never showed a
photo, title, or anything else to actually compare two candidates before merging, and the sync/scan
buttons gave no sense of progress. Checked production data before touching anything (per the usual
practice here — verify against real rows, don't assume): of the 44 SKUs already merged via this tool,
2 pairs turned out to have **different Amazon photos** despite an identical title — e.g. "5 Pack Cute
Dog Bookmarks" covers more than one color variant under the same generic listing title, and the
exact-name duplicate scan (`findDuplicateSkus`, `skus.ts`) can't tell that apart from a real duplicate
using title text alone. That's the real bug: not a sync/matching defect (checked — no case/whitespace
`sku_code` collisions exist in production), but a missing-signal problem in the merge tool itself.

- **ASIN now persisted** (`migrations/0016_sku_asin.sql`, applied local + remote) — `fetchAllListings`
  and Amazon order-item imports both already fetched the ASIN and silently discarded it; now stored
  on `skus.asin` by both `catalog-sync.ts` and `orders.ts`. It's the one signal that survives when two
  genuinely different products share a byte-identical title.
- **`findDuplicateSkus`** (`skus.ts`) now returns `imageUrl`/`asin` per candidate and a group-level
  `hasAsinMismatch` flag (true when a group's candidates carry ≥2 distinct known ASINs). **
  `previewSkuMerge`** now returns `imageUrl`/`asin` for both sides plus an `asinMismatch` flag — never
  true just because one side's ASIN is unknown, only when both are known and differ.
- **`/admin/inventory.astro`** — the duplicate-scan list now shows each candidate's actual photo, code,
  and ASIN side by side (not just codes/counts), with a red banner on any group with an ASIN mismatch
  warning it's likely different variations, not duplicates. The merge-preview banner does the same:
  both SKUs' photos + ASIN shown before "Confirm merge", switching to a red (not just amber) banner
  and an explicit ASIN-mismatch warning when applicable. Nothing is blocked — still admin's call — but
  now an informed one.
- **Progress feedback**: "Scan for duplicates" gets an animated indeterminate bar (single fast query,
  no real sub-steps to report). "Sync Amazon catalog" (`inbound.astro`) gets real incremental
  progress — `syncAmazonCatalog` now takes an `onProgress` callback fired after each page of listings
  is fetched *and written* (not just fetched), and the API route (`sync-amazon-catalog.ts`) streams
  newline-delimited JSON instead of one response at the end, so the client can show "N listings synced
  so far…" while a 200+ page sync is still running instead of a frozen spinner.
- Verified live in dev against the real Amazon catalog (local D1, not production data): sync streamed
  real incremental counts up to "227 listings synced" then completed; the duplicate scan found 41 real
  groups from the synced catalog, correctly showed matching photos+ASIN for a genuine duplicate pair
  and correctly red-flagged/showed differing photos for an ASIN-mismatched pair (the "Dog Bookmarks"
  case) with the merge-preview screen rendering the same warning before confirm.
- **Left alone deliberately**: did not attempt to un-merge the 2 already-suspect production pairs
  found while investigating — that's a data decision for the user now that they can actually see the
  photos, not something to silently correct. Worth pointing out to them directly.

**Update, same day**: user asked to fix the 2 suspect pairs. Confirmed both were losslessly
reversible before touching anything — `inventory`/`order_items`/`pick_tasks` all showed zero rows
ever attached to either source SKU (`K4-WYCE-N7SH`, `TANKEY`), and the original merge log entries
for both recorded 0 units/lines/tasks moved. So "unmerging" needed no data reconstruction, just
`UPDATE skus SET merged_into_id = NULL WHERE id IN (...)` on the two source rows, run directly
against production after explicit user confirmation. Logged as `sku.unmerge` in `audit_log` (not a
code path yet — there's no "Unmerge" button in the UI, this was a one-off manual fix). Their sibling
merges under the same targets (`RZBH-WT` → `RZBH-B`, `6R-4S62-STFM` → `TANKEY-W`) were checked too
and confirmed genuine — same photo as the target both times — so those were left merged.
`K4-WYCE-N7SH` and `TANKEY` now sit as independent, zero-stock SKUs again; if the user has real
physical stock of either variant, it still needs to be received in separately under those codes.

## Recently done (2026-09-20, a twenty-eighth pass) — the gun holder was a real fulfillment bug, and the catalog-sync corruption was systemic

The user reported one specific mismatch (`GN-HLDR` showing the wrong photo) that turned into finding and
fixing a real, systemic production bug, plus a genuine mistake of my own that had to be caught and reversed.

**The gun holder (`GN-HLDR` / `U8-9OI6-L4OE`) — a real fulfillment bug, not just a display issue.**
Checked live against Amazon's own Orders API (not just catalog data): all 4 order lines currently attached
to `GN-HLDR` had actually been placed by customers under SellerSKU `U8-9OI6-L4OE` (the "(Classic)" variant,
ASIN `B0H42JFR5F` vs `GN-HLDR`'s real `B0GK34S8G9`) — a manual merge from an earlier incident had silently
redirected them. 3 were still unfulfilled and past their ship-by date; none had reached picking yet (verified
before touching anything). Fixed: moved the 4 order lines back to `U8-9OI6-L4OE`, un-merged it, corrected
`GN-HLDR`'s photo/ASIN to its own real listing data.

**Root cause, found while investigating a second reported mismatch (`DOG-BKM-5`): `syncAmazonCatalog` was
systemic, not a one-off.** `resolveSkuIdByCode` (correctly used for order import, so a merged code's future
orders still route to the survivor) was *also* being used for catalog sync's name/image/asin **write** —
meaning every sync silently let a merged-away code's live Amazon listing overwrite the survivor's real
photo/title/asin, whichever pagination order processed last. Fixed in `catalog-sync.ts`: the write now only
ever applies via a SKU's own, current, non-merged `sku_code` — a merged-away code's listing is now counted
in a new `skippedMerged` field and otherwise ignored, never written onto another row. Surfaced in the
"Sync Amazon catalog" success message on `inbound.astro` when non-zero.

**Full production sweep, and a real mistake caught mid-course.** Cross-referenced all 41 remaining merged
pairs directly against live Amazon Listings API data (not stored DB values, which can't be trusted once
this bug existed). Initially flagged `K4-WYCE-N7SH`→`RZBH-B` and `TANKEY`→`TANKEY-W` as *also* wrong back
in the same-day pass before this one — **that was a mistake**: their comparison was against `RZBH-B`'s and
`TANKEY-W`'s *stored* photos, which were themselves already corrupted by a different, genuinely-wrong
source (`RZBH-WT`, `6R-4S62-STFM`). Checked directly against live data: `K4-WYCE-N7SH`/`RZBH-B` share the
exact same photo, and `TANKEY`/`TANKEY-W` share the exact same ASIN — both genuine duplicates. Re-merged
both back. The user also corrected an over-broad assumption on my part: a differing photo/ASIN does not by
itself mean "wrong merge" — a seller can deliberately treat real color/variant siblings as one fungible
warehouse SKU. Confirmed with the user pair-by-pair before acting; final state:
- **Unmerged** (confirmed genuinely different products, zero inventory/orders ever attached, so lossless):
  `1L-OOVK-UP4B` (dog bookmark), `GUNM-2` (gun holder, a *second* wrong source into `GN-HLDR`),
  `B6-DH0K-QILV` (controller stand), `AR-Z9YP-S4HN` (LEGO baseplate), `RZBH-WT` (razor holder),
  `SKRA-1` (bookmark), `6R-4S62-STFM` (keychain), `RAKHI-2` (rakhi thread).
- **Re-merged** (genuine duplicates, wrongly separated by my own earlier mistake): `K4-WYCE-N7SH` → `RZBH-B`,
  `TANKEY` → `TANKEY-W`.
- **Corrected photo/ASIN** on 10 targets total (the 8 unmerge targets + `8-BIT-BLK`/`CAT-SCR-CAC`, which were
  genuine duplicates with only a stale ASIN) back to each one's own live Amazon data.
- All logged to `audit_log` (`sku.unmerge`, `sku.merge_sweep`).

**New: an "Unmerge a SKU" card on `/admin/inventory`** (`previewSkuUnmerge`/`unmergeSku` in `skus.ts`,
`api/admin/sku-unmerge.ts`) — the user asked for this directly after watching several of these fixes happen
only via me running raw SQL. Enter a merged (retired) code, see what it's merged into (photo/ASIN/name) plus
the target's current inventory/order-line counts *for context only*, then confirm. Deliberately does **not**
attempt to move inventory/orders back automatically — once merged, there's no reliable way to tell which of
the target's current rows were always its own vs. genuinely moved from the source, so a blind auto-reversal
would be exactly as much a guess as the original wrong merge. If real stock/orders need separating (like the
gun holder case), that still needs the same manual, evidence-based check (cross-reference Amazon's own order
records) done in this pass — not something a generic "unmerge" button can safely automate.

## Recently done (2026-09-20, a twenty-ninth pass) — duplicate detection rebuilt around ASIN/photo instead of title

Direct follow-up to the previous pass. The user's point: most products have one unique ASIN, but a real
minority genuinely have more than one (relisted after suppression, etc.) with the same photo, and separately
some SKU codes share the exact same ASIN outright (unambiguously the same listing) — the old exact-title-match
scan couldn't use either signal, so it both missed real duplicates and (per the previous pass) mistook real
color/size variations for duplicates just because their generic titles matched.

- **`findDuplicateSkus`** (`skus.ts`) rewritten as a three-tier confidence system, each SKU claimed by the
  strongest tier it matches (never re-flagged by a weaker one):
  1. `same_asin` — two+ SKU codes share the identical ASIN. Certain: ASIN *is* Amazon's product identity.
  2. `same_image` — different (or unknown) ASINs but the exact same product photo. Very strong — a real
     product photo isn't reused by coincidence — and catches a listing relisted under a new ASIN, which
     ASIN-matching alone would miss.
  3. `same_title` — last-resort fallback, only for SKUs with no ASIN/photo to compare (never synced, or an
     inactive listing). The only tier where a real variation can still slip through, and now labeled as such.
  Each group carries a `matchType` + `hasAsinMismatch`, rendered on `/admin/inventory` as a confidence pill
  ("Certain — same ASIN" / "Likely — same photo" / "Weak — title only") with tier-appropriate copy — a
  same_title group's note no longer implies "no data," since (confirmed live) a same-title pair can have two
  known ASINs that simply disagree, which is a different, more informative fact than missing data.
- **Real bug found and fixed in `catalog-sync.ts`**: the previous pass's fix (don't let a merged-away code's
  listing overwrite the *target's* data) had gone one step too far and skipped writing to the merged-away
  row's *own* fields too — meaning a merged SKU's own ASIN could never be backfilled by sync, permanently.
  Confirmed in production: 33 of 35 merged SKUs had no ASIN, vs. only 4 of 195 non-merged ones. Fixed: the
  lookup is always by `sku_code` directly (never resolved through a merge redirect), so `existing.id` is
  always that exact row's own id regardless of merge status — updating it is always safe. Re-running "Sync
  Amazon catalog" now backfills ASIN/photo on merged rows too, which matters for exactly this scan (an
  unmerged sibling can't be ASIN/photo-matched against a merged one that has neither on file).
- Verified live in dev: scan against the real synced catalog found 54 groups — 30 certain (same ASIN), 23
  likely (same photo, different ASIN — the "relisted" case the user described), 1 weak (title only, and
  confirmed that one has two known-but-disagreeing ASINs, not missing data).
- **Note for the user**: production's 33 merged SKUs still won't show a backfilled ASIN until "Sync Amazon
  catalog" is clicked again on `/admin/inbound` — I can't trigger it myself (needs a live admin session).

## Recently done (2026-09-20, a twenty-ninth pass) — EFNSKU, an "unmerge all" button, and a packer activation gate

Three separate asks from the same conversation, landed together.

**EFNSKU — our own answer to Amazon's FNSKU concept** (`migrations/0017_efnsku.sql`, `lib/skus.ts`).
Every SKU-merge bug fixed this session traced back to the same root cause: the only signals
available for "is this the same physical product" (title, ASIN, photo) all come from Amazon and
have each turned out unreliable alone. EFNSKU sidesteps that by putting a human in the loop at the
moment the physical item is actually in hand — receiving. New `skus.efnsku` column (nullable,
partial-unique index). `suggestNextEfnsku` proposes the next sequential code (`EFN-000042`, easy to
read/write on a physical label); `setEfnsku` is the assignment function and — this is the important
part — doubles as the merge trigger: if the EFNSKU typed in already belongs to a different SKU, that
means staff just confirmed "this is the same product I already logged," and the two are merged
immediately via the existing, audited `mergeSku()` path rather than a second merge mechanism.
Deliberately did **not** do the "proper" fix of splitting `skus` into a separate products/SellerSKU-
alias schema (would touch inventory/order_items/pick_tasks FKs across nearly the whole app) — this
additive approach gets the same practical outcome (a human-verified, Amazon-independent product
identity) by reusing 100% of already-built, tested merge infrastructure instead.
- **Receiving (`/admin/inbound.astro`)** now shows an EFNSKU field, pre-filled with the suggestion,
  whenever a line's SKU (new, or existing without one yet) needs one — hidden once a SKU already
  has one. Copy explains the merge-on-reuse behavior directly in the form.
- **Displayed** in the Inventory stock table (new EFNSKU column) and in the merge-preview/duplicate-
  scan cards alongside ASIN. `previewSkuMerge` and `findDuplicateSkus` both gained an
  `efnskuMismatch`/`hasEfnskuMismatch` signal — stronger than the existing ASIN-mismatch one, since
  it means a human already made the "different products" call, not just that Amazon's catalog data
  disagrees. Surfaced as a `banner-danger` (vs. the ASIN case's `banner-warning`).
- **Verified live in dev**: received a new SKU (`TEST-EFN-1`, suggested `EFN-000001` accepted as-is);
  received a second, different SKU code but typed `EFN-000001` again — confirmed it auto-merged into
  the first and correctly summed the inventory at the shared location.
- **Not done yet**: EFNSKU isn't shown on the picker/packer screens, and printing it on shipping
  labels (replacing the plain `sku_code` originally planned for that — see "short code" in Open
  items) is still blocked on the same Easy Ship SP-API/label-content item it always was — noting the
  field to use once that unblocks, no code needed today.

**"Unmerge all listings"** (`unmergeAllSkus` in `lib/skus.ts`, `api/admin/sku-unmerge-all.ts`) — a
blunt, one-click reset of every merge relationship at once, for "start over from a clean slate."
Separate route from the single-SKU unmerge on purpose (more consequential, shouldn't be reachable by
a body-shape typo), gated behind the same `confirmDangerousAction` dialog pattern used for "Reset
picking & packing." Same non-negotiable as single unmerge: never moves inventory/orders, only clears
`merged_into_id`.

**Packer "Activate pick list" gate** (`picker/index.astro`, `lib/picker.ts`). The user's framing:
admin's "Retry blocked orders" button (renamed **"Assign orders to pick list"** on `/admin` — same
`retryBlockedOrders` call underneath, just honestly relabeled for what it actually does) and the
picker's automatic instant-claim-on-login were the two existing paths orders reach a pick list
through; wanted a deliberate two-tap start on the picker's side (`Activate pick list` → progress bar
→ `Start picking`) without reintroducing any wait on admin action — the list itself is still
assembled fully automatically in the background exactly as before.
- `getMyBatches` rewritten to fetch every claimed batch's rows in one query instead of looping
  `getPickListView` per batch (was N+1 D1 round trips) — "make its processing quick" from the user,
  and this gate now depends on that round trip feeling instant. Also returns each batch's `status`.
- New `Stage` state machine in `picker/index.astro`: `gate` (summary + Activate button) →
  `activating` (progress bar, re-fetches for freshness) → `ready` (Start picking button) → `working`
  (the original flat pick-section list, unchanged). A reload mid-walk skips straight to `working` —
  detected via task-level progress (`some row status !== 'pending'`), not batch status, since this
  scan-free list UI never actually moves a `pick_batch` to `'in_progress'` (that only happens through
  the older QR-confirm flow, `confirm-location.ts`/`scan-item.ts`, which nothing here calls — see
  Open items #11, still dead code).
- **Verified live in dev**: logged in as the seed `packer` user, saw the gate with a real summary
  (13 orders · 5 SKU lines · 27 units), activated, started picking, picked one line, reloaded — landed
  straight back in the working list with no gate, as intended.

## Recently done (2026-09-20, a thirtieth pass) — MSKU rename, and a manual Amazon sync button

**EFNSKU renamed to MSKU** ("Master SKU") before it saw any real production use — user didn't like
the original name. Full rename: DB column (`migrations/0018_rename_efnsku_to_msku.sql`), every
function/type/UI string/CSS class, and the code prefix (`EFN-` → `MSKU-`). No data migration needed
since nothing in production had the field set yet.

**Real incident that prompted this**: the user reported orders showing as unshipped in the app hours
after being physically shipped. Investigated live against the real Amazon account (not guessing) —
turned out **not** a sync bug: Amazon's own OrderStatus API genuinely still said "Unshipped" for the
affected orders, and no shipment/AWB record existed for them anywhere in this system either. The
actual gap: those two orders were packed but the Ship step was never completed for them by whoever
handled them physically that morning — a workflow slip, not a software bug. Confirmed the automatic
sync logic itself is correct and current.

That said, the *automatic* sync only runs on a cron scoped to warehouse hours (8:30am-2:30pm IST,
see wrangler.jsonc) to stay under the account's cron-trigger limit — so anything that changes on
Amazon's side outside that window sits unsynced until the window reopens next day. Added a manual
escape hatch for exactly that: **`api/admin/sync-now.ts`** and **`api/picker/sync-now.ts`**, both
thin wrappers around the existing `runAmazonSyncJob` (the same pull+status+retry cycle the cron
runs) — "Sync with Amazon now" button on `/admin`, "Sync now" button on `/packer/home` next to the
"Upcoming" section. Neither replaces the cron; both just force a check on demand. **Verified live
against the real Amazon account**: the admin button pulled in 14 new orders, marked 29 shipped, and
cancelled 1 — confirming both that the button works end-to-end and that local dev's data really had
drifted stale exactly as the user described. Also fixed a real, if minor, bug found while testing:
a `title` attribute on the new admin button was overriding its accessible name in the a11y tree
(the visible label "Sync with Amazon now" was invisible to `find`/screen readers, which instead saw
the tooltip text) — removed the `title`, kept the label self-explanatory instead.

**Update, same day**: user correctly pointed out "Import from Amazon" and "Sync with Amazon now"
were doing overlapping work (both pulled new orders) — merged into one button. `runAmazonSyncJob`
now takes a `sinceHours` param (cron keeps its 24h default; a manual click passes 72h, matching the
old Import button's more generous catch-up window). `SyncJobResult` also gained `shortOrders` so
the merged button doesn't lose the per-order blocked-reason detail the old Import button showed.
Deleted `api/admin/import-amazon-orders.ts` and its button entirely — one action now: "Sync with
Amazon" on `/admin`, does pull + status-check + retry together. Verified live against the real
account again post-merge.

## Recently done (2026-09-21, a thirty-first pass) — parent SKUs excluded from duplicate-scan, sync sped up

**Parent SKU fix.** User reported the duplicate scanner was flagging Amazon variation-family
*parent* SellerSKUs — a parent is Amazon's own grouping construct for a "choose a style/color"
listing family, holds no real inventory, and can never actually be ordered; only its children can.
Investigated live against the real Listings API (`includedData=summaries,relationships,attributes`
on a sample) rather than guessing at field names, and found the reliable signal already present in
data this app already fetches: a parent's `summaries[].status` never includes `"BUYABLE"` — every
real, sellable child does. Confirmed against this seller's actual catalog: **58 of 227 listings are
parent-only** (e.g. `HOG-4AA`, a "style" family with 12 children including `DOG-BKM-5` and
`1L-OOVK-UP4B` — explains why those two kept looking like plausible near-duplicates in earlier
passes even though they're genuinely different sellable products).
- New `skus.is_parent_asin` column (`migrations/0019_skus_is_parent.sql`, default 0). `ListingSummary`
  (amazon.ts) gained `buyable: boolean`. `syncAmazonCatalog` now: skips creating a row at all for a
  brand-new parent SellerSKU; for one that's already a row, sets `is_parent_asin = 1` **without**
  touching its name/image/asin (a parent's own title/photo describe the whole family, not
  specifically whatever this row's history is about) and reports the count as `skippedParent`.
  `findDuplicateSkus` excludes `is_parent_asin = 1` from being a candidate at all.
- **Real edge case found and handled carefully, not glossed over**: 3 of the 58 (`KTN4`, `KTN-3W`,
  `RKH-CMB-6`) already had real inventory/order/pick-task history in this system — Amazon
  apparently reclassified a previously-standalone product into a parent *after* it had already been
  sold/stocked here. `KTN4` specifically has 17 units on hand and one currently-open pick task.
  Checked this before writing anything — a naive "delete every non-buyable SKU" pass would have
  broken a live in-flight order. These three keep functioning exactly as before (inventory, picking,
  receiving all untouched) and are simply excluded from future duplicate-scan candidacy; nothing
  about their existing data changes.
- Verified live in local dev against the real Amazon account: sync reported "58 parent listings
  ignored"; `KTN4`/`KTN-3W`/`HOG-4AA` confirmed `is_parent_asin=1` with names/images unchanged;
  duplicate-scan group count dropped from 54 to 29 and none of the three appear anywhere in results.

**Order sync/import speed.** Two real sequential bottlenecks fixed with a new bounded-concurrency
helper (`lib/concurrency.ts`, a small worker-pool `mapWithConcurrency`, not a new dependency):
1. `fetchUnfulfilledOrders` (amazon.ts) was calling Amazon's `GetOrderItems` once per order, fully
   sequentially — a sync pulling 20+ orders paid 20+ round trips back to back. Now fetched 5 at a
   time (comfortably under Amazon's documented GetOrderItems burst allowance of 30), each still
   wrapped in its own try/catch exactly as before (one order's failure doesn't cost the others).
2. `importAmazonOrders` (orders.ts) processed orders one at a time; now also 5 at a time, since
   orders are independent of each other. The one real hazard this introduces — two orders both
   containing the *same* brand-new SellerSKU racing to create its `skus` row — is handled with
   `INSERT ... ON CONFLICT (sku_code) DO NOTHING` + re-resolve rather than a bare INSERT, so the
   loser of that race reuses the winner's row instead of hitting the sku_code UNIQUE constraint.
   `reserveOrderForPicking`'s inventory claims already use optimistic (version-column) concurrency,
   so two orders genuinely competing for the same scarce SKU still resolve correctly.
- **Deliberately left `retryBlockedOrders`/`retryBlockedOrdersForSku` sequential** — unlike import,
  these explicitly `ORDER BY priority DESC, created_at ASC` to guarantee older/higher-priority
  blocked orders get scarce stock first when it arrives; parallelizing would turn that fairness
  guarantee into a race. They're also typically a much smaller list than a fresh order pull, so the
  speed upside would have been marginal against a real behavioral risk.

## Recently done (2026-09-21, a thirty-second pass) — active/inactive listing visibility, and a D1 rows_read incident

**Active vs. inactive listings.** Follow-on to the parent-SKU work above: the receiving product
search (`/api/admin/inbound` GET, used by inbound.astro's "Receive stock" tool) listed *every*
non-merged SKU including `is_parent_asin = 1` rows — meaning an admin could still pick a parent
listing like `HOG-4AA` as the target of a stock receipt, creating a real inventory row for
something that can never actually be ordered. Fixed by adding `AND is_parent_asin = 0` to that
query. Separately, there was no admin-visible listing of the full catalog at all — a parent/
inactive SKU was completely invisible everywhere once flagged. Gave `/api/admin/skus` GET (until
now unused — dead code) a real purpose: returns every non-merged SKU with `asin`/`is_parent_asin`,
and wired it into a new collapsible "Full catalog (active + inactive)" table on inbound.astro,
labelled Active/Inactive. Verified live: 176 active + 58 inactive shown in the table; the receiving
search's SKU list dropped from 234 to 175 (excludes both inactive listings and one already-merged
code) and no longer contains `HOG-4AA` or `KTN4`.

**D1 `rows_read` incident.** Cloudflare emailed that the free-tier daily cap (5,000,000 rows_read)
was at 77% for the day, three days after launch. Investigated with `wrangler d1 info wms-db`
(shows rolling 24h stats): 112,854 read queries, 6,282,058 rows read — ~56 rows/query average
despite every table in the schema being under a few hundred rows, which only makes sense as **full
table scans**, not big single queries. Two root causes found, both fixed (not just one — traced it
all the way through rather than stopping at the first plausible answer):
1. `getTodaySummary` (dashboard.ts) — the "how's today going" panel *any* logged-in user can open
   (`api/dashboard/today.ts` has no role restriction on purpose), polled every 15s per open tab —
   had two subqueries filtering `audit_log` with `date(created_at) = date('now')`. Wrapping a
   column in a function defeats any index on it, so this was a full scan of the *entire* audit_log
   table (1,486 rows and growing — it's the append-only log of every scan/action ever) on every
   single poll, from every open tab, forever. This alone plausibly accounts for the large majority
   of the day's reads, and would only get worse as audit_log keeps growing.
2. `pick_batches` had no index at all beyond its primary key, despite being filtered by
   `warehouse_id`/`assigned_picker_id`/`status` in several 8-15s-polled endpoints (claim-batch,
   packer/picker dashboards, admin pick-assign's `sku-demand` poll) — likewise a full scan on every
   poll, from every session, on every one of those endpoints.
- Fixed the query pattern everywhere it appeared (`dashboard.ts` x3, `packer.ts` x2 — one against
  `pack_sessions`, one against `awb_scans`): rewrote `date(col) = date('now')` to a plain
  `col >= date('now') AND col < date('now', '+1 day')` range. `created_at`/`picked_at`/
  `completed_at`/`scanned_at` are all ISO 8601 text (`datetime('now')`), which sorts identically to
  a real comparison, so this is a pure behavior-preserving rewrite — just one that an index can
  actually use.
- New indexes (`migrations/0020_hot_path_indexes.sql`): `audit_log(action, created_at)`,
  `pick_batches(warehouse_id, status)`, `pick_batches(assigned_picker_id, status)`,
  `pick_tasks(status)`, `pack_sessions(packer_id, status)`, `order_items(sku_id)`. `awb_scans`
  already had `(warehouse_id, scanned_at)` from migration 0013 — the query rewrite alone made that
  existing index usable, no new index needed there.
- Applied directly to remote D1 immediately (schema-only, no deploy needed, safe to run against a
  live database) ahead of shipping the query-side fix, since the free-tier cap was actively at risk
  of being hit that same day. `wrangler d1 execute --remote --file` printed a spurious "Not
  currently importing anything" error after "Processed 6 queries" — a known CLI quirk, not a real
  failure; verified all 6 indexes actually exist via `sqlite_master` before trusting it.
- Not otherwise changed: polling intervals (8-15s across picker/packer/admin screens) were left
  alone — every one of them already had a `document.hidden` guard, so the real problem was
  per-query cost, not polling frequency itself.

**Pick list activation now actually persists.** User reported two related bugs on the picker's
"Activate pick list" gate (picker/index.astro): (1) reloading the page after activating but before
the first pick dropped the picker straight back to the Activate button, as if nothing had happened;
(2) admin's "Pick lists" page (pick-list.astro, backed by `/api/admin/batches`) listed *every*
pick_batch ever auto-created — one gets created per order the instant it's reserved
(`reserveOrderForPicking`), long before any human looks at it — so the page was mostly noise, not
actual work in flight. Root cause of both: "activation" only ever existed as an in-memory `stage`
variable in the browser. `pick_batches.status` never left `'assigned'` through this newer scan-free
picker flow (a stale comment in getMyBatches even documented the *intent* for status to carry this
signal, but nothing wired it up — the older QR-confirm flow's `in_progress` transition was never
reachable from here).
- New `activateBatches` (lib/picker.ts) + `POST /api/picker/activate-batches`: the real, DB-persisted
  effect of tapping "Activate pick list" — `UPDATE pick_batches SET status = 'in_progress' WHERE
  warehouse_id = ? AND assigned_picker_id = ? AND status = 'assigned'`. picker/index.astro's
  `activate()` now calls this before re-fetching; `boot()` now resumes to `'ready'` (not `'gate'`) on
  reload whenever any claimed batch is already `in_progress`/`completed`, not only when a pick has
  already happened.
- Self-healing twin `markBatchStarted`, called from `confirmQuantity`/`reportDamaged`: a batch swept
  into an *already*-activated picker's queue mid-walk (new order lands while they're still working)
  never gets its own explicit Activate tap — picking any of its tasks is itself proof a human is on
  it, so that's what bumps it to `in_progress` instead. No-op once already past `'assigned'`.
- `/api/admin/batches` GET now filters `WHERE pb.status IN ('in_progress', 'completed')` — a batch
  only shows up here once a human has actually committed to it, not the moment it's auto-created.
  "Once activated can't be deactivated" falls out for free: `assignBatchToPacker` already refused to
  (re)assign/unassign anything past `'assigned'` (pre-existing guard, was just unreachable before
  since nothing ever left `'assigned'`) — nothing in this codebase ever moves status backward out of
  `in_progress`.
- Deliberately left the assign/unassign UI on pick-list.astro as-is even though its `pending`/
  `assigned` branch can no longer render (the fetched list never contains those statuses anymore) —
  removing it wasn't asked for, it's harmless, and pick-assign.astro is the actual dedicated tool for
  routing not-yet-claimed work to a specific packer, so no capability is lost.
- Verified live in local dev: activated 13 real batches for the `packer` test user (confirmed
  `status = 'in_progress'` in D1, 1 already `completed`), reloaded `/picker` — resumed straight to
  "Pick list activated / Start picking" instead of re-showing the gate. Admin's
  `/api/admin/batches` then returned exactly those 14 (`in_progress`/`completed`), zero `pending`/
  `assigned` noise.

**Pick lists grouped by picking session, not by order.** Follow-on to the activation fix above: once
that shipped, the admin Pick Lists dropdown was still showing one row per *order* — because
`reserveOrderForPicking` creates exactly one `pick_batches` row per order — so a picker activating 13
orders in one tap produced 13 separate entries, all created within the same few-second window, for
what was really one trip through the warehouse. Confirmed against real production data (all same
picker, all `in_progress`, timestamps a few seconds apart) before proposing a fix, then asked the
user directly whether they wanted these combined, kept separate-but-organized, or just defaulted to
a shorter list — they chose combining.
- New `pick_batches.activated_at` column (`migrations/0021_pick_batches_activated_at.sql`). Both
  `activateBatches` and the self-healing `markBatchStarted` (see previous entry) now stamp it
  alongside the `status` flip. Batches a picker activates in one tap all get the *exact same*
  `activated_at` — SQLite fixes `datetime('now')` for the whole UPDATE statement, confirmed live (3
  test batches activated together all got `2026-09-20 20:15:06`, to the second).
- Admin's pick-list.astro now groups its fetched batches client-side by `(assigned_picker_id,
  activated_at)` into `Session` objects — one dropdown entry, one barcode, one stepper, one printed/
  downloaded sheet per *session* instead of per order. `orderCount` is just the group's size (no
  extra query needed) since one batch is always exactly one order. A batch with no `activated_at`
  (anything from before this migration, or never re-activated) falls back to grouping on its own id
  — stays its own single-order session rather than every legacy null-timestamp row getting wrongly
  lumped into one giant fake group. Verified: 13 pre-existing legacy batches (no `activated_at`)
  correctly stayed as 13 separate 1-order entries; 3 freshly-activated-together test batches
  correctly collapsed into one 3-order entry with combined SKU/unit totals.
- New `getPickListViewForBatches` (lib/picker.ts) + `/api/picker/pick-list?batchIds=a,b,c` (comma-
  separated, alongside the existing single-`batchId` form) — one query for the whole session's rows
  instead of looping the single-batch query per member.
- The barcode/scan-a-pick-list flow now encodes and looks up the *session's* representative batch id
  (deterministically its earliest member, by `created_at` then `id`) — scanning any printed barcode
  still resolves correctly since `openBatch` now searches every session's `batchIds` for a match, not
  session keys directly.
- Removed the now-fully-unreachable per-order assign/unassign UI from pick-list.astro (a session
  shown here is always `in_progress`/`completed`, and `assignBatchToPacker` already refused to touch
  anything past `'assigned'` even before this — so no capability was actually lost). Deliberately did
  **not** touch `assignBatchToPacker` itself or the `/api/admin/batches` PATCH route — the function is
  still very much alive, called from `assignSkusToPacker` (pick-assign.astro's "Assign by SKU" bulk
  flow), which is the real, still-used tool for routing not-yet-claimed work to a specific packer.

**AWB scanning matched against real data instead of blind FIFO.** User reported the actual real-world
consequence of the nineteenth pass's deliberate FIFO-only design (see that entry above): "whatever
AWB is scanned matches to whatever order is at [the front of the queue] and not to its real order
ID." Investigated whether the system already has any way to know an AWB's *real* order rather than
guessing, before proposing anything — it does: `purchaseLabelForOrder` and
`scheduleEasyShipForOrder`/`scheduleEasyShipBulk` (shipping.ts) already insert the real,
Amazon-assigned tracking id into `awbs` (linked to that exact order's shipment) the moment a label is
purchased/scheduled — well before packing, let alone scanning. `applyAwbByScan` just wasn't using
that as its primary lookup; it went FIFO-first and only checked for a pre-existing package *after*
already committing to the FIFO-selected order, and a blanket `SELECT id FROM awbs WHERE awb_code = ?`
dupe check ahead of that meant scanning a real pre-purchased label's own code for the *first* time
would likely have hit "already scanned for another order" — a probable existing bug, never exercised
because FIFO had already claimed a different order by the time that check ran.
- `applyAwbByScan` now looks the scanned code up in `awbs`/`shipments`/`packages` *first*. If it
  matches a package still `pack_session_id IS NULL` (purchased/scheduled but never yet resolved by a
  scan), it resolves straight to that package's real order — regardless of FIFO position — then
  checks whether *that* order has actually finished packing (an entry in `getPendingLabels`); if not,
  a specific error naming the real order tells the packer to pack it first rather than silently
  matching something else. `pack_session_id IS NOT NULL` means this exact code already went through
  this resolution once — a genuine duplicate, not confused with a fresh pre-purchased label. A code
  with no `awbs` record at all (manual/external courier label, no Amazon-side data to look up) still
  falls back to plain FIFO exactly as before — this doesn't reintroduce the pre-select-and-compare
  verification step the nineteenth pass deliberately removed; it's a lookup against data the system
  already has, not a "does it match what we expected" check.
- Verified live: built a two-order scenario (order-1 older/FIFO-head with no pre-purchased label,
  order-2 newer with a fake pre-registered AWB `TEST-AWB-REAL-001`). Scanning that code resolved to
  order-2 (the real match), not order-1 (the FIFO head) — order-1's `packages` stayed untouched.
  Re-scanning the same code correctly hit `duplicate_awb`. Scanning an unrecognized code
  (`MANUAL-COURIER-CODE-999`) correctly fell back to FIFO and landed on order-1.

**Easy Ship's premature "Shipped" status, missing orders, and same-day-only pick lists.** User
reported a real order (`407-0684687-0239548`) showing "Waiting for pickup" in Seller Central but
absent from the pick list, Pending orders not showing in packer's "Upcoming," and a future-dated
order (`405-8730967-2581100`, Ship by Sun 27 Sep) apparently already active. Investigated each
against the real Amazon account (not guessed) before touching anything, via `wrangler d1 execute
--remote` against production plus temporary debug routes (deleted after) hitting the live SP-API.
Found three separate, real bugs, all connected to Easy Ship:
1. **The root cause**: Amazon flips the coarse `OrderStatus` to `"Shipped"` the instant an Easy Ship
   pickup is *scheduled* — not when the courier actually collects the box. The real, granular signal
   is a separate field, `EasyShipShipmentStatus` (e.g. `"PendingPickUp"`), which this app never read.
   Confirmed directly against both example orders: both showed `OrderStatus: "Shipped"` +
   `EasyShipShipmentStatus: "PendingPickUp"` in the live API response. `syncOrderStatuses`
   (amazon-sync.ts) trusted `OrderStatus` alone, so `407-0684687-0239548` — fully picked in this
   system (`pick_batches`/`pick_tasks` confirmed it), but never packed — got marked `'shipped'` and
   silently pulled out of the active pipeline while the box was still physically sitting in the
   warehouse. New `EASYSHIP_NOT_YET_COLLECTED` set (amazon.ts) of "still with seller" statuses
   (`PendingSchedule`/`PendingPickUp`/`PendingDropOff`) gates the "Shipped" transition now —
   `fetchOrderStatuses`'s return type changed from `Map<string, string>` to
   `Map<string, AmazonOrderStatus>` to carry both fields.
2. **Same bug, import side**: `fetchUnfulfilledOrders` filtered `OrderStatuses=Pending,Unshipped,
   PartiallyShipped` — an order Amazon had already flipped to "Shipped" (even one, like
   `405-8730967-2581100`, scheduled 11+ days before its real ship-by date) never entered this system
   at all. Now also requests `Shipped` and filters client-side with the same
   `EASYSHIP_NOT_YET_COLLECTED` check, so a prematurely-flipped order is pulled in while a genuinely
   completed one still isn't (avoids flooding every sync with the account's entire shipped history).
3. **A real, unrelated bug found along the way**: `fetchUnfulfilledOrders` never paginated —
   `payload.NextToken` was silently discarded, so any lookback window with more than one page's worth
   of matching orders (~100, confirmed live: a 10-day window returned exactly 100 with
   `hasNextToken: true`) permanently lost visibility into everything past page 1. Now loops via
   `NextToken` (capped at 50 pages, matching `fetchAllListings`'s existing cap) — per Amazon's
   documented contract, a page beyond the first sends only `MarketplaceIds` + `NextToken`, not the
   original filters again.
4. **New feature, not a bug**: pick-list assignment scoped to same-IST-calendar-day orders only —
   `reserveOrderForPicking` (orders.ts) now checks a new `isDueForPickingToday(shipBy)` gate before
   reserving stock or creating a `pick_batches` row at all; a future-dated order stays `'pending'`
   with zero pick_tasks (verified live: `405-8730967-2581100` imported cleanly with `pick_tasks: 0`)
   and is naturally picked up once due by the same retry machinery that already re-attempts
   stock-blocked orders (`retryBlockedOrders`, run every 5 minutes by the cron job) — no new scheduler
   needed. Also fixed the column feeding this: `ship_by` was being populated from Amazon's
   `EarliestShipDate` (when shipping is first *allowed*), not `LatestShipDate` (the actual deadline,
   what Seller Central labels "Ship by date" and what the user quoted) — now prefers
   `LatestShipDate`, falling back to `EarliestShipDate` only if Amazon omits it. The new "not due yet"
   result is deliberately silent (`notDueYet: true`, no `reason` string) so it doesn't get lumped into
   `shortOrders`/blocked-order messaging the way a real stock shortage does.
- Corrected the one already-corrupted production order back to `'picked'` (its real state — fully
  picked, never packed) after auditing all 59 orders currently marked `'shipped'` in production
  against live Amazon data: `407-0684687-0239548` was the only false positive: every other order was
  genuinely shipped.

**Pending orders held out of the pick list until Amazon confirms them.** Follow-on the same day:
user reported `404-6655591-3241911`, "Pending" in Seller Central, was already in the pick list
instead of "Upcoming." Checked live against Amazon before changing anything — its `LatestShipDate`
genuinely *is* today (IST), so it correctly passed the same-day gate above; this surfaced a real,
separate policy question the previous same-day fix didn't cover: should a same-day order that Amazon
hasn't confirmed yet (still "Pending" — payment/address/fraud check not done, could still be
cancelled before ever being confirmed) get reserved and picked anyway? An earlier pass had
deliberately decided yes ("Amazon is still the source of truth... reserveOrderForPicking handles a
Pending order the same as any other" — see fetchUnfulfilledOrders's docs). Asked the user directly
rather than silently reversing that earlier decision; they chose to hold it back now.
- New `orders.amazon_order_status` column (`migrations/0022_orders_amazon_status.sql`) — Amazon's own
  OrderStatus, tracked separately from this app's own pipeline `status` column (which starts
  `'pending'` regardless of Amazon's confirmation state). Populated at import (`order.orderStatus`,
  previously fetched but never stored) and kept current by `syncOrderStatuses` on every poll for
  every order checked, not just ones going shipped/cancelled.
- `reserveOrderForPicking` now also refuses to reserve while `amazon_order_status === 'Pending'`,
  regardless of ship-by date — same silent-no-`reason` pattern as `notDueYet` (new `stillPending`
  flag) so it doesn't pollute `shortOrders` blocked-order messaging. Self-resolves through the exact
  same existing machinery as the date gate: `syncOrderStatuses` runs immediately before
  `retryBlockedOrders` in every cron cycle (sync-job.ts), so the moment Amazon confirms an order
  (Pending → Unshipped/PartiallyShipped) it becomes reservable in that same pass.
- Verified live end-to-end in local dev (a real second Pending order wasn't available to test against
  — only one existed, and it was `404-6655591-3241911` itself, already mid-pick in production and
  deliberately left untouched rather than risk disrupting in-progress floor work sight-unseen):
  built a controlled test order with `amazon_order_status = 'Pending'` and today's `ship_by` —
  `reserveOrderForPicking` correctly returned `stillPending: true` with zero pick_tasks; flipping it
  to `'Unshipped'` and re-calling reserved it normally (`batched`, 1 pick_task). Test data removed
  after.
- **Known follow-up, deliberately not done automatically**: `404-6655591-3241911` itself is still
  batched in production from before this fix (pick_batch status `'in_progress'` — a picker may
  already be actively working it). This fix only prevents it from happening to new orders going
  forward; nothing here retroactively un-reserves or pulls back an order already mid-pick, since
  there's no way to know from the data alone whether it's already been physically picked. Flagged to
  the user rather than auto-corrected.

**DEFERRED TO NEXT SESSION — AWB-scan mismatch fix via Amazon's Reports API.** Continuing the item
right above this (`372690986408` scanned to the wrong order via FIFO fallback, root cause:
100% of this account's Easy Ship pickups are scheduled directly on Seller Central, never through
this app, so there's no real AWB→order data anywhere in this system to match against). User chose
"investigate the Reports API" as the direction. Checked Amazon's own role-mapping docs
(`developer-docs.amazon.com/sp-api/docs/report-type-values-order`) directly rather than guess:
- The report that would actually contain tracking/AWB data, `GET_FLAT_FILE_ORDER_REPORT_DATA_SHIPPING`,
  requires the role **"Direct to Consumer Shipping (Restricted)"** — a *restricted* report type,
  meaning it also needs a Restricted Data Token and "passing an additional security review," per
  Amazon's own docs. That role does not appear among the roles already granted to this app in the
  Solution Provider Portal (Freight/Amazon Logistics, Sellers: Finance and Accounting, Selling
  Partner Insights, Buyer Communication, Inventory and Order Tracking ✓, Brand Analytics, Amazon
  Fulfillment, Buyer Solicitation, Product Listing ✓, Amazon Warehousing and Distribution, Shipping:
  Amazon Logistics ✓) — user was mid-authorization-flow when this was found; told them to check
  further down that page for it, and that it may need a separate restricted-data application process
  rather than a simple checkbox, given the extra security review requirement.
- Found one fallback report that *is* already covered by roles this app has (`Product Listing`,
  `Inventory and Order Tracking`): `GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL`. Amazon's
  own docs describe it as general-purpose order tracking that explicitly "does not include
  customer-identifying information," and it's NOT documented as a shipping-specific report — genuinely
  unclear whether it carries a carrier tracking number at all. Untested; worth requesting live (same
  create-report → poll → download pattern used for the restricted one) as a first check next session,
  since it needs no new permission grant.
- **Next session, in this order**: (1) if the fallback report actually contains tracking numbers,
  build on that — no permission blocker. (2) If not, this needs the user (and possibly Amazon's
  review process) to grant "Direct to Consumer Shipping (Restricted)" before any further progress is
  possible on this specific approach. (3) The other two options from the original direction-choice —
  schedule labels through this app instead, or a manual "enter a known tracking number" admin field —
  remain fully available immediately, with no Amazon-side blocker, if the Reports route stalls.

**INCIDENT — D1 free-tier daily row-read quota fully exhausted (not just the 77% flagged earlier
today).** Discovered mid-session when a routine `wrangler d1 execute --remote` lookup failed outright
with "Your account has exceeded D1's free tier daily row read limit... wait until tomorrow (midnight
UTC)" (Cloudflare error code 7500). Confirmed this is a hard per-query block, not a fluke: `SELECT 1`
(0 rows read) succeeds, but any query touching a real table — including a single indexed lookup by
external_order_id — is rejected outright. This affects the *entire* production Worker, not just
CLI/investigation access — since the Worker's own D1 binding hits the same account-wide daily cap,
any real logged-in user's page load or action that needs a genuine data query (which is nearly
everything past the login screen) is almost certainly getting a 500 right now too, not just this
session's own queries. `curl`-testing `/api/auth/me` with no session cookie returned a clean 200
`{"user":null}` — but that's misleading: with no cookie, `getCurrentUser` short-circuits before ever
touching D1, so it says nothing about whether a real logged-in session works right now (it almost
certainly doesn't for anything requiring an actual DB read).
- Checked the time: this happened at 21:11 UTC (~2:41am IST) — reset is at 00:00 UTC, ~2h50m out.
  Likely low real floor traffic at that hour in IST, but not confirmed; flagged to the user
  immediately rather than assumed away. The only way to lift it before reset is a Cloudflare D1 paid
  plan upgrade (Workers & Pages → D1 → the database → plan) — the user's call, not made unilaterally.
- **Likely contributing cause, worth being more disciplined about next session**: this same session
  ran a large number of ad-hoc `wrangler d1 execute --remote` investigation queries throughout the
  day (checking individual order states repeatedly, auditing all 59 `'shipped'` orders against live
  Amazon data, etc.) — each one draws from the exact same daily rows_read budget as the live app.
  Earlier today's indexing/query-rewrite fixes (see the D1 rows_read incident entry above) reduce the
  *rate* of consumption going forward, but couldn't undo a day's cumulative total that had apparently
  already been trending toward the cap before those fixes landed, and this session's own remote
  investigation queries added to that same total on top. Next session: prefer local dev D1 for
  anything that doesn't specifically require real production data, and batch/limit remote lookups
  when production data really is needed.
- **Follow-up still open because of this**: user asked (again) why `404-6655591-3241911` — Pending on
  Seller Central — is still in the pick list. Could not check its current state (fresh
  `amazon_order_status`, pick_batch progress) because production D1 was already exhausted by the time
  this was asked. Last known state (from the entry above, checked before the quota ran out): its
  pick_batch was `'in_progress'`. Re-check this first thing next session once the quota resets (or
  sooner if the user upgrades the plan) — if the batch is still untouched (no tasks actually
  picked), pulling it back to unreserved is safe now that `amazon_order_status` gating exists; if any
  of its tasks have actually been picked, that needs the user's input before undoing anything, same
  reasoning as before.

**Update**: the D1 free-tier quota exhaustion above got resolved the same session — the user
purchased a paid D1/Workers plan, confirmed lifted by re-running the same query that had been
rejected. Re-checked `404-6655591-3241911` immediately after: it had moved to `status: 'packing'`
(picked *and* packing already started) and Amazon's `OrderStatus` is still genuinely `"Pending"`
right now — so a picker and packer both worked it before the new gate existed to stop them, and it's
now too far along to safely pull back automatically (would mean asking someone to unpack a
potentially-already-sealed box). Left untouched, flagged to the user rather than auto-corrected —
same reasoning as before, just confirmed with fresh data instead of stale.

**Eliminated a redundant `/api/auth/me` round trip from every packer/picker/dashboard page load.**
User reported every page felt slow to load. Investigated with live production traffic (`wrangler
tail`) rather than guessing — captured real requests from an actual user on mobile data in Bhopal:
every single one (`claim-batch`, `packer/dashboard`, `admin/orders`, `work-summary`, `sku-demand`,
login) completed in under 100ms server-side, most under 50ms, zero exceptions. So it wasn't the
backend, and specifically wasn't the audit-log writes the user first suspected (`logAudit` is a
single plain INSERT — checked and ruled out). The real cause: every one of
`packer/home.astro`/`packer/index.astro`/`packer/scan.astro`/`picker/index.astro`/`dashboard.astro`
had **zero server-side auth resolution** — unlike every `/admin/*` page (which already uses
`requireAdminPage` in its frontmatter), these relied entirely on the client fetching
`/api/auth/me` *after* the page had already loaded, before it could even start fetching the page's
real data. On a mobile connection (~100ms RTT observed), that's a full extra sequential round trip
stacked in front of every page's actual content, on every single navigation.
- New `toClientUser`/`ClientUser` in lib/auth.ts — the exact shape `/api/auth/me` already returned
  (`id, name, role, warehouseId, stationId`), now shared so the endpoint and every page's own
  frontmatter build it identically. `/api/auth/me` itself refactored to use it (no behavior change,
  just de-duplicated).
- All 5 pages now resolve the user server-side in frontmatter (`getCurrentUser` — same helper
  `requireAdminPage` already uses) and redirect to `/login` immediately if not logged in, with zero
  client-side JS needed for that case at all (verified live: logged out, navigated to
  `/packer/home`, landed on `/login` directly, no flash of the packer shell first). The resolved user
  is handed to the client script via `<script define:vars={{ serverUser }}>window.__serverUser =
  serverUser;</script>` — a pattern new to this codebase, verified live before rolling out to all 5
  (piloted on packer/home.astro first, confirmed `window.__serverUser` populated correctly and zero
  `auth/me` network calls, only then applied the same diff to the other four).
- Each page's own "wrong role" message (e.g. "This account is a 'admin' — the packer dashboard needs
  a packer login") is preserved exactly as before — only the data source changed (`window.__serverUser`
  instead of an awaited fetch), not the branching logic or copy. `dashboard.astro` has no role
  restriction (by design, every role can see it) so its frontmatter only checks login, not role.
  Verified live: all 5 pages render correct content with zero `/api/auth/me` calls
  (`performance.getEntriesByType('resource')` confirmed empty for all of them post-fix), and the
  wrong-role message still renders correctly for an admin session on `/packer/home`.

## Next steps — a prioritized plan

Rewritten 2026-09-20 (twenty-one passes across two days — see "Recently done" entries above for the
full story behind each). What's actually not done yet, ordered by what's blocking vs. not. See
"Open items" below for full detail on each.

1. **Receive stock for the SKUs currently blocking real orders.** Surfaced by the thirteenth
   pass's fetch fix, not caused by it: `DOG-BKM-5`, `GWM-5`, `KTN3`, `U8-9OI6-L4OE`,
   `JC-82IW-CSC1`, and others are all at zero stock with real orders waiting on them. Receive stock
   for each via `/admin/inbound` — every matching blocked order resolves automatically the moment
   its SKU gets stock (no further action needed per order).
2. **Verify the fifteenth/seventeenth-pass floor-UI changes on a real phone.** Both were built and
   verified against dev/API state only — no camera hardware in the sandboxed browser used for
   testing, so scanner speed (75ms poll, restricted formats, higher resolution) was never actually
   timed against a real barcode, and the bigger-photo/aggregate-order-count picker layout was never
   seen on an actual small screen. Neither should be *broken*, but "feels fast enough" and "looks
   right on a phone" are real-device calls, not sandbox ones.
3. **Get the Amazon Easy Ship SP-API role granted — no longer the only shipping path, but still
   worth getting** for anything the manual file-based path (twentieth pass, `/admin/schedule-pickup`)
   doesn't cover as smoothly, e.g. not needing a human round-trip through Seller Central per batch.
   It's on the user, not something to keep investigating from this end — check
   Seller Central's app-authorization page for an "Easy Ship" scope. Once granted, the very first
   thing to do is a live smoke test of `/admin/ship` on one real order, watching closely for: the
   real `labelFileType` Amazon returns, which page of the combined PDF is actually the label
   (currently assumes last), whether the `DocumentReportReferenceID` regex parse in
   `checkEasyShipFeed` matches Amazon's real feed-processing-report format, and — new since the
   seventh pass — whether `createScheduledPackageBulk`'s label ZIP actually splits 1:1 per order
   the way `scheduleEasyShipBulk` assumes (flagged since item 13, still unverified). None of that
   has ever been exercised against a live account. The bulk/single ship pages now have a
   confirmation step before anything fires, so this smoke test won't happen by accident.
4. **Work through the remaining SKU-duplicate merges.** The fifth pass fixed all 34 *exact*-name
   duplicate groups live in one sweep, but `/admin/inventory`'s scanner only catches exact matches
   — near-duplicates (a trailing "(Classic)", a punctuation difference) still need manual review.
   Run "Scan for duplicates" again next session to see what's accumulated since (new orders keep
   auto-creating SKUs for SellerSKU variants never seen before — that's expected, not a bug).
5. **Real box sizes.** Only demo/test boxes existed as of the start of this session — confirm with
   the user whether their actual box dimensions have been entered in `/admin/settings` yet.
6. **Confirm the ship-from address is real**, not a placeholder — check `/admin/settings` before
   the first real label purchase.
7. **Decide the 30-day data-disposal scope** (see open item, below) — this was *committed to
   Amazon in writing* with no enforcement code yet. Needs three scoping answers from the user
   before it can be built safely; the cron infrastructure already exists (`src/worker.ts`) so the
   actual job is easy to add once those answers exist.
8. **Ask-before-building items**: individually-strengthened admin auth (currently same weak PIN
   as floor workers), a public privacy policy URL for ecomglider.com, what should happen when an
   Amazon cancellation lands on an order already fully picked/packed (currently just an exception
   event for manual putback), whether the Amazon catalog sync should become automatic (periodic
   cron) rather than a manual button, and the broader HTML-escaping audit flagged as Open item #16
   (the notes feature is covered; older fields like `first_item_name`'s title attribute aren't).
   None of these are urgent; don't build them unprompted.
9. **Minor cleanup, low priority**: `src/pages/api/picker/scan-item.ts` (and `verifyItemScan` in
   `picker.ts`) is dead code from before the picker dropped mandatory scanning — nothing calls it.
   `Warehouse` type in `types.ts` is missing the `ship_from_*` columns (cosmetic, nothing breaks).
   No throttling between per-order `GetOrderItems` calls in `fetchUnfulfilledOrders` (see the
   thirteenth pass) — fine at current volume, revisit if SP-API rate-limit errors become frequent.
10. **If the user says the UI looks off somewhere**, the fix pattern is established (see "Design
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
Packing: `pack_sessions → packages → shipments → awbs`, plus `awb_scans` (migration `0013`) — a
separate, permanent append-only scan log (order/shipment references nulled on reset, never the
row itself), independent of `awbs`. `schedule_pickup_batches` (migration `0014`) groups the
`shipments` rows the manual Schedule Pickup file path (twentieth pass) creates before a real label
exists — `shipments.invoice_id`/`schedule_batch_id`/`manual_schedule_status` support that path
without touching `shipments.status`'s existing enum. Inbound: `inbound_receipts → inbound_receipt_lines`
(increments `inventory.quantity_on_hand` directly — the counterpart to `reserveInventory`, which
only ever takes stock out).

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
11a. **Reports API role not granted — blocks investigating a real fix for AWB-scan mismatches.**
    User reported a real incident: scanning a physical AWB (`372690986408`) matched it to the wrong
    order via the FIFO fallback in `applyAwbByScan` (packer.ts). Investigated why: checked production
    and found `carrier` is `NULL` on every shipment record that exists — meaning 100% of this
    account's Easy Ship pickups are scheduled directly on Seller Central, never through this app's
    own `scheduleEasyShipForOrder`/`purchaseLabelForOrder` (which DO correctly capture the real
    AWB→order link, see the earlier "AWB scanning matched against real data" pass) — so that fix has
    nothing to match against for this account's actual workflow, and always falls through to FIFO.
    Asked the user which direction to take; they chose investigating whether Amazon's Reports API can
    supply a bulk order→tracking mapping automatically, so scheduling doesn't have to move into this
    app. Found a strong candidate (`GET_FLAT_FILE_ORDER_REPORT_DATA_SHIPPING`, Amazon's documented
    "Order Tracking Report") and tried requesting it live (`POST /reports/2021-06-30/reports`) rather
    than assume it contains the right columns — got `403 Unauthorized`, the same class of blocker
    Easy Ship and Listings Items each hit before their SP-API roles were granted (see item 1 above
    and item 13 below). **Blocked on the seller granting this SP-API app the Reports role in Seller
    Central** (Manage Apps → this app's authorization) — cannot verify the report's actual content,
    let alone build anything on it, until that's granted. Revisit by re-running the same
    create-report → poll → download flow once granted; if the report does contain a usable
    order/tracking mapping, the next step is a scheduled pull (mirroring the existing cron pattern)
    that pre-registers each mapping into `awbs` before packing, giving `applyAwbByScan` real data to
    match against instead of FIFO — same mechanism the purchase-time insert already provides, just
    sourced from this report instead of a purchase response.
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
