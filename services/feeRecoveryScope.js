import sql from '../db.js';
import { activeStructureFilter, getSchoolFeeMode } from './feeModeService.js';
import { activeStudentSql } from '../utils/activeStudentFilter.js';

// Matches the existing Accounts/receipt ledger: amount_due - discount - amount_paid.
// Recovery covers active students' assigned standard fees; transport has its own ledger.
export async function recoveryFees(schoolId) {
  const mode = await getSchoolFeeMode(schoolId);
  return { query: sql`
    SELECT sf.*, p.display_name AS student_name,
      GREATEST(sf.amount_due - sf.discount - sf.amount_paid, 0)::numeric AS balance_due
    FROM student_fees sf
    JOIN fee_structures fs ON fs.id = sf.fee_structure_id AND fs.school_id = ${schoolId}
    JOIN students s ON s.id = sf.student_id AND s.school_id = ${schoolId}
    JOIN persons p ON p.id = s.person_id AND p.school_id = ${schoolId} AND p.deleted_at IS NULL
    WHERE sf.school_id = ${schoolId} AND sf.deleted_at IS NULL AND fs.deleted_at IS NULL
      AND sf.status <> 'waived' AND ${activeStudentSql('s')}
      ${activeStructureFilter(mode)}
  ` };
}

// DATE columns are calendar dates, never host-local timestamps.
export function feeCalendarDate(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const date = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}
export function feeToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function feeDaysOverdue(dueDate, now = new Date()) {
  const due = feeCalendarDate(dueDate);
  return due ? Math.round((Date.parse(feeToday(now)) - Date.parse(due)) / 86400000) : null;
}
export function determineReminderStage(dueDate, triggerConfig = {}, now = new Date()) {
  const days = feeDaysOverdue(dueDate, now);
  if (days == null || !Number.isFinite(days)) return null;
  const before = triggerConfig.days_before_due ?? 3;
  if (days === 0) return 'due_today';
  if (before > 0 && days === -before) return `upcoming_${before}d`;
  const stages = triggerConfig.overdue_stages ?? [3, 7, 15, 30];
  return Array.isArray(stages) && stages.includes(days) ? `overdue_${days}d` : null;
}

export function assertFiniteRecoveryAmounts(...amounts) {
  if (amounts.some(amount => !Number.isFinite(Number(amount)))) {
    const error = new Error('Fee records contain invalid amounts; Accounts must correct the ledger');
    error.status = 409;
    throw error;
  }
}
