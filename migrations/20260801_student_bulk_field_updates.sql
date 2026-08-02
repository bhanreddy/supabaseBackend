-- Bulk single-field student updates with durable preview/audit history.
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS student_bulk_update_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
    original_filename TEXT,
    field_key VARCHAR(50) NOT NULL,
    field_label VARCHAR(100) NOT NULL,
    allow_blank_clear BOOLEAN NOT NULL DEFAULT FALSE,
    status TEXT NOT NULL DEFAULT 'preview'
        CHECK (status IN ('preview', 'committed', 'failed')),
    total_rows INTEGER NOT NULL DEFAULT 0,
    valid_rows INTEGER NOT NULL DEFAULT 0,
    invalid_rows INTEGER NOT NULL DEFAULT 0,
    unchanged_rows INTEGER NOT NULL DEFAULT 0,
    success_rows INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    committed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_student_bulk_update_batches_school
    ON student_bulk_update_batches (school_id, created_at DESC);

CREATE TABLE IF NOT EXISTS student_bulk_update_rows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id UUID NOT NULL REFERENCES student_bulk_update_batches(id) ON DELETE CASCADE,
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    row_number INTEGER NOT NULL,
    admission_no TEXT,
    raw_value TEXT,
    normalized_value TEXT,
    new_display_value TEXT,
    current_value TEXT,
    student_id UUID REFERENCES students(id) ON DELETE SET NULL,
    person_id UUID REFERENCES persons(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'valid'
        CHECK (status IN ('valid', 'invalid', 'unchanged', 'success', 'failed')),
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    applied_at TIMESTAMPTZ,
    UNIQUE (batch_id, row_number)
);

CREATE INDEX IF NOT EXISTS idx_student_bulk_update_rows_batch
    ON student_bulk_update_rows (batch_id, row_number);

CREATE INDEX IF NOT EXISTS idx_student_bulk_update_rows_student
    ON student_bulk_update_rows (school_id, student_id)
    WHERE student_id IS NOT NULL;
