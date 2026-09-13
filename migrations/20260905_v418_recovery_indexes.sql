-- Execute outside a transaction (scripts/run_batch1_migrations.js).
-- Student cooldown and history: tenant + student equality, then creation time range.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_auto_exec_student_created
  ON public.automation_execution_logs (school_id, student_id, created_at DESC)
  WHERE rule_key = 'fee_due_reminder';

-- Overview's provider-accepted reminders in the last 30 days.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_auto_exec_completed_date
  ON public.automation_execution_logs (school_id, executed_at DESC)
  WHERE rule_key = 'fee_due_reminder' AND status = 'completed';
-- Scanner filters tenant and a short set of due dates. Existing status-first
-- indexes cannot narrow those dates when no single status is selected.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_student_fees_recovery_due
  ON public.student_fees (school_id, due_date, id)
  WHERE deleted_at IS NULL AND status <> 'waived'
    AND GREATEST(amount_due - discount - amount_paid, 0) > 0;
