import { z } from 'zod';

export const libraryBookSchema = z.object({
  title: z.string().trim().min(1).max(300), author: z.string().trim().min(1).max(200),
  isbn: z.string().trim().max(32).default(''), category: z.string().trim().max(100).default(''),
  publisher: z.string().trim().max(200).default(''),
});
export const libraryCopySchema = z.object({
  accession_no: z.string().trim().min(1).max(80), shelf: z.string().trim().max(100).default(''),
});
export const librarySettingsSchema = z.object({
  loan_days: z.number().int().min(1).max(365), max_loans: z.number().int().min(1).max(100),
  max_renewals: z.number().int().min(0).max(20), fine_per_day: z.number().min(0).max(10000).multipleOf(0.01),
});
export const libraryIssueSchema = z.object({ copy_id: z.string().uuid(), borrower_person_id: z.string().uuid() });
export const libraryReservationSchema = z.object({ book_id: z.string().uuid(), borrower_person_id: z.string().uuid() });
export const libraryReturnSchema = z.object({ condition: z.enum(['available', 'lost', 'damaged']).default('available') });
export const libraryPaymentSchema = z.object({ amount: z.number().positive().max(10000000).multipleOf(0.01) });

export const DEFAULT_LIBRARY_SETTINGS = Object.freeze({ loan_days: 14, max_loans: 3, max_renewals: 2, fine_per_day: 0 });
// Both dates are school-local calendar dates supplied by PostgreSQL.
export function libraryOverdueFine(dueDate, today, dailyRate) {
  const days = Math.max(0, Math.round((Date.parse(today) - Date.parse(dueDate)) / 86400000));
  if (!Number.isFinite(days)) throw new Error('Invalid library date');
  return Math.round(days * Number(dailyRate) * 100) / 100;
}
export function assertLibraryRenewable(loan, settings, today, hasReservation) {
  if (loan.returned_at) return 'This book has already been returned.';
  if (String(loan.due_date).slice(0, 10) < today) return 'Return overdue books before borrowing again.';
  if (loan.renewal_count >= settings.max_renewals) return 'The renewal limit has been reached.';
  if (hasReservation) return 'Another borrower has reserved this title.';
  return null;
}
