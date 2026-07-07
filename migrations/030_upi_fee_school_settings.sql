-- ============================================================
-- UPI fee collection — school-scoped settings (key/value)
-- ============================================================
-- Uses existing `school_settings` (school_id, key, value, …).
-- Application keys:
--   upi_id            — VPA, e.g. school@okaxis
--   upi_display_name  — payee name shown in UPI apps / QR (pn)
--
-- No new table or columns required. Optional: pre-seed empty rows per school
-- (usually skipped — keys appear on first save via API).
--
-- Example manual insert for school_id = 1 (adjust id as needed):
--
-- INSERT INTO school_settings (school_id, key, value, updated_at)
-- VALUES
--   (1, 'upi_id', '', now()),
--   (1, 'upi_display_name', '', now())
-- ON CONFLICT (school_id, key) DO NOTHING;

COMMENT ON TABLE school_settings IS
  'Per-school key/value config. UPI: keys upi_id, upi_display_name for fee QR.';
