/**
 * hardDeleteStudent.js
 * ─────────────────────────────────────────────────────────────────────────────
 * PERMANENT, irreversible wipe of a single student and every row that belongs to
 * them, scoped to one school (multi-tenant safe). Generalised from the one-off
 * scripts/hardDeleteSingleStudent.js so the accounts portal can trigger it per
 * student behind a 3-step confirmation flow.
 *
 * Safety model:
 *   • schoolId is a validated integer (from the caller's JWT) and studentId a
 *     validated UUID (URL param). studentId is only ever bound through
 *     parameterised tagged templates; the only value interpolated into raw SQL
 *     strings is the integer schoolId — so there is no injection surface.
 *   • Everything runs in ONE transaction; any error rolls the whole thing back.
 *   • Linked parents are removed ONLY when they have no other children in the
 *     school. Auth users are deleted from Supabase AFTER the DB commit.
 */
import sql, { supabaseAdmin } from '../db.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function runDeleteTransaction(tx, schoolId, studentId) {
  // ── Resolve the blast radius into temp tables (parameterised, safe) ──────────
  await tx`
    CREATE TEMP TABLE target_students ON COMMIT DROP AS
    SELECT id, person_id FROM public.students
    WHERE id = ${studentId} AND school_id = ${schoolId}
  `;
  await tx`
    CREATE TEMP TABLE target_users ON COMMIT DROP AS
    SELECT u.id, u.person_id FROM public.users u
    JOIN target_students ts ON ts.person_id = u.person_id
    WHERE u.school_id = ${schoolId}
  `;
  // Explicit PK so parent-person inserts can safely de-dupe.
  await tx`
    CREATE TEMP TABLE target_persons (
      id UUID PRIMARY KEY
    ) ON COMMIT DROP
  `;
  await tx`
    INSERT INTO target_persons (id)
    SELECT person_id FROM target_students
    WHERE person_id IS NOT NULL
  `;
  // Parents are shared entities — only orphaned ones (no other child) get wiped.
  await tx`
    CREATE TEMP TABLE target_parents ON COMMIT DROP AS
    SELECT sp.parent_id AS id
    FROM public.student_parents sp
    JOIN target_students ts ON ts.id = sp.student_id
    WHERE sp.school_id = ${schoolId}
      AND NOT EXISTS (
        SELECT 1 FROM public.student_parents sp2
        WHERE sp2.parent_id = sp.parent_id
          AND sp2.student_id <> ${studentId}
          AND sp2.school_id = ${schoolId}
      )
  `;
  await tx`
    INSERT INTO target_persons (id)
    SELECT p.person_id FROM public.parents p
    JOIN target_parents tp ON tp.id = p.id
    WHERE p.school_id = ${schoolId} AND p.person_id IS NOT NULL
    ON CONFLICT DO NOTHING
  `;

  const stats = {};
  const del = async (label, query) => {
    const rows = await tx.unsafe(query);
    stats[label] = Number(rows[0]?.count ?? 0);
  };

  // ── Fees & receipts ──────────────────────────────────────────────────────────
  await del('receipt_items_fee_tx', `
    WITH deleted AS (
      DELETE FROM public.receipt_items ri
      USING public.fee_transactions ft, public.student_fees sf, target_students ts
      WHERE ri.fee_transaction_id = ft.id AND ft.student_fee_id = sf.id
        AND sf.student_id = ts.id AND ri.school_id = ${schoolId}
      RETURNING ri.id
    ) SELECT count(*)::int AS count FROM deleted`);

  await del('receipt_items_receipts', `
    WITH deleted AS (
      DELETE FROM public.receipt_items ri
      USING public.receipts r, target_students ts
      WHERE ri.receipt_id = r.id AND r.student_id = ts.id AND ri.school_id = ${schoolId}
      RETURNING ri.id
    ) SELECT count(*)::int AS count FROM deleted`);

  // The fee-transaction guard trigger blocks manual deletes; it re-enables below.
  await tx`ALTER TABLE public.fee_transactions DISABLE TRIGGER trg_guard_fee_txn`;
  try {
    await del('fee_transactions_refunds', `
      WITH deleted AS (
        DELETE FROM public.fee_transactions ft
        USING public.student_fees sf, target_students ts
        WHERE ft.student_fee_id = sf.id AND sf.student_id = ts.id
          AND ft.school_id = ${schoolId} AND ft.refund_of IS NOT NULL
        RETURNING ft.id
      ) SELECT count(*)::int AS count FROM deleted`);

    await del('fee_transactions', `
      WITH deleted AS (
        DELETE FROM public.fee_transactions ft
        USING public.student_fees sf, target_students ts
        WHERE ft.student_fee_id = sf.id AND sf.student_id = ts.id AND ft.school_id = ${schoolId}
        RETURNING ft.id
      ) SELECT count(*)::int AS count FROM deleted`);
  } finally {
    await tx`ALTER TABLE public.fee_transactions ENABLE TRIGGER trg_guard_fee_txn`;
  }

  await del('receipts', `
    WITH deleted AS (
      DELETE FROM public.receipts r USING target_students ts
      WHERE r.student_id = ts.id AND r.school_id = ${schoolId}
      RETURNING r.id
    ) SELECT count(*)::int AS count FROM deleted`);

  await del('defaulter_payments', `
    WITH deleted AS (
      DELETE FROM public.defaulter_payments dp
      USING public.defaulter_dues dd, target_students ts
      WHERE dp.defaulter_due_id = dd.id AND dd.student_id = ts.id AND dp.school_id = ${schoolId}
      RETURNING dp.id
    ) SELECT count(*)::int AS count FROM deleted`);

  await del('defaulter_dues', `
    WITH deleted AS (
      DELETE FROM public.defaulter_dues dd USING target_students ts
      WHERE dd.student_id = ts.id AND dd.school_id = ${schoolId}
      RETURNING dd.id
    ) SELECT count(*)::int AS count FROM deleted`);

  await del('fee_adjustments', `
    WITH deleted AS (
      DELETE FROM public.fee_adjustments fa USING target_students ts
      WHERE fa.student_id = ts.id AND fa.school_id = ${schoolId}
      RETURNING fa.id
    ) SELECT count(*)::int AS count FROM deleted`);

  await del('student_fees', `
    WITH deleted AS (
      DELETE FROM public.student_fees sf USING target_students ts
      WHERE sf.student_id = ts.id AND sf.school_id = ${schoolId}
      RETURNING sf.id
    ) SELECT count(*)::int AS count FROM deleted`);

  await del('transport_fee_payments', `
    WITH deleted AS (
      DELETE FROM public.transport_fee_payments tfp USING target_students ts
      WHERE tfp.student_id = ts.id AND tfp.school_id = ${schoolId}
      RETURNING tfp.id
    ) SELECT count(*)::int AS count FROM deleted`);

  // ── Academics ────────────────────────────────────────────────────────────────
  await del('daily_attendance', `
    WITH deleted AS (
      DELETE FROM public.daily_attendance da
      USING public.student_enrollments se, target_students ts
      WHERE da.student_enrollment_id = se.id AND se.student_id = ts.id AND da.school_id = ${schoolId}
      RETURNING da.id
    ) SELECT count(*)::int AS count FROM deleted`);

  await del('marks', `
    WITH deleted AS (
      DELETE FROM public.marks m
      USING public.student_enrollments se, target_students ts
      WHERE m.student_enrollment_id = se.id AND se.student_id = ts.id AND m.school_id = ${schoolId}
      RETURNING m.id
    ) SELECT count(*)::int AS count FROM deleted`);

  await del('student_enrollments', `
    WITH deleted AS (
      DELETE FROM public.student_enrollments se USING target_students ts
      WHERE se.student_id = ts.id AND se.school_id = ${schoolId}
      RETURNING se.id
    ) SELECT count(*)::int AS count FROM deleted`);

  await del('discipline_records', `
    WITH deleted AS (
      DELETE FROM public.discipline_records dr USING target_students ts
      WHERE dr.student_id = ts.id AND dr.school_id = ${schoolId}
      RETURNING dr.id
    ) SELECT count(*)::int AS count FROM deleted`);

  await del('hostel_allocations', `
    WITH deleted AS (
      DELETE FROM public.hostel_allocations ha USING target_students ts
      WHERE ha.student_id = ts.id AND ha.school_id = ${schoolId}
      RETURNING ha.id
    ) SELECT count(*)::int AS count FROM deleted`);

  await del('issued_certificates', `
    WITH deleted AS (
      DELETE FROM public.issued_certificates ic USING target_students ts
      WHERE ic.student_id = ts.id AND ic.school_id = ${schoolId}
      RETURNING ic.id
    ) SELECT count(*)::int AS count FROM deleted`);

  // Complaints are kept (school record) but unlinked from the deleted student.
  const complaintUpdates = await tx`
    UPDATE public.complaints c SET raised_for_student_id = NULL
    FROM target_students ts
    WHERE c.raised_for_student_id = ts.id AND c.school_id = ${schoolId}
    RETURNING c.id
  `;
  stats.complaints_unlinked = complaintUpdates.length;

  // ── Learning-program progress + transport ───────────────────────────────────
  await del('student_life_values_progress', `
    WITH deleted AS (
      DELETE FROM public.student_life_values_progress slvp USING target_students ts
      WHERE slvp.student_id = ts.id AND slvp.school_id = ${schoolId}
      RETURNING slvp.id
    ) SELECT count(*)::int AS count FROM deleted`);

  await del('student_money_science_progress', `
    WITH deleted AS (
      DELETE FROM public.student_money_science_progress smsp USING target_students ts
      WHERE smsp.student_id = ts.id AND smsp.school_id = ${schoolId}
      RETURNING smsp.id
    ) SELECT count(*)::int AS count FROM deleted`);

  await del('student_science_projects', `
    WITH deleted AS (
      DELETE FROM public.student_science_projects ssp USING target_students ts
      WHERE ssp.student_id = ts.id AND ssp.school_id = ${schoolId}
      RETURNING ssp.id
    ) SELECT count(*)::int AS count FROM deleted`);

  await del('student_transport', `
    WITH deleted AS (
      DELETE FROM public.student_transport st USING target_students ts
      WHERE st.student_id = ts.id AND st.school_id = ${schoolId}
      RETURNING st.id
    ) SELECT count(*)::int AS count FROM deleted`);

  await del('transport_import_rows', `
    WITH deleted AS (
      DELETE FROM public.transport_import_rows tir USING target_students ts
      WHERE tir.student_id = ts.id AND tir.school_id = ${schoolId}
      RETURNING tir.id
    ) SELECT count(*)::int AS count FROM deleted`);

  await del('student_parents', `
    WITH deleted AS (
      DELETE FROM public.student_parents sp USING target_students ts
      WHERE sp.student_id = ts.id AND sp.school_id = ${schoolId}
      RETURNING sp.id
    ) SELECT count(*)::int AS count FROM deleted`);

  // ── Messenger + portal-switcher rows (FK NO ACTION on students/users) ───────
  // Conversations cascade to messages / participants / typing / outbox.
  await del('message_conversations', `
    WITH deleted AS (
      DELETE FROM public.message_conversations mc
      WHERE mc.school_id = ${schoolId}
        AND (
          mc.student_id IN (SELECT id FROM target_students)
          OR mc.participant_low_user_id IN (SELECT id FROM target_users)
          OR mc.participant_high_user_id IN (SELECT id FROM target_users)
          OR mc.created_by IN (SELECT id FROM target_users)
        )
      RETURNING mc.id
    ) SELECT count(*)::int AS count FROM deleted`);

  await del('leave_applications', `
    WITH deleted AS (
      DELETE FROM public.leave_applications la USING target_users tu
      WHERE la.applicant_id = tu.id OR la.reviewed_by = tu.id
      RETURNING la.id
    ) SELECT count(*)::int AS count FROM deleted`);

  // context_switch_logs must go before user_access_contexts (NO ACTION FKs).
  await del('context_switch_logs', `
    WITH deleted AS (
      DELETE FROM public.context_switch_logs csl
      USING public.user_access_contexts uac
      WHERE (csl.from_context_id = uac.id OR csl.to_context_id = uac.id)
        AND (
          uac.student_id IN (SELECT id FROM target_students)
          OR uac.user_id IN (SELECT id FROM target_users)
          OR uac.parent_id IN (SELECT id FROM target_parents)
        )
      RETURNING csl.id
    ) SELECT count(*)::int AS count FROM deleted`);

  await del('user_access_contexts', `
    WITH deleted AS (
      DELETE FROM public.user_access_contexts uac
      WHERE uac.school_id = ${schoolId}
        AND (
          uac.student_id IN (SELECT id FROM target_students)
          OR uac.user_id IN (SELECT id FROM target_users)
          OR uac.parent_id IN (SELECT id FROM target_parents)
        )
      RETURNING uac.id
    ) SELECT count(*)::int AS count FROM deleted`);

  // ── Notifications & per-user rows (parents/students) ────────────────────────
  await del('notification_dispatch_recipients', `
    WITH deleted AS (
      DELETE FROM public.notification_dispatch_recipients ndr USING target_users tu
      WHERE ndr.user_id = tu.id RETURNING 1
    ) SELECT count(*)::int AS count FROM deleted`);

  await del('notification_deliveries', `
    WITH deleted AS (
      DELETE FROM public.notification_deliveries nd
      USING public.notifications n, target_users tu
      WHERE nd.notification_id = n.id AND n.user_id = tu.id AND nd.school_id = ${schoolId}
      RETURNING 1
    ) SELECT count(*)::int AS count FROM deleted`);

  await del('notifications', `
    WITH deleted AS (
      DELETE FROM public.notifications n USING target_users tu
      WHERE n.user_id = tu.id RETURNING 1
    ) SELECT count(*)::int AS count FROM deleted`);

  await del('notification_events', `
    WITH deleted AS (
      DELETE FROM public.notification_events ne USING target_users tu
      WHERE ne.target_user_id = tu.id RETURNING 1
    ) SELECT count(*)::int AS count FROM deleted`);

  await del('notification_preferences', `
    WITH deleted AS (
      DELETE FROM public.notification_preferences np USING target_users tu
      WHERE np.user_id = tu.id RETURNING 1
    ) SELECT count(*)::int AS count FROM deleted`);

  await del('notification_logs', `
    WITH deleted AS (
      DELETE FROM public.notification_logs nl USING target_users tu
      WHERE nl.user_id = tu.id RETURNING nl.id
    ) SELECT count(*)::int AS count FROM deleted`);

  await del('user_settings', `
    WITH deleted AS (
      DELETE FROM public.user_settings us USING target_users tu
      WHERE us.user_id = tu.id RETURNING us.user_id
    ) SELECT count(*)::int AS count FROM deleted`);

  await del('user_devices', `
    WITH deleted AS (
      DELETE FROM public.user_devices ud USING target_users tu
      WHERE ud.user_id = tu.id RETURNING ud.id
    ) SELECT count(*)::int AS count FROM deleted`);

  await del('user_roles', `
    WITH deleted AS (
      DELETE FROM public.user_roles ur USING target_users tu
      WHERE ur.user_id = tu.id RETURNING ur.user_id
    ) SELECT count(*)::int AS count FROM deleted`);

  await del('audit_logs', `
    WITH deleted AS (
      DELETE FROM public.audit_logs al USING target_users tu
      WHERE al.user_id = tu.id RETURNING al.id
    ) SELECT count(*)::int AS count FROM deleted`);

  // ── Core identities (order matters for FKs) ─────────────────────────────────
  await del('students', `
    WITH deleted AS (
      DELETE FROM public.students s USING target_students ts
      WHERE s.id = ts.id AND s.school_id = ${schoolId}
      RETURNING s.id
    ) SELECT count(*)::int AS count FROM deleted`);

  await del('parents', `
    WITH deleted AS (
      DELETE FROM public.parents p USING target_parents tp
      WHERE p.id = tp.id AND p.school_id = ${schoolId}
      RETURNING p.id
    ) SELECT count(*)::int AS count FROM deleted`);

  const deletedUsers = await tx`
    DELETE FROM public.users u USING target_users tu
    WHERE u.id = tu.id AND u.school_id = ${schoolId}
    RETURNING u.id
  `;
  stats.users = deletedUsers.length;

  await del('person_contacts', `
    WITH deleted AS (
      DELETE FROM public.person_contacts pc USING target_persons tp
      WHERE pc.person_id = tp.id AND pc.school_id = ${schoolId}
      RETURNING pc.id
    ) SELECT count(*)::int AS count FROM deleted`);

  await del('persons', `
    WITH deleted AS (
      DELETE FROM public.persons p USING target_persons tp
      WHERE p.id = tp.id AND p.school_id = ${schoolId}
      RETURNING p.id
    ) SELECT count(*)::int AS count FROM deleted`);

  return { stats, authUserIds: deletedUsers.map((row) => row.id) };
}

async function deleteAuthUsers(authUserIds) {
  const failures = [];
  for (const userId of authUserIds) {
    const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);
    if (error) failures.push({ userId, error: error.message });
  }
  return failures;
}

/**
 * Permanently delete a student and all associated data within one school.
 * @param {number} schoolId  Tenant id (from the caller's JWT).
 * @param {string} studentId Student UUID.
 * @returns {Promise<{ deleted: boolean, stats: object, authFailures: object[] }>}
 */
export async function hardDeleteStudent(schoolId, studentId) {
  // Middleware always sets req.schoolId as a string; coerce so the API path works.
  const sid = typeof schoolId === 'number' ? schoolId : Number(schoolId);
  if (!Number.isInteger(sid) || sid <= 0) throw new Error('Invalid schoolId');
  if (typeof studentId !== 'string' || !UUID_RE.test(studentId)) throw new Error('Invalid studentId');

  const result = await sql.begin((tx) => runDeleteTransaction(tx, sid, studentId));

  let authFailures = [];
  if (result.authUserIds.length > 0 && supabaseAdmin) {
    authFailures = await deleteAuthUsers(result.authUserIds);
  }

  return {
    deleted: (result.stats.students ?? 0) > 0,
    stats: result.stats,
    authFailures,
  };
}
