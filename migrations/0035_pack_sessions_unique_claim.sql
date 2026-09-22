-- Prevents the exact race behind a real bug: claimNextPackBatch (lib/packer.ts)
-- checked "is this pick_batch_id unclaimed" and then inserted one
-- pack_sessions row per order with no lock in between. Two nearly-
-- simultaneous calls (the packer page's SSR load and its 8s client poll,
-- or two open tabs/devices) could both pass the check before either insert
-- landed, each creating a full second (or third) set of pack_sessions for
-- the same batch. The packer page then showed the same order twice, one
-- copy tracking packed quantity the other didn't know about — exactly how
-- a box got mispacked. Confirmed live: 4 orders on production each had
-- 2-3 duplicate in_progress pack_sessions, all created in the same second
-- by the same packer's page. None had reached a package/shipment yet, so
-- the cleanup below is a plain dedupe, not a data-loss risk.
--
-- A pick_batch_id is never legitimately claimed twice (nothing in the code
-- sets pack_sessions.status = 'cancelled' to make room for a re-claim), so
-- the unique index is a hard constraint, not just a slow-down. NULL
-- pick_batch_id (the old one-order-at-a-time flow) is excluded so those
-- rows are unaffected.
DELETE FROM pack_sessions
WHERE pick_batch_id IS NOT NULL
  AND id NOT IN (
    SELECT MIN(id) FROM pack_sessions WHERE pick_batch_id IS NOT NULL GROUP BY pick_batch_id, order_id
  );

CREATE UNIQUE INDEX idx_pack_sessions_unique_batch_order ON pack_sessions (pick_batch_id, order_id) WHERE pick_batch_id IS NOT NULL;
