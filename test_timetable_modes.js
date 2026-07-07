// Acceptance tests for the timetable scheduling-modes upgrade.
//
// SAFETY: every write runs inside ONE transaction that is ROLLED BACK at the
// end (via a sentinel throw), so NOTHING is persisted to real school data.
// Error-expecting cases use SAVEPOINTs so a caught error doesn't poison the
// outer transaction. Functional rows use period_number 98/99 to avoid touching
// real periods. Run: node test_timetable_modes.js
import sql from './db.js';

const ROLLBACK = Symbol('rollback');
const results = [];
const ok = (name, pass, detail = '') => results.push({ name, pass, detail });

// Test fixture discovered from the live DB (school 1, current-ish year, 2 sections).
const SCHOOL = 1;
const YEAR = '2688cf3e-8bab-4b20-92c7-e4ca2619413f';
const CS1 = '9c6c2ab7-b1f7-462f-a449-ac311c7a0a7c';
const CS2 = 'd660bd3e-b809-4c56-8655-92ca7d4ea0ff';
const SUBJECT = 'fd252be4-d93b-47d8-bd38-fb9ae2b7c24e';
const TEACHER = 'd18f3e98-3426-45d2-a292-86c8977e9891';

const insertSlot = (tx, cs, day, period, teacher = TEACHER) => tx`
  INSERT INTO timetable_slots
    (academic_year_id, class_section_id, period_number, day_of_week,
     subject_id, teacher_id, start_time, end_time, school_id)
  VALUES
    (${YEAR}, ${cs}, ${period}, ${day}::day_of_week_enum,
     ${SUBJECT}, ${teacher}, '07:00', '07:45', ${SCHOOL})
`;

async function structural() {
  // S1: schools.timetable_mode default + CHECK
  const [col] = await sql`
    SELECT column_default FROM information_schema.columns
    WHERE table_name='schools' AND column_name='timetable_mode'
  `;
  ok('S1 schools.timetable_mode exists w/ uniform default',
     !!col && /uniform/.test(col.column_default || ''), col?.column_default);

  const chk = await sql`SELECT 1 FROM pg_constraint WHERE conname='chk_schools_timetable_mode'`;
  ok('S1 CHECK constraint present', chk.length === 1);

  // S2: periods.is_break
  const [pb] = await sql`
    SELECT data_type FROM information_schema.columns
    WHERE table_name='periods' AND column_name='is_break'
  `;
  ok('S2 periods.is_break exists (boolean)', pb?.data_type === 'boolean', pb?.data_type);

  // S3: unique index includes day_of_week
  const [idx] = await sql`SELECT indexdef FROM pg_indexes WHERE indexname='uq_timetable_slots_active'`;
  ok('S3 uq_timetable_slots_active includes day_of_week',
     !!idx && /day_of_week/.test(idx.indexdef), idx?.indexdef);

  // S4: collision trigger scoped by day_of_week
  const [fn] = await sql`SELECT pg_get_functiondef(oid) AS def FROM pg_proc WHERE proname='validate_timetable_entry' LIMIT 1`;
  ok('S4 validate_timetable_entry scopes by day_of_week',
     !!fn && /day_of_week\s*=\s*NEW\.day_of_week/.test(fn.def));
}

async function functional() {
  try {
    await sql.begin(async (tx) => {
      // F1: same period, different days both allowed (widened unique index)
      await insertSlot(tx, CS1, 'monday', 99);
      await insertSlot(tx, CS1, 'tuesday', 99);
      const [{ count: c1 }] = await tx`
        SELECT count(*)::int AS count FROM timetable_slots
        WHERE class_section_id=${CS1} AND academic_year_id=${YEAR}
          AND period_number=99 AND deleted_at IS NULL
      `;
      ok('F1 same period on Mon+Tue coexist (per-day index)', c1 === 2, `rows=${c1}`);

      // F2: duplicate (section, year, day, period) rejected by the unique index.
      // Use a NULL teacher so the day-scoped collision trigger doesn't pre-empt
      // the index — this isolates the uq_timetable_slots_active guarantee.
      let dupErr = null;
      try {
        await tx.savepoint(async (sp) => { await insertSlot(sp, CS1, 'monday', 99, null); });
      } catch (e) { dupErr = e; }
      ok('F2 duplicate Mon/period rejected (unique index)', dupErr?.code === '23505', dupErr?.code);

      // F3: teacher double-booked SAME day raises collision
      let colErr = null;
      try {
        await tx.savepoint(async (sp) => { await insertSlot(sp, CS2, 'monday', 99); });
      } catch (e) { colErr = e; }
      ok('F3 teacher same-day collision raised',
         /Teacher Collision/i.test(colErr?.message || ''), colErr?.message);

      // F4: same teacher, same period, DIFFERENT day is allowed (day-scoping fix)
      let f4err = null;
      try { await insertSlot(tx, CS2, 'wednesday', 99); } catch (e) { f4err = e; }
      ok('F4 same teacher diff day allowed', f4err === null, f4err?.message);

      // F8: upsert same slot (same teacher) must not false-positive on collision trigger
      let f8err = null;
      try {
        await tx`
          INSERT INTO timetable_slots
            (academic_year_id, class_section_id, period_number, day_of_week,
             subject_id, teacher_id, start_time, end_time, school_id)
          VALUES
            (${YEAR}, ${CS1}, 97, 'saturday'::day_of_week_enum,
             ${SUBJECT}, ${TEACHER}, '07:00', '07:45', ${SCHOOL})
          ON CONFLICT (class_section_id, academic_year_id, day_of_week, period_number)
            WHERE deleted_at IS NULL
          DO UPDATE SET
            subject_id = EXCLUDED.subject_id,
            teacher_id = EXCLUDED.teacher_id,
            start_time = EXCLUDED.start_time,
            end_time = EXCLUDED.end_time
        `;
      } catch (e) { f8err = e; }
      ok('F8 upsert same slot same teacher allowed', f8err === null, f8err?.message);

      // F5: uniform -> per_day fan-out (section-scoped mirror of PATCH /config)
      await insertSlot(tx, CS1, 'monday', 98);
      for (const day of ['tuesday', 'wednesday', 'thursday', 'friday', 'saturday']) {
        await tx`
          INSERT INTO timetable_slots
            (academic_year_id, class_section_id, period_number, day_of_week,
             subject_id, teacher_id, start_time, end_time, school_id)
          SELECT ts.academic_year_id, ts.class_section_id, ts.period_number, ${day}::day_of_week_enum,
                 ts.subject_id, ts.teacher_id, ts.start_time, ts.end_time, ts.school_id
          FROM timetable_slots ts
          WHERE ts.class_section_id=${CS1} AND ts.academic_year_id=${YEAR}
            AND ts.period_number=98 AND ts.day_of_week='monday' AND ts.deleted_at IS NULL
          ON CONFLICT (class_section_id, academic_year_id, day_of_week, period_number)
            WHERE deleted_at IS NULL DO NOTHING
        `;
      }
      const [{ count: c5 }] = await tx`
        SELECT count(*)::int AS count FROM timetable_slots
        WHERE class_section_id=${CS1} AND academic_year_id=${YEAR}
          AND period_number=98 AND deleted_at IS NULL
      `;
      ok('F5 uniform->per_day fan-out creates 6 days', c5 === 6, `days=${c5}`);

      // F6: per_day -> uniform collapse (source_day=monday) leaves only Monday
      await tx`
        UPDATE timetable_slots
        SET deleted_at=now(), updated_at=now()
        WHERE class_section_id=${CS1} AND academic_year_id=${YEAR}
          AND period_number=98 AND deleted_at IS NULL
          AND day_of_week <> 'monday'::day_of_week_enum
      `;
      const after = await tx`
        SELECT day_of_week FROM timetable_slots
        WHERE class_section_id=${CS1} AND academic_year_id=${YEAR}
          AND period_number=98 AND deleted_at IS NULL
      `;
      ok('F6 per_day->uniform collapse keeps only source day',
         after.length === 1 && after[0].day_of_week === 'monday', JSON.stringify(after.map(r => r.day_of_week)));

      // F7: period time CHECK rejects end <= start
      let f7err = null;
      try {
        await tx.savepoint(async (sp) => {
          await sp`INSERT INTO periods (school_id, name, start_time, end_time, sort_order)
                   VALUES (${SCHOOL}, '__test_bad__', '10:00', '09:00', 999)`;
        });
      } catch (e) { f7err = e; }
      ok('F7 period end<=start rejected (CHECK)', !!f7err, f7err?.code);

      throw ROLLBACK; // discard everything
    });
  } catch (e) {
    if (e !== ROLLBACK) {
      ok('FATAL transaction error', false, e.message);
    }
  }
}

async function main() {
  try {
    await structural();
    await functional();
  } catch (e) {
    ok('FATAL', false, e.message);
  }

  let passed = 0;
  console.log('\n──────── Timetable modes acceptance tests ────────');
  for (const r of results) {
    console.log(`${r.pass ? '✅' : '❌'} ${r.name}${r.detail ? `  ·  ${r.detail}` : ''}`);
    if (r.pass) passed++;
  }
  console.log(`──────────────────────────────────────────────────`);
  console.log(`${passed}/${results.length} passed  (all writes rolled back — no data persisted)\n`);
  process.exit(passed === results.length ? 0 : 1);
}
main();
