-- Payroll manual salary adjustments and admin block for accounts distribution

ALTER TABLE staff_payroll
  ADD COLUMN IF NOT EXISTS salary_adjustment DECIMAL(12,2) NOT NULL DEFAULT 0;

ALTER TABLE schools
  ADD COLUMN IF NOT EXISTS payroll_distribution_blocked BOOLEAN NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION recalculate_staff_payroll(
    p_staff_id UUID,
    p_month INTEGER,
    p_year INTEGER
)
RETURNS VOID
SET search_path = public
AS $$
DECLARE
    v_base_salary DECIMAL(12,2);
    v_per_day_salary DECIMAL(12,2);
    v_total_deduction_days INTEGER := 0;
    v_deduction_amount DECIMAL(12,2);
    v_start_date DATE;
    v_end_date DATE;
    v_bonus DECIMAL(12,2) := 0;
    v_adjustment DECIMAL(12,2) := 0;
BEGIN
    SELECT salary INTO v_base_salary FROM staff WHERE id = p_staff_id;
    IF v_base_salary IS NULL THEN v_base_salary := 0; END IF;
    v_per_day_salary := v_base_salary / 30.0;
    v_start_date := make_date(p_year, p_month, 1);
    v_end_date := (v_start_date + interval '1 month' - interval '1 day')::DATE;

    WITH deductible_dates AS (
        SELECT attendance_date AS d_date
        FROM staff_attendance
        WHERE staff_id = p_staff_id
          AND attendance_date BETWEEN v_start_date AND v_end_date
          AND status = 'absent'
          AND deleted_at IS NULL
        UNION
        SELECT generate_series(
            GREATEST(start_date, v_start_date),
            LEAST(end_date, v_end_date),
            interval '1 day'
        )::DATE AS d_date
        FROM leave_applications
        WHERE applicant_id = (SELECT id FROM users WHERE person_id = (SELECT person_id FROM staff WHERE id = p_staff_id))
          AND status = 'rejected'
          AND leave_type != 'unpaid'
          AND end_date >= v_start_date
          AND start_date <= v_end_date
    )
    SELECT COUNT(DISTINCT d_date) INTO v_total_deduction_days FROM deductible_dates;

    v_deduction_amount := v_total_deduction_days * v_per_day_salary;

    SELECT COALESCE(sp.bonus, 0), COALESCE(sp.salary_adjustment, 0)
      INTO v_bonus, v_adjustment
    FROM staff_payroll sp
    WHERE sp.school_id = (SELECT school_id FROM staff WHERE id = p_staff_id)
      AND sp.staff_id = p_staff_id
      AND sp.payroll_month = p_month
      AND sp.payroll_year = p_year;

    UPDATE staff_payroll sp
    SET base_salary = v_base_salary,
        deductions = v_deduction_amount,
        net_salary = GREATEST(0, v_base_salary + v_bonus + v_adjustment - v_deduction_amount),
        updated_at = now()
    WHERE sp.school_id = (SELECT school_id FROM staff WHERE id = p_staff_id)
      AND sp.staff_id = p_staff_id
      AND sp.payroll_month = p_month
      AND sp.payroll_year = p_year;

    IF NOT FOUND THEN
      INSERT INTO staff_payroll (
        school_id, staff_id, payroll_month, payroll_year,
        base_salary, bonus, salary_adjustment, deductions, net_salary, status
      )
      VALUES (
        (SELECT school_id FROM staff WHERE id = p_staff_id),
        p_staff_id, p_month, p_year,
        v_base_salary, 0, 0, v_deduction_amount,
        GREATEST(0, v_base_salary - v_deduction_amount),
        'pending'
      );
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
