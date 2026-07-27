-- Allow the first-period-after-lunch teacher to mark afternoon attendance.
--
-- Twice-daily attendance (20260707) authorized afternoon teachers in the API,
-- but validate_attendance_entry() still only allowed Class Teacher / Period 1 /
-- Admin. Afternoon session submits then failed at the DB trigger with:
--   Unauthorized: Only the assigned Class Teacher, Period 1 Teacher, or Admin...

CREATE OR REPLACE FUNCTION validate_attendance_entry()
RETURNS TRIGGER
SET search_path = public
AS $$
DECLARE
    v_class_section_id UUID;
    v_class_teacher_id UUID;
    v_school_id INTEGER;
    v_is_admin BOOLEAN;
    v_is_class_teacher BOOLEAN;
    v_is_p1_teacher BOOLEAN;
    v_is_afternoon_teacher BOOLEAN;
    v_lunch_sort INTEGER;
    v_afternoon_period INTEGER;
    v_marker_person_id UUID;
BEGIN
    -- 1. Basic Date Validation (must be within enrollment period)
    IF NOT EXISTS (
        SELECT 1 FROM student_enrollments
        WHERE id = NEW.student_enrollment_id
          AND status = 'active'
          AND NEW.attendance_date BETWEEN start_date AND COALESCE(end_date, '9999-12-31'::date)
          AND deleted_at IS NULL
    ) THEN
        RAISE EXCEPTION 'Invalid Attendance: Student is not active in this enrollment on %', NEW.attendance_date;
    END IF;

    -- 2. Authorization Check (marked_by must be Class Teacher, Admin,
    --    Period 1 Teacher, or first-period-after-lunch Teacher)
    IF NEW.marked_by IS NOT NULL THEN
        SELECT se.class_section_id, cs.class_teacher_id, cs.school_id
          INTO v_class_section_id, v_class_teacher_id, v_school_id
        FROM student_enrollments se
        JOIN class_sections cs ON se.class_section_id = cs.id
        WHERE se.id = NEW.student_enrollment_id;

        SELECT person_id INTO v_marker_person_id
        FROM users WHERE id = NEW.marked_by;

        SELECT EXISTS (
            SELECT 1 FROM user_roles ur
            JOIN roles r ON ur.role_id = r.id
            WHERE ur.user_id = NEW.marked_by AND r.code = 'admin'
        ) INTO v_is_admin;

        IF NOT v_is_admin THEN
            SELECT EXISTS (
                SELECT 1 FROM staff s
                WHERE s.id = v_class_teacher_id
                  AND s.person_id = v_marker_person_id
            ) INTO v_is_class_teacher;

            SELECT EXISTS (
                SELECT 1 FROM timetable_slots ts
                JOIN staff s ON ts.teacher_id = s.id
                WHERE ts.class_section_id = v_class_section_id
                  AND ts.period_number = 1
                  AND s.person_id = v_marker_person_id
                  AND ts.deleted_at IS NULL
            ) INTO v_is_p1_teacher;

            -- First teaching period after lunch (period_number = periods.sort_order)
            SELECT COALESCE(
                (SELECT sort_order FROM periods
                  WHERE school_id = v_school_id AND name ILIKE '%lunch%'
                  ORDER BY sort_order DESC LIMIT 1),
                (SELECT sort_order FROM periods
                  WHERE school_id = v_school_id AND is_break = true
                  ORDER BY (end_time - start_time) DESC, start_time LIMIT 1),
                (SELECT MIN(sort_order) - 1 FROM periods
                  WHERE school_id = v_school_id
                    AND COALESCE(is_break, false) = false
                    AND start_time >= TIME '13:00')
            ) INTO v_lunch_sort;

            SELECT p.sort_order INTO v_afternoon_period
            FROM periods p
            WHERE p.school_id = v_school_id
              AND COALESCE(p.is_break, false) = false
              AND (v_lunch_sort IS NULL OR p.sort_order > v_lunch_sort)
            ORDER BY p.sort_order
            LIMIT 1;

            SELECT EXISTS (
                SELECT 1 FROM timetable_slots ts
                JOIN staff s ON ts.teacher_id = s.id
                WHERE ts.class_section_id = v_class_section_id
                  AND v_afternoon_period IS NOT NULL
                  AND ts.period_number = v_afternoon_period
                  AND s.person_id = v_marker_person_id
                  AND ts.deleted_at IS NULL
            ) INTO v_is_afternoon_teacher;

            IF NOT (v_is_class_teacher OR v_is_p1_teacher OR v_is_afternoon_teacher) THEN
                RAISE EXCEPTION 'Unauthorized: Only the assigned Class Teacher, Period 1 Teacher, first period after lunch Teacher, or Admin can mark attendance';
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
