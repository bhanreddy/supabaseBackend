-- ============================================================================
-- RBAC & Segregation-of-Duties — Phase 1 (permission model)
-- ----------------------------------------------------------------------------
-- Adds the genuinely-new permissions this epic needs and enforces separation of
-- duties for the accounts role. Reuses existing permission keys everywhere they
-- already exist (fees.collect, expenses.*, staff.*, payroll.process) instead of
-- creating parallel duplicates.
--
-- "management" == the admin + principal roles (both are seeded full-access).
--
-- Idempotent and re-runnable. Run once on existing databases; NEW schools get
-- the same result via seed_school_defaults() in schema.sql (updated in the same
-- change so a later re-seed can never undo the accounts revocations below).
--
-- NOTE on revocation: the auth permission query (middleware/auth.js) joins
-- role_permissions WITHOUT filtering deleted_at, so a soft delete would NOT
-- actually remove access. Revocation MUST be a hard DELETE.
-- ============================================================================

BEGIN;

-- 1. New permission definitions for every existing school ---------------------
INSERT INTO permissions (school_id, code, name)
SELECT s.id, v.code, v.name
FROM schools s
CROSS JOIN (VALUES
  ('refund.create',             'Create Refunds'),
  ('salary.view',               'View Salary'),
  ('payslip.view',              'View Payslips'),
  ('fee.underpayment.approve',  'Approve Fee Underpayments')
) AS v(code, name)
WHERE NOT EXISTS (
  SELECT 1 FROM permissions p
  WHERE p.school_id = s.id AND p.code = v.code
);

-- 2. Grant the new permissions to management (admin + principal), per school --
--    Granted to admin explicitly too (not just via the requirePermission admin
--    bypass) so the /me permission list surfaces them for frontend gating.
INSERT INTO role_permissions (school_id, role_id, permission_id)
SELECT p.school_id, r.id, p.id
FROM permissions p
JOIN roles r
  ON r.school_id = p.school_id
 AND r.code IN ('admin', 'principal')
WHERE p.code IN (
  'refund.create', 'salary.view', 'payslip.view', 'fee.underpayment.approve'
)
AND NOT EXISTS (
  SELECT 1 FROM role_permissions rp
  WHERE rp.role_id = r.id
    AND rp.permission_id = p.id
    AND rp.school_id = p.school_id
);

-- 3. Revoke expenses + payroll permissions from the accounts role ------------
--    Segregation of duties: accounts no longer manages expenses or runs payroll.
--    Hard DELETE (see NOTE above).
--
--    NOTE: staff.create/edit/delete are deliberately NOT revoked here. Two live
--    features depend on accounts holding them — the admin opt-in
--    `accounts_staff_creation_enabled` toggle (route-enforced via
--    assertAccountsCanCreateStaff) and the accounts manage-users password-reset
--    flow. Removing staff management from accounts entirely is a separate
--    product decision (see GATE 1 note); if approved, add those keys back here.
DELETE FROM role_permissions rp
USING roles r, permissions p
WHERE rp.role_id       = r.id
  AND rp.permission_id = p.id
  AND rp.school_id     = r.school_id
  AND p.school_id      = r.school_id
  AND r.code = 'accounts'
  AND p.code IN (
    'expenses.view', 'expenses.create', 'expenses.edit', 'expenses.delete', 'expenses.approve',
    'payroll.process'
  );

COMMIT;
