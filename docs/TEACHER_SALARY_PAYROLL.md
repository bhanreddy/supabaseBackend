# Teacher salary and payslips

Salary is calculated in `services/teacherSalaryCalculation.js` (`teacher-salary-v1`) with rational decimal arithmetic. The same snapshot input always reproduces the same payslip.

## Sources

The calculator does not keep a second copy of attendance, leave, or holidays. It reads:

- `staff`, `staff_salary_revisions`, and `staff_locality_classifications`
- `staff_attendance` (`present`, `late`, `absent`, `half_day`, plus `is_on_duty` and `late_converted_to_half_day`)
- `leave_applications` (only `approved` leave affects payroll; its persisted payroll treatment determines paid CL, other paid leave, or unpaid leave)
- published `calendar_events` holidays for the school, staff, or teacher audience
- `school_payroll_policies` effective for the payroll month

`staff.salary` remains the current salary shown on the staff record. Payroll uses `staff_salary_revisions`, which is backfilled from `staff.salary`. A later salary edit does not change a frozen snapshot.

## Defaults

School policy starts as: local teachers 3 permitted lates, non-local teachers 5, 0.5 day per excess late, 1 casual-leave day, casual leave disabled at 8 official holidays, 1 unused-CL bonus day, and a calendar-day divisor. Weekly offs default to Sunday and are not holidays. Change these with `POST /api/v1/payroll/teacher/policies`. A new policy closes the previous open-ended policy on the day before it starts. Historical snapshots keep the policy they were calculated with.

## Formula

Per-day salary is the effective monthly salary divided by the number of calendar days in the month. A mid-month salary revision is prorated per segment. Gross contract salary is the sum of those daily rates for joining-to-relieving dates inside the month. Each earning and deduction is rounded half-up to 2 decimals once. The net is the sum of the rounded components. Unrounded values stay in the snapshot.

Casual leave and the attendance bonus are withheld when the teacher is not employed for the full month, unless an administrator records an override and a reason.

For new approvals, `leave_applications.payroll_treatment` is authoritative: `PAID_CL` consumes the monthly CL balance and sends only excess days to deduction, `PAID_LEAVE` is paid without consuming CL, and `UNPAID` sends every applicable leave day to deduction. The original requested `leave_type` is retained for audit. Legacy approved rows are backfilled to the equivalent treatment by the leave salary approval migration.

The admin leave screen previews the same `teacher-salary-v1` inputs used by payslips. It shows CL already used, entitlement, remaining CL, and the projected paid/unpaid split before the decision is saved. If a backdated leave is approved after that month’s payroll reaches `APPROVED`, `LOCKED`, or `PAID`, the frozen payslip is not rewritten; the approval response flags that a supplementary payroll correction is required.

## Workflow

`DRAFT → VALIDATED → APPROVED → LOCKED → PAID`

- `payroll.prepare`: calculate, validate, and add adjustments
- `payroll.approve`: approve an adjustment, approve the payroll, and lock it
- `payroll.pay`: mark a locked payroll paid with a payment date and reference
- `payroll.audit`: read the calculation snapshot and audit log
- A teacher can read only their own payslip, and only after the publish point stored on the snapshot (`LOCKED` by default, or `APPROVED`)

Locked and paid amounts cannot be edited. Corrections are a reversal or a supplementary payroll. The legacy attendance trigger does not rewrite `teacher-salary-v1` amounts; it marks an open draft for review instead.

## API

All routes are under `/api/v1/payroll/teacher`.

- `POST /prepare` with `staff_id`, `month`, `year`
- `POST /:id/validate`, `/approve`, `/lock`
- `POST /:id/pay` with `payment_date` and `payment_reference`
- `POST /:id/adjustments` and `POST /:id/adjustments/:adjustmentId/approve`
- `POST /:id/reversal` and `POST /:id/supplementary`
- `GET /:id` payslip, `GET /:id/evidence` calculation evidence
- `POST /policies`, `/classifications`, `/salary-revisions`, `/cl-overrides`

Apply `migrations/20260925_teacher_salary_payroll.sql` before using these routes.
