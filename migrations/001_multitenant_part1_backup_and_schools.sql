-- ============================================================
-- MULTI-TENANT MIGRATION — PART 1: BACKUP & SCHOOLS TABLE
-- NexSyrus IMS — Single-Tenant → Multi-Tenant Conversion
-- Generated: 2026-03-09
-- ============================================================

-- ┌──────────────────────────────────────────────────────┐
-- │ SECTION 1 — BACKUP (Run BEFORE migration)           │
-- └──────────────────────────────────────────────────────┘
-- Run this command on your server BEFORE executing migration:
--
--   pg_dump -Fc -f nexsyrus_pre_multitenant_backup.dump your_database_name
--
-- To restore if needed:
--   pg_restore -d your_database_name nexsyrus_pre_multitenant_backup.dump

-- ┌──────────────────────────────────────────────────────┐
-- │ SECTION 2 — BEGIN TRANSACTION                        │
-- └──────────────────────────────────────────────────────┘
BEGIN;

-- ┌──────────────────────────────────────────────────────┐
-- │ SECTION 3 — CREATE schools TABLE + SEED              │
-- └──────────────────────────────────────────────────────┘
CREATE TABLE IF NOT EXISTS schools (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(200) NOT NULL,
    slug        VARCHAR(100) NOT NULL UNIQUE,
    primary_color VARCHAR(20),
    logo_url    TEXT,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed the existing single school as id = 1
INSERT INTO schools (id, name, slug, is_active)
VALUES (1, 'Default School', 'default-school', TRUE)
ON CONFLICT (id) DO NOTHING;

-- Ensure sequence is ahead
SELECT setval('schools_id_seq', GREATEST((SELECT MAX(id) FROM schools), 1));

COMMIT;
