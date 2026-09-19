-- Per-order notes/special-instructions field — today the only place to record
-- "free gift included" or "multi-qty, double-check count" is the admin's
-- handwritten paper pick list. Admin edits it on /admin; surfaced to floor
-- workers on both /picker and /packer next to that order's line.
ALTER TABLE orders ADD COLUMN notes TEXT;
