# DATA-FETCH PERFORMANCE AUDIT — schoolims-gateway

**Repo:** `Native SupabaseBackend/SupabaseBackend` (schoolims-gateway)
**Stack:** Node.js / Express 5 + `postgres.js` (pooled, PgBouncer transaction mode) + Supabase/Postgres
**DB access:** none — static analysis only. All runtime/plan claims are marked `UNVERIFIED` with the exact command to confirm.
**Date:** 2026-06-29

---

## Summary (5 lines)

- **9 findings:** 1 P1, 5 P2, 3 P3. **No confirmed P0** — the codebase is already performance-aware (parallelized dashboards, pagination everywhere, LATERAL joins instead of N+1, in-memory caches on analytics + student dashboard, gzip on, pooled DB, batch notification helpers).
- **Highest-impact item is a verification task, not a code change:** ~15 FK/filter-column indexes that the hot analytics + list queries depend on exist in `schema.sql` but are **absent from `migrations/`**. Whether the live DB has them is unverifiable statically (see F1). If it does **not**, every analytics aggregation full-scans `marks` / `fee_transactions` → that would be the P0. **Run the `pg_indexes` query in F1 first** — it decides whether several other findings are real.
- Healthy mechanics confirmed: connection pooling ([db.js:6](db.js:6), `max:10`, `prepare:false`), `compression()` ([server.js:131](server.js:131)), per-user rate limiting, request-scoped logging.
- Solid VERIFIED code findings independent of DB: sequential-await on the students list (F4), triple full-aggregation on the fee summaries list (F5), an N+1 + inline FCM on the defaulter-remind path (F6).
- Leading-wildcard `ILIKE '%term%'` search on name columns (F3) and uncached reference-data reads (F7, F8) round out the list.

---

## Findings (sorted by severity)

| # | Sev | Layer | Location | Evidence | Fix direction (1 line) | Effort | Verified? |
|---|-----|-------|----------|----------|------------------------|--------|-----------|
| F1 | **P1** | A / Infra | `migrations/` vs [schema.sql](schema.sql) | ~15 indexes on hot FK/filter columns are in `schema.sql` but NOT reproducible from `migrations/*.sql` (list below). `run_migration.js` applies `migrations/`; `audit:sync` *generates* `schema.sql` from live DB. Cannot tell statically which the live DB reflects. | Run the `pg_indexes` check below; if missing, add one migration recreating them | S (if missing) | **UNVERIFIED** |
| F2 | P2 | A | [adminAnalyticsRoutes.js:47](routes/adminAnalyticsRoutes.js:47), [:139](routes/adminAnalyticsRoutes.js:139), [:230](routes/adminAnalyticsRoutes.js:230) | Analytics aggregations filter `school_id` on a **joined parent** (`sf.school_id`, `s.school_id`) not on the large scanned table (`fee_transactions`, `daily_attendance`, `marks`). A `school_id`-leading composite index on the scanned table can't serve this; relies on the FK indexes in F1. | Filter `school_id` directly on the scanned table (it carries the column) and/or confirm FK indexes exist | M | **UNVERIFIED** |
| F3 | P2 | A/B | [studentsRoutes.js:186](routes/studentsRoutes.js:186); [feesRoutes.js:854](routes/feesRoutes.js:854) | Search uses leading-wildcard `ILIKE '%term%'` across `first_name`, `last_name`, `CONCAT(first,last)`, `class name`. Trgm GIN (migrations) covers only `persons.display_name` + `students.admission_no`; the other OR-branches can't use an index → seq scan of `persons`/`students` per search. | Drop redundant OR-branches in favor of `display_name`/`admission_no` trgm, or add trgm indexes to searched cols | M | **UNVERIFIED** (trgm presence shares F1's drift question) |
| F4 | P2 | C | [studentsRoutes.js:210](routes/studentsRoutes.js:210) + [:248](routes/studentsRoutes.js:248) | List query and its `COUNT(*)` query are independent but run as two **sequential** `await`s, not `Promise.all`. Adds one full round-trip + a second full join scan in series to every student-list load. | Wrap both in `Promise.all` (compare to `/summaries` which already does) | S | VERIFIED (static) |
| F5 | P2 | B/C | [feesRoutes.js:907](routes/feesRoutes.js:907)–1019 | `/fees/summaries` runs the **entire GROUP-BY aggregation 3×** per request (data + total-count + status-counts), each re-aggregating the full filtered student set. Parallel (Promise.all) so wall-clock ~1×, but 3× DB CPU/IO under concurrency. | Get `total` via `COUNT(*) OVER()` in the main query; fold status-counts into one pass | M | VERIFIED (static) |
| F6 | P2 | B/C | [defaulterRoutes.js:313](routes/defaulterRoutes.js:313) | `POST /defaulters/remind` loops per defaulter: `resolveNotificationUserIds([oneStudent])` (1 query/student) **+ `sendNotificationToUsers` (inline FCM) before responding**. N+1 + blocking I/O on request path. Batch path already exists ([notificationService.js:152](services/notificationService.js:152) uses `unnest`/`ANY`; [adminNotificationRoutes.js:300](routes/adminNotificationRoutes.js:300) pre-resolves all). | Resolve all user IDs in one `ANY($1)` call; dispatch in chunked `Promise.all` (mirror adminNotificationRoutes) | M | VERIFIED (static) |
| F7 | P3 | C | [studentsRoutes.js:215](routes/studentsRoutes.js:215)–216 | Two correlated per-row scalar subqueries on `person_contacts` (email + phone) for every row of the page. Index `person_contacts(person_id)` exists in `schema.sql` only (see F1); if absent live, 2×pageSize seq scans. | Confirm `person_contacts(person_id)` index (F1); otherwise collapse to a LEFT JOIN LATERAL | S | **UNVERIFIED** |
| F8 | P3 | C | [referenceRoutes.js](routes/referenceRoutes.js) (all GETs) | Reference lookups (designations, genders, blood groups, relationship types, etc.) — hot, rarely-changing, read on most form loads — hit the DB every request with no cache layer or `Cache-Control`. Cheap (indexed by `school_id`) but pure waste. | Add a short in-memory TTL cache (pattern already used in `adminAnalyticsRoutes`) or `Cache-Control` | S | VERIFIED (static) |
| F9 | P3 | A | [feesRoutes.js:1066](routes/feesRoutes.js:1066), [adminAnalyticsRoutes.js:97](routes/adminAnalyticsRoutes.js:97) | Date-range predicates (`due_date < CURRENT_DATE`, `paid_at > now()-6mo`) on `student_fees`/`fee_transactions`. Composite indexes `(school_id,status,due_date)` and `(school_id,paid_at)` exist in migrations and should serve these — noted for completeness, not flagged as a problem. | None — verify served by existing composites via EXPLAIN if dashboards feel slow | S | **UNVERIFIED** |

### F1 — full list of `schema.sql`-only indexes (absent from `migrations/`)

```
daily_attendance(attendance_date)
daily_attendance(student_enrollment_id)
daily_attendance(student_enrollment_id, status, attendance_date)
fee_transactions(paid_at)
fee_transactions(student_fee_id)        ← FK join key in every financials aggregation + receipts LATERAL
marks(exam_subject_id)                  ← FK join key in all 6 academics aggregations
marks(student_enrollment_id)            ← FK join key in all 6 academics aggregations
person_contacts(person_id)              ← drives F7
receipt_items(fee_transaction_id)
receipt_items(receipt_id)
student_enrollments(class_section_id)
student_fees(fee_structure_id)
student_fees(status)
student_fees(student_id)
students(status_id)
```

`marks` and `receipt_items` have **only** a `(school_id)` index in `migrations/`; all FK join columns above are migration-absent. If the live DB is built purely from `migrations/`, the admin analytics dashboard ([adminAnalyticsRoutes.js](routes/adminAnalyticsRoutes.js)) hash-joins/seq-scans the full `marks` and `fee_transactions` tables on every cold cache (5-min TTL, [adminAnalyticsRoutes.js:511](routes/adminAnalyticsRoutes.js:511)) — order-of-magnitude slow on a large school. If the live DB reflects `schema.sql`, there is no perf problem and this is only a DR/reproducibility risk.

---

## Commands to verify the DB-dependent findings (F1, F2, F3, F7, F9)

**1. Decide F1 first — does the live DB actually have the FK indexes?**
```sql
SELECT tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('marks','fee_transactions','receipt_items','person_contacts',
                    'student_fees','daily_attendance','student_enrollments','students')
ORDER BY tablename, indexname;
```
Cross-check against the F1 list. Any row missing → that finding is real and P0-grade for analytics.

**2. Confirm the academics aggregation plan (F1/F2) — run for a real `<school_id>`:**
```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT COALESCE(AVG(m.marks_obtained::FLOAT / NULLIF(es.max_marks,0) * 100),0)::FLOAT
FROM marks m
JOIN exam_subjects es ON m.exam_subject_id = es.id
JOIN student_enrollments se ON m.student_enrollment_id = se.id
JOIN students s ON se.student_id = s.id
WHERE s.school_id = '<school_id>' AND m.created_at >= date_trunc('month', now());
```
Look for `Seq Scan on marks` / large `Hash Join` rows → confirms F1+F2.

**3. Confirm the financials collection plan (F1/F2):**
```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT COALESCE(SUM(ft.amount),0)
FROM fee_transactions ft
JOIN student_fees sf ON ft.student_fee_id = sf.id
WHERE ft.paid_at >= date_trunc('month', now()) AND sf.school_id = '<school_id>';
```
`Seq Scan on fee_transactions` → confirms the FK-index gap matters.

---

## Top 3 to fix first (impact ÷ effort)

1. **F1 verification (S, then S to fix).** One `pg_indexes` query decides whether the gateway's entire analytics layer is fine or doing full scans. If indexes are missing, one additive migration (`CREATE INDEX IF NOT EXISTS ...` for the F1 list) is the single highest-leverage change in this repo — and it also resolves F2 and F7. Do this before anything else.
2. **F4 — `Promise.all` the students-list count (S, no DB needed).** Two-line change on a high-traffic list endpoint; removes a serial round-trip + a redundant full-join scan from every page load. Pure win, zero risk.
3. **F6 — debatch the defaulter-remind path (M).** Collapse the per-student loop to one `ANY($1)` resolve + chunked parallel dispatch, mirroring `adminNotificationRoutes`. On a school with hundreds of defaulters this turns hundreds of serial queries + serial FCM calls (all on the request thread) into a handful — and the correct pattern already exists in the codebase to copy.

> Note: F5 (triple aggregation) is higher DB-cost but its parallelization already hides wall-clock latency, so it ranks below F6 for a first pass despite similar effort.
