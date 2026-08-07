-- 20260806_notice_multi_audience.sql
-- Allow notices to target multiple audiences (students + staff, etc.).
-- Keeps legacy `audience` column in sync for older readers.
-- Idempotent: safe to re-run.

ALTER TABLE notices
  ADD COLUMN IF NOT EXISTS audiences notice_audience_enum[];

UPDATE notices
SET audiences = ARRAY[audience]
WHERE audiences IS NULL;

ALTER TABLE notices
  ALTER COLUMN audiences SET DEFAULT ARRAY['all']::notice_audience_enum[];

ALTER TABLE notices
  ALTER COLUMN audiences SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_notices_audiences ON notices USING GIN (audiences);

-- RLS: allow view when any selected audience matches the viewer's role
DROP POLICY IF EXISTS "View Notices" ON notices;
CREATE POLICY "View Notices" ON notices FOR SELECT
USING (
  (auth.role() = 'service_role') OR (
    notices.school_id = auth_school_id() AND (
      (created_by = auth.uid()) OR
      ((audience = 'all' OR 'all' = ANY(audiences)) AND auth.role() = 'authenticated') OR
      ((audience = 'staff' OR 'staff' = ANY(audiences)) AND auth_has_role(ARRAY['admin', 'teacher', 'staff', 'accounts'])) OR
      ((audience = 'students' OR 'students' = ANY(audiences)) AND auth_has_role(ARRAY['admin', 'student'])) OR
      ((audience = 'parents' OR 'parents' = ANY(audiences)) AND auth_has_role(ARRAY['admin', 'parent'])) OR
      ((audience = 'class' OR 'class' = ANY(audiences)) AND target_class_id IS NOT NULL)
    )
  )
);
