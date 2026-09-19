-- Packing becomes batch-scoped instead of one-order-at-a-time. A pack
-- session still covers exactly one order — packages/shipments/awbs all
-- stay order-scoped, unchanged, since each order still needs its own box
-- and its own label regardless of how packing is grouped — but multiple
-- sessions opened together for the same pick_batch let a packer work
-- through every order in that batch (SKU-grouped, same pattern as picking)
-- before any label goes on, instead of being forced through one order at a
-- time with a label applied immediately after each. See HANDOFF.md.
ALTER TABLE pack_sessions ADD COLUMN pick_batch_id TEXT REFERENCES pick_batches(id);
