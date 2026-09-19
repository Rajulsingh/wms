-- Each packer's station is now a fixed property of their account, assigned
-- once by admin, not something they tap/scan into every time they move from
-- Pick to Pack. station_id stays on pack_sessions too (unchanged) purely
-- for reports/reference — this column is what start-session now reads
-- instead of a scanned qr_token.
ALTER TABLE users ADD COLUMN station_id TEXT REFERENCES packing_stations(id);
