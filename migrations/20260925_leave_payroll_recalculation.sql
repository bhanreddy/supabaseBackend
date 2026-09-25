-- Make the legacy payroll list respect the salary treatment recorded by the
-- redesigned leave approval flow. teacher-salary-v1 remains authoritative for
-- calculated payslips; this function keeps existing legacy draft rows correct.

CREATE OR REPLACE FUNCTION recalculate_staff_payroll(
    p_staff_id UUID,
    p_month INTEGER,
    p_year INTEGER
)
RETURNS VOID
SET search_path = public
AS $$
DECLARE
    v_school_id INTEGER;
    v_base_salary DECIMAL(12,2);
    v_per_day_salary DECIMAL(12,2);
    v_total_deduction_days INTEGER := 0;
    v_deduction_amount DECIMAL(12,2);
    v_start_date DATE;
    v_end_date DATE;
    v_bonus DECIMAL(12,2) := 0;
    v_adjustment DECIMAL(12,2) := 0;
    v_engine TEXT;
    v_workflow TEXT;
    v_status TEXT;
    v_payroll_id UUID;
    v_cl_entitlement INTEGER := 1;
BEGIN
    SELECT school_id, salary INTO v_school_id, v_base_salary
    FROM staff
    WHERE id = p_staff_id AND deleted_at IS NULL;
    IF v_school_id IS NULL THEN RETURN; END IF;
    IF v_base_salary IS NULL THEN v_base_salary := 0; END IF;

    SELECT sp.id, sp.calculation_engine, sp.workflow_status, sp.status::text
      INTO v_payroll_id, v_engine, v_workflow, v_status
    FROM staff_payroll sp
    WHERE sp.school_id = v_school_id
      AND sp.staff_id = p_staff_id
      AND sp.payroll_month = p_month
      AND sp.payroll_year = p_year
      AND sp.run_kind = 'ORIGINAL'
      AND sp.run_sequence = 0;

    IF v_engine = 'teacher-salary-v1' THEN
      IF v_workflow IN ('DRAFT', 'VALIDATED') THEN
        UPDATE staff_payroll
        SET requires_review = true,
            workflow_status = 'DRAFT',
            review_reason = 'Attendance or leave changed after this draft was calculated. Recalculate before approval.',
            validated_by = NULL,
            validated_at = NULL,
            updated_at = now()
        WHERE id = v_payroll_id;
      END IF;
      RETURN;
    END IF;

    IF v_status = 'paid' OR v_workflow IN ('APPROVED', 'LOCKED', 'PAID') THEN
      RETURN;
    END IF;

    v_per_day_salary := v_base_salary / 30.0;
    v_start_date := make_date(p_year, p_month, 1);
    v_end_date := (v_start_date + interval '1 month' - interval '1 day')::DATE;

    SELECT GREATEST(0, FLOOR(COALESCE((config->>'monthlyClEntitlementDays')::numeric, 1)))::integer
      INTO v_cl_entitlement
    FROM school_payroll_policies
    WHERE school_id = v_school_id
      AND effective_from <= v_end_date
      AND (effective_to IS NULL OR effective_to >= v_start_date)
    ORDER BY effective_from DESC
    LIMIT 1;
    v_cl_entitlement := COALESCE(v_cl_entitlement, 1);

    WITH leave_dates AS (
      SELECT DISTINCT
        generated.day::date AS d_date,
        COALESCE(
          la.payroll_treatment,
          CASE
            WHEN la.leave_type = 'casual' THEN 'PAID_CL'
            WHEN la.leave_type IN ('sick', 'earned', 'maternity', 'paternity') THEN 'PAID_LEAVE'
            ELSE 'UNPAID'
          END
        ) AS treatment
      FROM leave_applications la
      CROSS JOIN LATERAL generate_series(
        GREATEST(la.start_date, v_start_date),
        LEAST(la.end_date, v_end_date),
        interval '1 day'
      ) AS generated(day)
      WHERE la.school_id = v_school_id
        AND la.applicant_id IN (
          SELECT u.id
          FROM users u
          JOIN staff s ON s.person_id = u.person_id AND s.school_id = u.school_id
          WHERE s.id = p_staff_id AND u.school_id = v_school_id AND u.deleted_at IS NULL
        )
        AND la.status = 'approved'
        AND la.end_date >= v_start_date
        AND la.start_date <= v_end_date
    ), ranked_leave_dates AS (
      SELECT d_date, treatment,
             CASE WHEN treatment = 'PAID_CL'
               THEN ROW_NUMBER() OVER (PARTITION BY treatment ORDER BY d_date)
               ELSE NULL
             END AS cl_sequence
      FROM leave_dates
    ), deductible_dates AS (
      SELECT attendance_date AS d_date
      FROM staff_attendance
      WHERE school_id = v_school_id
        AND staff_id = p_staff_id
        AND attendance_date BETWEEN v_start_date AND v_end_date
        AND status = 'absent'
        AND deleted_at IS NULL
      UNION
      SELECT d_date
      FROM ranked_leave_dates
      WHERE treatment = 'UNPAID'
         OR (treatment = 'PAID_CL' AND cl_sequence > v_cl_entitlement)
    )
    SELECT COUNT(DISTINCT d_date) INTO v_total_deduction_days FROM deductible_dates;

    v_deduction_amount := ROUND(v_total_deduction_days * v_per_day_salary, 2);

    SELECT COALESCE(sp.bonus, 0), COALESCE(sp.salary_adjustment, 0)
      INTO v_bonus, v_adjustment
    FROM staff_payroll sp
    WHERE sp.school_id = v_school_id
      AND sp.staff_id = p_staff_id
      AND sp.payroll_month = p_month
      AND sp.payroll_year = p_year
      AND sp.run_kind = 'ORIGINAL'
      AND sp.run_sequence = 0;

    UPDATE staff_payroll sp
    SET base_salary = v_base_salary,
        deductions = v_deduction_amount,
        net_salary = GREATEST(0, v_base_salary + v_bonus + v_adjustment - v_deduction_amount),
        updated_at = now()
    WHERE sp.school_id = v_school_id
      AND sp.staff_id = p_staff_id
      AND sp.payroll_month = p_month
      AND sp.payroll_year = p_year
      AND sp.run_kind = 'ORIGINAL'
      AND sp.run_sequence = 0
      AND sp.calculation_engine IS DISTINCT FROM 'teacher-salary-v1'
      AND sp.status <> 'paid'
      AND sp.workflow_status NOT IN ('APPROVED', 'LOCKED', 'PAID');

    IF NOT FOUND AND v_payroll_id IS NULL THEN
      INSERT INTO staff_payroll (
        school_id, staff_id, payroll_month, payroll_year,
        base_salary, bonus, salary_adjustment, deductions, net_salary, status
      )
      VALUES (
        v_school_id, p_staff_id, p_month, p_year,
        v_base_salary, 0, 0, v_deduction_amount,
        GREATEST(0, v_base_salary - v_deduction_amount),
        'pending'
      );
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- The payroll screen calls this RPC every time a month is opened. Recalculate
-- each visible draft after creating missing rows so leave changes cannot remain
-- hidden behind an older generated amount.
CREATE OR REPLACE FUNCTION generate_monthly_payroll(
  p_month INTEGER,
  p_year INTEGER
)
RETURNS VOID
SET search_path = public
AS $$
DECLARE
  v_staff_id UUID;
BEGIN
  INSERT INTO staff_payroll (school_id, staff_id, base_salary, net_salary, payroll_month, payroll_year, status)
  SELECT school_id, id, COALESCE(salary, 0), COALESCE(salary, 0), p_month, p_year, 'pending'
  FROM staff
  WHERE status_id = 1
    AND deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM staff_payroll sp
      WHERE sp.staff_id = staff.id
        AND sp.school_id = staff.school_id
        AND sp.payroll_month = p_month
        AND sp.payroll_year = p_year
    );

  FOR v_staff_id IN
    SELECT id FROM staff WHERE status_id = 1 AND deleted_at IS NULL
  LOOP
    PERFORM recalculate_staff_payroll(v_staff_id, p_month, p_year);
  END LOOP;
END;
$$ LANGUAGE plpgsql;
