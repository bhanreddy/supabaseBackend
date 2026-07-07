-- Allow the period structure to be defined by sort_order, not by unique names.
-- Multiple breaks may legitimately share the same display name.
ALTER TABLE periods DROP CONSTRAINT IF EXISTS periods_name_key;
