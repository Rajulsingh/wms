-- Amazon's compliance questionnaire flagged that the two shared role logins
-- (admin/packer) don't "individually identify employees" if more than one
-- person uses either PIN (see HANDOFF.md open item 10). The users table
-- already supports any number of rows per role — nothing here changes the
-- login/session model, it just makes `name` a real identifier instead of a
-- label two people could type the same value into. A plain index, not a
-- table rebuild: `name` isn't referenced by any FK, so no detach/reattach
-- dance like 0003 needed.
CREATE UNIQUE INDEX idx_users_name_unique ON users (name);
