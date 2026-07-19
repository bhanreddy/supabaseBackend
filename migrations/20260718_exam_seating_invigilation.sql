-- Exam seating & invigilation layer.
-- A "sitting" is one exam on one date at one session time. Students of every
-- class that has a paper in that sitting are seated into rooms; each room in a
-- sitting gets one invigilator. Additive / forward-only; safe to re-run.

-- Reusable per-school room registry (exam halls / classrooms used for exams).
CREATE TABLE IF NOT EXISTS exam_rooms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    capacity INTEGER NOT NULL DEFAULT 30,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT chk_exam_room_capacity CHECK (capacity > 0)
);

CREATE INDEX IF NOT EXISTS idx_exam_rooms_school ON exam_rooms(school_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_exam_rooms_name_active
  ON exam_rooms(school_id, name) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_exam_rooms_updated ON exam_rooms;
CREATE TRIGGER trg_exam_rooms_updated
BEFORE UPDATE ON exam_rooms
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

-- One room used in one sitting, with its invigilator.
CREATE TABLE IF NOT EXISTS exam_room_allocations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    exam_id UUID NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    exam_date DATE NOT NULL,
    -- Session start; '00:00' stands in for untimed sittings so the unique
    -- index below stays simple.
    session_start TIME NOT NULL DEFAULT '00:00',
    room_id UUID NOT NULL REFERENCES exam_rooms(id),
    invigilator_staff_id UUID REFERENCES staff(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_exam_room_alloc_exam
  ON exam_room_allocations(exam_id, exam_date, session_start) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_exam_room_alloc_unique
  ON exam_room_allocations(exam_id, exam_date, session_start, room_id) WHERE deleted_at IS NULL;
-- An invigilator cannot be in two rooms of the same sitting.
CREATE UNIQUE INDEX IF NOT EXISTS idx_exam_room_alloc_invig_unique
  ON exam_room_allocations(exam_id, exam_date, session_start, invigilator_staff_id)
  WHERE deleted_at IS NULL AND invigilator_staff_id IS NOT NULL;
-- Serves the staff "my duties" read.
CREATE INDEX IF NOT EXISTS idx_exam_room_alloc_invig
  ON exam_room_allocations(invigilator_staff_id) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_exam_room_alloc_updated ON exam_room_allocations;
CREATE TRIGGER trg_exam_room_alloc_updated
BEFORE UPDATE ON exam_room_allocations
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

-- A student's seat in one sitting. Sitting keys are denormalized so the DB can
-- guarantee one seat per student per sitting.
CREATE TABLE IF NOT EXISTS exam_seat_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    room_allocation_id UUID NOT NULL REFERENCES exam_room_allocations(id) ON DELETE CASCADE,
    exam_id UUID NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    exam_date DATE NOT NULL,
    session_start TIME NOT NULL DEFAULT '00:00',
    student_enrollment_id UUID NOT NULL REFERENCES student_enrollments(id) ON DELETE CASCADE,
    class_id UUID NOT NULL REFERENCES classes(id),
    seat_no INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_exam_seats_room ON exam_seat_assignments(room_allocation_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_exam_seats_enrollment ON exam_seat_assignments(student_enrollment_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_exam_seats_one_per_sitting
  ON exam_seat_assignments(exam_id, exam_date, session_start, student_enrollment_id)
  WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_exam_seats_updated ON exam_seat_assignments;
CREATE TRIGGER trg_exam_seats_updated
BEFORE UPDATE ON exam_seat_assignments
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

-- Remember the last allocation wizard inputs for pre-fill on regenerate.
ALTER TABLE exams ADD COLUMN IF NOT EXISTS allocation_params JSONB;
