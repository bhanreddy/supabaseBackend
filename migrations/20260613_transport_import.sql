-- ════════════════════════════════════════════════════════════
-- Migration: Bulk transport stop assignment import audit tables
-- Date: 2026-06-13
-- Safe to re-run (idempotent).
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS transport_import_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
    original_filename TEXT,
    academic_year_id UUID NOT NULL REFERENCES academic_years(id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'preview'
        CHECK (status IN ('preview', 'committed', 'failed')),
    total_rows INTEGER NOT NULL DEFAULT 0,
    valid_rows INTEGER NOT NULL DEFAULT 0,
    success_rows INTEGER NOT NULL DEFAULT 0,
    failed_rows INTEGER NOT NULL DEFAULT 0,
    skipped_rows INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    committed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_transport_import_batches_school
    ON transport_import_batches(school_id, created_at DESC);

CREATE TABLE IF NOT EXISTS transport_import_rows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id UUID NOT NULL REFERENCES transport_import_batches(id) ON DELETE CASCADE,
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    row_number INTEGER NOT NULL,
    full_name TEXT,
    admission_no TEXT,
    stop_name TEXT,
    student_id UUID REFERENCES students(id) ON DELETE SET NULL,
    stop_id UUID REFERENCES transport_stops(id) ON DELETE SET NULL,
    route_id UUID REFERENCES transport_routes(id) ON DELETE SET NULL,
    route_name TEXT,
    status TEXT NOT NULL DEFAULT 'valid'
        CHECK (status IN ('valid', 'invalid', 'success', 'failed')),
    error_message TEXT,
    warning_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (batch_id, row_number)
);

CREATE INDEX IF NOT EXISTS idx_transport_import_rows_batch
    ON transport_import_rows(batch_id, row_number);
