-- A physical cart is reused across many batches (emptied between runs), so
-- slot numbers legitimately repeat batch to batch — the original
-- UNIQUE(cart_id, slot_number) wrongly treated a slot as belonging to the
-- cart for all time, which collided the moment a second batch reused the
-- same cart. A slot belongs to one cart *within one batch*.
--
-- pick_tasks.cart_slot_id references this table, and D1 runs a migration
-- file as one transaction (PRAGMA foreign_keys can't be toggled mid-
-- transaction), so DROP TABLE cart_slots fails while any pick_tasks row
-- still points into it. Work around it: detach those references first,
-- rebuild under the same row ids, then reattach.

CREATE TABLE cart_slots_new (
  id TEXT PRIMARY KEY,
  cart_id TEXT NOT NULL REFERENCES carts(id),
  pick_batch_id TEXT REFERENCES pick_batches(id),
  slot_number INTEGER NOT NULL,
  order_id TEXT REFERENCES orders(id),
  UNIQUE (cart_id, pick_batch_id, slot_number)
);

INSERT INTO cart_slots_new (id, cart_id, slot_number, order_id)
SELECT id, cart_id, slot_number, order_id FROM cart_slots;

CREATE TABLE _pick_tasks_cart_slot_backup (id TEXT PRIMARY KEY, cart_slot_id TEXT);

INSERT INTO _pick_tasks_cart_slot_backup (id, cart_slot_id)
  SELECT id, cart_slot_id FROM pick_tasks WHERE cart_slot_id IS NOT NULL;

UPDATE pick_tasks SET cart_slot_id = NULL WHERE cart_slot_id IS NOT NULL;

DROP TABLE cart_slots;
ALTER TABLE cart_slots_new RENAME TO cart_slots;

UPDATE pick_tasks
SET cart_slot_id = (SELECT cart_slot_id FROM _pick_tasks_cart_slot_backup WHERE _pick_tasks_cart_slot_backup.id = pick_tasks.id)
WHERE id IN (SELECT id FROM _pick_tasks_cart_slot_backup);

DROP TABLE _pick_tasks_cart_slot_backup;
