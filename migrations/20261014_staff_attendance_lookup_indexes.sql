BEGIN;

-- Challenge replacement/revocation only touches outstanding requests, not the
-- complete history accumulated by every staff member at every school.
CREATE INDEX IF NOT EXISTS idx_attendance_challenges_open_staff
ON attendance_challenges(school_id, staff_id) WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_attendance_challenges_open_registration
ON attendance_challenges(registration_id) WHERE consumed_at IS NULL;

-- Used by both mobile attendance cards on every authoritative status refresh.
CREATE INDEX IF NOT EXISTS idx_staff_att_exceptions_today
ON staff_attendance_exceptions(school_id, staff_id, attendance_date, created_at DESC);

COMMIT;
