-- How many returns today's OTP is good for, entered by the admin alongside
-- the OTP itself (also read off Seller Central by hand — see
-- return_otps in migration 0030). Purely informational for the packer
-- handing returns to the courier; nothing in code enforces it.
ALTER TABLE return_otps ADD COLUMN valid_for_count INTEGER;
