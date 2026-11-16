BEGIN;

CREATE TABLE IF NOT EXISTS attendance_calendar_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id integer NOT NULL REFERENCES schools(id),
  effective_from date NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  working_weekdays integer[] NOT NULL DEFAULT ARRAY[1,2,3,4,5,6],
  half_day_weight numeric NOT NULL DEFAULT 0.5 CHECK (half_day_weight BETWEEN 0 AND 1),
  submission_cutoff time, show_teacher_name boolean NOT NULL DEFAULT false,
  notify_exams boolean NOT NULL DEFAULT true, notify_holidays boolean NOT NULL DEFAULT true,
  quiet_start time, quiet_end time,
  created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(school_id, effective_from),
  CHECK (working_weekdays <@ ARRAY[0,1,2,3,4,5,6]),
  CHECK ((quiet_start IS NULL AND quiet_end IS NULL) OR (quiet_start IS NOT NULL AND quiet_end IS NOT NULL AND quiet_start <> quiet_end))
);
CREATE TABLE IF NOT EXISTS attendance_report_finalizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id integer NOT NULL REFERENCES schools(id),
  student_id uuid NOT NULL REFERENCES students(id), academic_year_id uuid NOT NULL REFERENCES academic_years(id),
  from_date date NOT NULL, to_date date NOT NULL CHECK (to_date >= from_date),
  status text NOT NULL CHECK (status IN ('FINALIZED', 'REOPENED')),
  snapshot_hash text NOT NULL, finalized_by uuid REFERENCES users(id), finalized_at timestamptz NOT NULL DEFAULT now(),
  reopened_at timestamptz, reason text NOT NULL,
  UNIQUE(school_id, student_id, academic_year_id, from_date, to_date)
);
ALTER TABLE attendance_calendar_policies ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_attendance_finalization_range ON attendance_report_finalizations(school_id, student_id, from_date, to_date) WHERE status = 'FINALIZED';
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS override_event_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS override_reason text;
ALTER TABLE daily_attendance ADD COLUMN IF NOT EXISTS correction_reason text;
CREATE TABLE IF NOT EXISTS attendance_calendar_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id integer NOT NULL REFERENCES schools(id),
  event_id uuid NOT NULL REFERENCES calendar_events(id), kind text NOT NULL,
  payload jsonb NOT NULL, idempotency_key text NOT NULL, due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','SKIPPED','FAILED')),
  attempts integer NOT NULL DEFAULT 0, failure_reason text, sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(school_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_attendance_calendar_alerts_due ON attendance_calendar_alerts(due_at) WHERE status = 'PENDING';
ALTER TABLE attendance_calendar_alerts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON attendance_calendar_alerts FROM anon, authenticated;
GRANT ALL ON attendance_calendar_alerts TO service_role;

-- Auditing is independent of client version; session rollup functions remain unchanged.
CREATE OR REPLACE FUNCTION audit_student_attendance_calendar() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  before_row jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) ELSE NULL END;
  after_row jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) ELSE NULL END;
  changed jsonb := COALESCE(after_row, before_row);
  tenant integer := (changed->>'school_id')::integer;
  actor uuid;
  pupil uuid;
  changed_date date;
BEGIN
  IF TG_OP = 'UPDATE' AND (before_row - 'updated_at' - 'marked_at') = (after_row - 'updated_at' - 'marked_at') THEN RETURN NEW; END IF;
  actor := COALESCE(NULLIF(current_setting('app.attendance_actor', true), '')::uuid,
    (changed->>'marked_by')::uuid, (changed->>'created_by')::uuid, (changed->>'finalized_by')::uuid);
  INSERT INTO audit_logs(school_id, user_id, action, entity, entity_id, details)
  VALUES(tenant, actor, TG_OP, TG_TABLE_NAME, changed->>'id', jsonb_build_object('old', before_row, 'new', after_row,
    'reason', COALESCE(NULLIF(current_setting('app.attendance_reason', true), ''), changed->>'correction_reason', changed->>'override_reason', changed->>'reason')));

  IF TG_TABLE_NAME = 'daily_attendance' THEN
    SELECT student_id INTO pupil FROM student_enrollments WHERE id = (changed->>'student_enrollment_id')::uuid AND school_id = tenant;
    changed_date := (changed->>'attendance_date')::date;
    UPDATE attendance_report_finalizations SET status = 'REOPENED', reopened_at = now(), reason = 'Attendance changed; school review required'
      WHERE school_id = tenant AND student_id = pupil AND status = 'FINALIZED' AND changed_date BETWEEN from_date AND to_date;
  ELSIF TG_TABLE_NAME IN ('student_enrollments', 'students') THEN
    UPDATE attendance_report_finalizations SET status = 'REOPENED', reopened_at = now(), reason = 'Enrollment changed; school review required'
      WHERE school_id = tenant AND student_id = COALESCE((changed->>'student_id')::uuid, (changed->>'id')::uuid) AND status = 'FINALIZED';
  ELSIF TG_TABLE_NAME <> 'attendance_report_finalizations' THEN
    -- School calendar/policy/target changes can affect historical applicability.
    -- Reopen conservatively; never silently retain a stale finalized result.
    UPDATE attendance_report_finalizations SET status = 'REOPENED', reopened_at = now(), reason = 'Calendar or policy changed; school review required'
      WHERE school_id = tenant AND status = 'FINALIZED';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['daily_attendance','calendar_events','calendar_event_targets','attendance_calendar_policies','attendance_report_finalizations','student_enrollments','students','exams','exam_subjects','events','event_audience_targets'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS attendance_calendar_audit ON %I', t);
    EXECUTE format('CREATE TRIGGER attendance_calendar_audit AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_student_attendance_calendar()', t);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION lock_student_attendance_calendar() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE tenant integer := CASE WHEN TG_OP = 'DELETE' THEN OLD.school_id ELSE NEW.school_id END;
BEGIN
  -- All source writes share the finalizer's lock, including legacy teacher writes.
  PERFORM pg_advisory_xact_lock(61117, tenant);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['daily_attendance','calendar_events','calendar_event_targets','attendance_calendar_policies','student_enrollments','students','exams','exam_subjects','events','event_audience_targets'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS attendance_calendar_write_lock ON %I', t);
    EXECUTE format('CREATE TRIGGER attendance_calendar_write_lock BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION lock_student_attendance_calendar()', t);
  END LOOP;
END $$;

ALTER TABLE attendance_calendar_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_report_finalizations ENABLE ROW LEVEL SECURITY;
-- Parent-facing access is exclusively through the authorized API, never direct table access.
REVOKE ALL ON attendance_calendar_policies, attendance_report_finalizations FROM anon, authenticated;
GRANT ALL ON attendance_calendar_policies, attendance_report_finalizations TO service_role;
-- Rollout is opt-in through the admin policy screen. No school is enabled by migration.
COMMIT;
