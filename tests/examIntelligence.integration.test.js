import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import postgres from 'postgres';
import express from 'express';
const url = process.env.EXAM_INTELLIGENCE_TEST_DATABASE_URL;
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
test('exam intelligence SQL, two-tenant API, publication and action lifecycle', {
  skip: !url
}, async t => {
  const parsed = new URL(url);
  assert.ok(['localhost', '127.0.0.1'].includes(parsed.hostname) && parsed.pathname.endsWith('_exam_test'), 'Dedicated local *_exam_test database required');
  const db = postgres(url, {
    ssl: false,
    max: 3,
    prepare: false,
    onnotice: () => {}
  });
  let server;
  try {
    await db.unsafe(`DROP SCHEMA public CASCADE;CREATE SCHEMA public;
      DO $$ BEGIN CREATE ROLE anon;EXCEPTION WHEN duplicate_object THEN NULL;END $$;
      DO $$ BEGIN CREATE ROLE authenticated;EXCEPTION WHEN duplicate_object THEN NULL;END $$;
      DO $$ BEGIN CREATE ROLE service_role;EXCEPTION WHEN duplicate_object THEN NULL;END $$;
      CREATE TABLE schools(id integer PRIMARY KEY);
      CREATE TABLE persons(id uuid PRIMARY KEY,school_id integer,display_name text,photo_url text);
      CREATE TABLE users(id uuid PRIMARY KEY,school_id integer,person_id uuid,account_status text DEFAULT 'active',deleted_at timestamptz);
      CREATE TABLE roles(id uuid PRIMARY KEY,school_id integer,code text);
      CREATE TABLE user_roles(user_id uuid,school_id integer,role_id uuid);
      CREATE TABLE students(id uuid PRIMARY KEY,school_id integer,person_id uuid,admission_no text,deleted_at timestamptz);
      CREATE TABLE academic_years(id uuid PRIMARY KEY,school_id integer,code text,start_date date,end_date date,deleted_at timestamptz);
      CREATE TABLE classes(id uuid PRIMARY KEY,school_id integer,name text,sort_order integer);
      CREATE TABLE sections(id uuid PRIMARY KEY,school_id integer,name text);
      CREATE TABLE class_sections(id uuid PRIMARY KEY,school_id integer,class_id uuid,section_id uuid,academic_year_id uuid,deleted_at timestamptz);
      CREATE TABLE student_enrollments(id uuid PRIMARY KEY,school_id integer,student_id uuid,class_section_id uuid,academic_year_id uuid,start_date date,end_date date,status text DEFAULT 'active',deleted_at timestamptz);
      CREATE TABLE subjects(id uuid PRIMARY KEY,school_id integer,name text,deleted_at timestamptz);
      CREATE TABLE exams(id uuid PRIMARY KEY,school_id integer,name text,exam_type text,academic_year_id uuid,start_date date,end_date date,status text DEFAULT 'completed',results_published boolean DEFAULT false,updated_at timestamptz DEFAULT now(),deleted_at timestamptz);
      CREATE TABLE exam_subjects(id uuid PRIMARY KEY,school_id integer,exam_id uuid,class_id uuid,class_section_id uuid,subject_id uuid,assessment_schema text DEFAULT 'consolidated',max_marks numeric,passing_marks numeric,exam_date date,start_time time,end_time time,deleted_at timestamptz,participation_max_marks numeric DEFAULT 10,written_work_max_marks numeric DEFAULT 10,project_work_max_marks numeric DEFAULT 10,slip_test_max_marks numeric DEFAULT 20);
      CREATE TABLE marks(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id integer,exam_subject_id uuid,student_enrollment_id uuid,marks_obtained numeric,is_absent boolean DEFAULT false,participation_marks numeric,written_work_marks numeric,project_work_marks numeric,slip_test_marks numeric,updated_at timestamptz DEFAULT now(),UNIQUE(school_id,exam_subject_id,student_enrollment_id));
      CREATE TABLE grading_scales(school_id integer,grade text,min_percentage numeric,max_percentage numeric,deleted_at timestamptz);
      CREATE TABLE school_settings(school_id integer,key text,value text,updated_at timestamptz DEFAULT now(),PRIMARY KEY(school_id,key));
      CREATE TABLE daily_attendance(school_id integer,student_enrollment_id uuid,attendance_date date,status text,deleted_at timestamptz);
      CREATE TABLE audit_logs(id uuid DEFAULT gen_random_uuid(),school_id integer,user_id uuid,action text,entity text,entity_id text,details jsonb);
      CREATE TABLE student_interventions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),school_id integer,student_id uuid,created_by uuid,assigned_to uuid,action_type text,title text,description text,target_date date,follow_up_date date,status text,baseline_metric jsonb,outcome_metric jsonb DEFAULT '{}',completed_at timestamptz,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
      INSERT INTO schools VALUES(1),(2);
    `);
    const migration = await fs.readFile(new URL('../migrations/20261115_exam_intelligence.sql', import.meta.url), 'utf8');
    for (let i = 0; i < 2; i++) await db.begin(tx => tx.unsafe(migration));
    await db.unsafe(await fs.readFile(new URL('../migrations/20260807_exam_result_publication.sql', import.meta.url), 'utf8'));
    for (const school of [1, 2]) {
      await db`INSERT INTO persons(id,school_id,display_name) VALUES(${id(school)},${school},${`Admin ${school}`})`;
      await db`INSERT INTO users(id,school_id,person_id)VALUES(${id(school)},${school},${id(school)})`;
      await db`INSERT INTO roles VALUES(${id(10 + school)},${school},'admin')`;
      await db`INSERT INTO user_roles VALUES(${id(school)},${school},${id(10 + school)})`;
      await db`INSERT INTO academic_years VALUES(${id(20 + school)},${school},'2026–27','2026-06-01','2027-04-30',NULL)`;
      await db`INSERT INTO classes VALUES(${id(30 + school)},${school},'5',5)`;
      await db`INSERT INTO sections VALUES(${id(40 + school)},${school},'A')`;
      await db`INSERT INTO class_sections VALUES(${id(50 + school)},${school},${id(30 + school)},${id(40 + school)},${id(20 + school)},NULL)`;
      await db`INSERT INTO subjects VALUES(${id(60 + school)},${school},'Mathematics',NULL)`;
      await db`INSERT INTO grading_scales VALUES(${school},'Support',0,40,NULL),(${school},'Pass',40,100,NULL)`;
      await db`INSERT INTO school_settings(school_id,key,value)VALUES(${school},'exam_intelligence_enabled','true'),(${school},'exam_intelligence_policy',${JSON.stringify({
        eligibility_confirmed: true,
        minimum_sample: 10
      })})`;
      for (let e = 0; e < 3; e++) {
        const maximum = [25, 100, 50][e],
          date = ['2026-07-01', '2026-09-01', '2026-11-01'][e];
        await db`INSERT INTO exams(id,school_id,name,exam_type,academic_year_id,start_date,end_date)VALUES(${id(school * 100 + e)},${school},${`Custom exam ${e + 1}`},'custom_school_type',${id(20 + school)},${date},${date})`;
        await db`INSERT INTO exam_subjects(id,school_id,exam_id,class_id,subject_id,max_marks,passing_marks,exam_date)VALUES(${id(school * 100 + 10 + e)},${school},${id(school * 100 + e)},${id(30 + school)},${id(60 + school)},${maximum},${maximum * .4},${date})`;
      }
      for (let i = 0; i < 14; i++) {
        const student = school * 1000 + i;
        await db`INSERT INTO persons(id,school_id,display_name) VALUES(${id(student)},${school},${i === 0 ? 'తెలుగు Learner' : `Learner ${school}-${i}`})`;
        await db`INSERT INTO students VALUES(${id(student)},${school},${id(student)},${`00${i}`},NULL)`;
        // Learner 12 leaves after July; learner 13 joins after July. Historical inactive enrollment remains eligible.
        await db`INSERT INTO student_enrollments VALUES(${id(student + 3000)},${school},${id(student)},${id(50 + school)},${id(20 + school)},${i === 13 ? '2026-08-01' : '2026-06-01'},${i === 12 ? '2026-08-01' : null},${i === 12 ? 'transferred' : 'active'},NULL)`;
        for (let e = 0; e < 3; e++) {
          if (e === 0 && i === 13 || e > 0 && i === 12) continue;
          const maximum = [25, 100, 50][e],
            score = i === 0 ? 0 : i === 1 || i === 2 ? maximum : maximum * .6;
          await db`INSERT INTO marks(school_id,exam_subject_id,student_enrollment_id,marks_obtained,is_absent,analytics_result_state)VALUES(${school},${id(school * 100 + 10 + e)},${id(student + 3000)},${i === 3 ? null : score},${i === 3},${i === 4 ? 'exempt' : i === 5 ? 'pending' : i === 6 ? 'withheld' : null})`;
        }
      }
      await db`UPDATE exams SET results_published=true WHERE school_id=${school} AND id<>${id(school * 100 + 2)}`;
    }
    mock.module('../db.js', {
      defaultExport: db
    });
    mock.module('../middleware/auth.js', {
      namedExports: {
        requireAuth: (req, res, next) => req.user ? next() : res.status(401).json({
          error: 'Unauthorized'
        }),
        requirePermission: permission => (req, res, next) => req.user?.roles.includes('admin') || req.user?.permissions.includes(permission) ? next() : res.status(403).json({
          error: 'Forbidden'
        })
      }
    });
    mock.module('../utils/asyncHandler.js', {
      namedExports: {
        asyncHandler: fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
      }
    });
    const service = await import('../services/examIntelligenceService.js');
    const {
      createExamIntelligenceRouter
    } = await import('../routes/examIntelligenceRoutes.js');
    const {
      requireSchoolId
    } = await import('../middleware/schoolId.js');
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      if (req.headers['x-test-school']) req.user = {
        id: id(Number(req.headers['x-test-school'])),
        schoolId: String(req.headers['x-test-school']),
        roles: [req.headers['x-test-role'] || 'admin'],
        permissions: []
      };
      next();
    });
    app.use(requireSchoolId);
    app.use('/api/v1/results/exam-intelligence', createExamIntelligenceRouter(db));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const root = `http://127.0.0.1:${server.address().port}/api/v1/results/exam-intelligence`;
    const request = async (path, options = {}, school = 1) => {
      const response = await fetch(`${root}${path}`, {
        ...options,
        headers: {
          'content-type': 'application/json',
          'x-test-school': String(school),
          ...options.headers
        }
      });
      return {
        status: response.status,
        body: await response.json()
      };
    };
    const filters = {
        exam_id: id(101),
        class_section_id: id(51),
        baseline_exam_id: id(100)
      },
      query = new URLSearchParams(filters);
    await t.test('migration is idempotent and new saved views deny direct authenticated access', async () => {
      const [r] = await db`SELECT relrowsecurity FROM pg_class WHERE relname='exam_intelligence_saved_views'`;
      assert.equal(r.relrowsecurity, true);
      const [grant] = await db`SELECT has_table_privilege('authenticated','exam_intelligence_saved_views','SELECT') AS allowed`;
      assert.equal(grant.allowed, false);
    });
    await t.test('actual SQL selects dated inactive learners and dynamic custom types', async () => {
      const ctx = await request('/context');
      assert.equal(ctx.status, 200);
      assert.deepEqual(ctx.body.data.exam_types, ['custom_school_type']);
      const before = await service.readSnapshot(tx => service.snapshot(1, {
        exam_id: id(100)
      }, tx), db);
      assert.ok(before.students.some(s => s.student_id === id(1012)));
      assert.ok(!before.students.some(s => s.student_id === id(1013)));
      const after = await request(`/summary?${query}`);
      assert.equal(after.status, 200);
      assert.equal(after.body.data.summary.students, 13);
      assert.equal(after.body.data.subjects[0].highest_tied_n, 2);
      assert.equal(after.body.data.subjects[0].statistics.minimum, 0);
      assert.equal(after.body.data.comparisons[0].comparison.entrants, 1);
      assert.equal(after.body.data.comparisons[0].comparison.leavers, 1);
    });
    await t.test('tenant spoofing and foreign IDs cannot select School B data', async () => {
      const spoof = await request(`/summary?${query}&school_id=2`);
      assert.equal(spoof.status, 200);
      assert.equal(spoof.body.school_id, '1');
      assert.equal((await request(`/summary?exam_id=${id(201)}`)).status, 404);
      assert.equal((await request(`/summary?exam_id=${id(101)}&class_section_id=${id(52)}`)).status, 404);
      assert.equal((await request(`/student?${query}&student_id=${id(2000)}`)).status, 404);
      assert.equal((await request('/capabilities', {
        headers: {
          'x-test-role': 'teacher'
        }
      })).status, 403);
    });
    await t.test('normalization, states, ties, privacy and unpublished results', async () => {
      const r = (await request(`/summary?${query}`)).body.data;
      assert.equal(r.subjects[0].states.assessed, 9);
      assert.equal(r.subjects[0].states.absent, 1);
      assert.equal(r.subjects[0].states.pending, 1);
      assert.equal(r.subjects[0].states.withheld, 1);
      assert.equal(r.subjects[0].states.exempt, 1);
      assert.equal(r.subjects[0].statistics.mean, 62.22222222222222);
      assert.equal(r.comparisons[0].comparison.mean_delta_pp, 0);
      assert.ok(!('records' in r.subjects[0]));
      const legacy = await service.readSnapshot(tx => service.legacyAnalyticsReport(1, filters, tx), db);
      assert.equal(legacy.subjects[0].average_percentage, r.subjects[0].statistics.mean);
      assert.equal(legacy.provenance.calculation_version, r.provenance.calculation_version);
      const tied = (await request(`/students?${query}&state=highest`)).body.data;
      assert.equal(tied.total, 2);
      const draft = (await request(`/students?exam_id=${id(102)}`)).body.data;
      assert.ok(draft.students.every(s => s.percentage === null && s.subjects.every(r => r.score === null)));
    });
    await t.test('policy changes invalidate next snapshot, saved ownership and export tenant safety', async () => {
      const saved = await request('/views', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Math',
          filters
        })
      });
      assert.equal(saved.status, 201);
      assert.equal((await request('/views', {}, 2)).body.data.length, 0);
      assert.equal((await request(`/views/${saved.body.data.id}`, {
        method: 'DELETE'
      }, 2)).status, 404);
      assert.equal((await request('/views', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Foreign',
          filters: {
            exam_id: id(201)
          }
        })
      })).status, 404);
      const changed = await request('/configuration', {
        method: 'PUT',
        body: JSON.stringify({
          policy: {
            eligibility_confirmed: false
          }
        })
      });
      assert.equal(changed.status, 200);
      assert.equal((await request(`/summary?${query}`)).body.data.summary.mean_percentage, null);
      await request('/configuration', {
        method: 'PUT',
        body: JSON.stringify({
          policy: {
            eligibility_confirmed: true
          }
        })
      });
      assert.equal((await request('/configuration', {
        method: 'PUT',
        body: JSON.stringify({
          policy: {
            required_subject_ids: [id(62)]
          }
        })
      })).status, 404);
      const workbook = await request(`/export?${query}&include_students=true&format=xlsx`);
      assert.equal(workbook.status, 200);
      const imported = await import('xlsx'),
        XLSX = imported.default || imported;
      const sheet = XLSX.read(workbook.body.data.content_base64, {
        type: 'base64'
      }).Sheets['Exam evidence'];
      const exported = XLSX.utils.sheet_to_json(sheet, {
        header: 1
      });
      const heading = exported.findIndex(row => row[0] === 'Student ID');
      assert.equal(exported[heading + 1][1], '000');
      const csv = await request(`/export?${query}&include_students=true`);
      assert.equal(csv.status, 200);
      assert.ok(csv.body.data.csv.includes('తెలుగు'));
      assert.ok(!csv.body.data.csv.includes('Learner 2-'));
    });
    await t.test('support plans retain evidence, owner validation and compatible follow-up', async () => {
      const body = {
        filters: {
          ...filters,
          student_id: id(1000)
        },
        title: 'Practice support',
        description: 'Review worked examples',
        measurable_objective: 'Reach configured pass mark',
        target_date: '2026-12-01'
      };
      assert.equal((await request('/actions', {
        method: 'POST',
        body: JSON.stringify({
          ...body,
          assigned_to: id(2)
        })
      })).status, 404);
      const created = await request('/actions', {
        method: 'POST',
        body: JSON.stringify(body)
      });
      assert.equal(created.status, 201);
      const action = created.body.data.created[0].id;
      assert.equal((await request(`/actions/${action}`, {
        method: 'PATCH',
        body: JSON.stringify({
          note: 'Foreign'
        })
      }, 2)).status, 404);
      await db`UPDATE exams SET results_published=true WHERE id=${id(102)}`;
      assert.equal((await request(`/actions/${action}`, {
        method: 'PATCH',
        body: JSON.stringify({
          follow_up_exam_id: id(100)
        })
      })).status, 400);
      const updated = await request(`/actions/${action}`, {
        method: 'PATCH',
        body: JSON.stringify({
          note: 'Reviewed work',
          follow_up_exam_id: id(102),
          status: 'FOLLOW_UP'
        })
      });
      assert.equal(updated.status, 200);
      assert.equal(updated.body.data.academic_progress_notes.length, 1);
      await db.begin(async tx => {
        await tx`UPDATE student_enrollments SET end_date='2026-09-15' WHERE id=${id(4000)}`;
        const leaver = await service.updateAction(1, id(1), action, {
          follow_up_exam_id: id(102)
        }, tx);
        assert.equal(leaver.outcome_metric.attrition_n, 1);
        assert.equal(leaver.outcome_metric.matched_n, 0);
        throw Object.assign(new Error('rollback attrition fixture'), {
          attritionFixture: true
        });
      }).catch(error => {
        if (!error.attritionFixture) throw error;
      });
      const listed = (await request(`/actions?student_id=${id(1000)}`)).body.data;
      assert.equal(listed.length, 1);
      assert.equal(listed[0].academic_context.subjects[0].percentage, 0);
    });
    await t.test('private academic plans cannot be read by legacy staff APIs or direct authenticated access', async () => {
      mock.module('../services/automationEventService.js', {
        namedExports: {
          emitSchoolEvent: () => {},
          AUTOMATION_EVENTS: {}
        }
      });
      mock.module('../services/intelligence/intelligenceNotificationService.js', {
        namedExports: {
          notifyInterventionAssigned: async () => {}
        }
      });
      const legacy = await import('../services/intelligence/interventionService.js');
      const oldList = await legacy.getInterventions({
        schoolId: 1,
        studentId: id(1000)
      });
      assert.equal(oldList.total, 0);
      assert.equal(oldList.items.length, 0);
      await db.unsafe(`GRANT USAGE ON SCHEMA public TO authenticated; GRANT SELECT ON student_interventions TO authenticated;
        CREATE POLICY fixture_legacy_read ON student_interventions FOR SELECT TO authenticated USING(true);`);
      await db.begin(async tx => {
        await tx`SET LOCAL ROLE authenticated`;
        const [{
          n
        }] = await tx`SELECT count(*)::int AS n FROM student_interventions`;
        assert.equal(n, 0);
      });
    });
    await t.test('publication lock and explicit unpublish/revision refresh', async () => {
      const priorRevision = (await request(`/summary?${query}`)).body.data.provenance.source_revision;
      await assert.rejects(db`UPDATE marks SET marks_obtained=70 WHERE school_id=1 AND exam_subject_id=${id(111)} AND student_enrollment_id=${id(4000)}`, /Published results are locked/);
      await db`UPDATE exams SET results_published=false WHERE id=${id(101)}`;
      assert.equal((await request(`/summary?${query}`)).body.data.subjects[0].statistics.n, 0);
      await db`UPDATE marks SET marks_obtained=70 WHERE school_id=1 AND exam_subject_id=${id(111)} AND student_enrollment_id=${id(4000)}`;
      await db`UPDATE exams SET results_published=true WHERE id=${id(101)}`;
      const revised = (await request(`/summary?${query}`)).body.data;
      assert.equal(revised.subjects[0].statistics.minimum, 60);
      assert.notEqual(revised.provenance.source_revision, priorRevision);
    });
    await t.test('representative local school workload is bounded and measured', async () => {
      // 40 classes × 30 learners × 8 subjects = 9,600 scheduled published results.
      // This is the disposable local database only; rollback keeps the small acceptance fixture intact.
      let measurement;
      await db.begin(async tx => {
        await tx`UPDATE exams SET results_published=false WHERE id=${id(102)}`;
        for (let c = 0; c < 40; c++) {
          const classId = id(10000 + c),
            sectionId = id(11000 + c),
            classSectionId = id(12000 + c);
          await tx`INSERT INTO classes VALUES(${classId},1,${`Grade ${c + 1}`},${c})`;
          await tx`INSERT INTO sections VALUES(${sectionId},1,'A')`;
          await tx`INSERT INTO class_sections VALUES(${classSectionId},1,${classId},${sectionId},${id(21)},NULL)`;
          for (let subject = 0; subject < 8; subject++) {
            const subjectId = id(13000 + subject),
              paperId = id(14000 + c * 8 + subject);
            await tx`INSERT INTO subjects VALUES(${subjectId},1,${`Subject ${subject + 1}`},NULL) ON CONFLICT DO NOTHING`;
            await tx`INSERT INTO exam_subjects(id,school_id,exam_id,class_id,subject_id,max_marks,passing_marks,exam_date) VALUES(${paperId},1,${id(102)},${classId},${subjectId},100,40,'2026-11-01')`;
          }
          for (let learner = 0; learner < 30; learner++) {
            const studentId = id(20000 + c * 30 + learner),
              enrollmentId = id(30000 + c * 30 + learner);
            await tx`INSERT INTO persons(id,school_id,display_name)VALUES(${studentId},1,${`Fixture ${c}-${learner}`})`;
            await tx`INSERT INTO students VALUES(${studentId},1,${studentId},${`FIX-${c}-${learner}`},NULL)`;
            await tx`INSERT INTO student_enrollments(id,school_id,student_id,class_section_id,academic_year_id,start_date)VALUES(${enrollmentId},1,${studentId},${classSectionId},${id(21)},'2026-06-01')`;
            await tx`INSERT INTO marks(school_id,exam_subject_id,student_enrollment_id,marks_obtained)SELECT 1,id,${enrollmentId},${learner * 7 % 101} FROM exam_subjects WHERE school_id=1 AND exam_id=${id(102)} AND class_id=${classId}`;
          }
        }
        await tx`UPDATE exams SET results_published=true WHERE id=${id(102)}`;
        const started = performance.now(),
          full = await service.report(1, {
            exam_id: id(102)
          }, tx),
          data = service.publicReport(full),
          elapsed = performance.now() - started;
        const students = service.studentRows(full, {
            limit: 25
          }),
          gzip = gzipSync(JSON.stringify(data)).length;
        assert.equal(full.current.students.length, 1213);
        assert.equal(students.students.length, 25);
        measurement = {
          scheduled_results: 9613,
          students: 1213,
          subjects: data.subjects.length,
          summary_server_ms: elapsed,
          summary_gzip_bytes: gzip,
          summary_json_bytes: JSON.stringify(data).length,
          detail_page_rows: students.students.length,
          environment: 'Local Postgres, warm process, no network throttling/device rendering; not production SLA evidence'
        };
        throw Object.assign(new Error('rollback performance fixture'), {
          performanceFixture: true
        });
      }).catch(error => {
        if (!error.performanceFixture) throw error;
      });
      await fs.writeFile(new URL('../docs/exam-intelligence/verification/representative-performance.json', import.meta.url), JSON.stringify(measurement, null, 2));
      t.diagnostic(`Representative summary: ${measurement.summary_server_ms.toFixed(1)}ms server, ${measurement.summary_gzip_bytes} gzip bytes for 1,213 learners.`);
    });
    await t.test('search, individual comparisons, trend explorer and evidence reports reauthorize scope', async () => {
      const hits = await request(`/search?${query}&search=Learner`);
      assert.equal(hits.status, 200);
      assert.ok(hits.body.data.every(hit => !hit.label.includes('Learner 2-')));
      const peer = await request(`/student-comparison?${query}&student_id=${id(1000)}&peer_id=${id(1001)}`);
      assert.equal(peer.status, 200);
      assert.equal(peer.body.data.subjects[0].difference_pp, -30);
      assert.equal((await request(`/student-comparison?${query}&student_id=${id(1000)}&peer_id=${id(2001)}`)).status, 404);
      const trend = await request(`/trends?${query}`);
      assert.equal(trend.status, 200);
      assert.equal(trend.body.data.points.length, 2);
      const individual = await request(`/export?${query}&student_id=${id(1000)}`);
      assert.equal(individual.status, 200);
      assert.equal(individual.body.data.student.student.student_id, id(1000));
      assert.equal(individual.body.data.actions.length, 1);
    });
    await t.test('a transfer resolves each subject against its actual assessment-time section', async () => {
      await db.begin(async tx => {
        await tx`INSERT INTO sections VALUES(${id(43)},1,'B')`;
        await tx`INSERT INTO class_sections VALUES(${id(53)},1,${id(31)},${id(43)},${id(21)},NULL)`;
        await tx`INSERT INTO persons(id,school_id,display_name)VALUES(${id(8000)},1,'Transfer fixture')`;
        await tx`INSERT INTO students VALUES(${id(8000)},1,${id(8000)},'TR-001',NULL)`;
        await tx`INSERT INTO student_enrollments VALUES(${id(8001)},1,${id(8000)},${id(51)},${id(21)},'2026-06-01','2026-08-31','transferred',NULL),(${id(8002)},1,${id(8000)},${id(53)},${id(21)},'2026-09-01',NULL,'active',NULL)`;
        await tx`UPDATE exams SET results_published=false WHERE id IN (${id(100)},${id(101)})`;
        await tx`INSERT INTO marks(school_id,exam_subject_id,student_enrollment_id,marks_obtained)VALUES(1,${id(110)},${id(8001)},25),(1,${id(111)},${id(8002)},50)`;
        await tx`UPDATE exams SET results_published=true WHERE id IN (${id(100)},${id(101)})`;
        const profile = await service.studentProfile(1, {
          exam_id: id(101),
          class_section_id: id(53),
          student_id: id(8000)
        }, tx);
        assert.equal(profile.student.rank, null);
        assert.equal(profile.subjects[0].benchmark.n, 1);
        assert.equal(profile.subjects[0].change_pp, -50);
        assert.equal(profile.timeline[0].class_section_id, id(51));
        assert.equal(profile.timeline[1].class_section_id, id(53));
        throw Object.assign(new Error('rollback transfer fixture'), {
          transferFixture: true
        });
      }).catch(error => {
        if (!error.transferFixture) throw error;
      });
    });
    await t.test('a mid-exam transfer keeps each paper cohort and suppresses incomplete overall claims', async () => {
      await db.begin(async tx => {
        await tx`INSERT INTO sections VALUES(${id(44)},1,'C')`;
        await tx`INSERT INTO class_sections VALUES(${id(54)},1,${id(31)},${id(44)},${id(21)},NULL)`;
        await tx`INSERT INTO persons(id,school_id,display_name)VALUES(${id(9000)},1,'Mid-exam transfer')`;
        await tx`INSERT INTO students VALUES(${id(9000)},1,${id(9000)},'TR-MID',NULL)`;
        await tx`INSERT INTO student_enrollments VALUES(${id(9001)},1,${id(9000)},${id(51)},${id(21)},'2026-06-01','2026-07-02','transferred',NULL),(${id(9002)},1,${id(9000)},${id(54)},${id(21)},'2026-07-03',NULL,'active',NULL)`;
        await tx`UPDATE exams SET results_published=false WHERE id=${id(100)}`;
        await tx`INSERT INTO subjects VALUES(${id(9003)},1,'English',NULL)`;
        await tx`INSERT INTO exam_subjects(id,school_id,exam_id,class_id,subject_id,max_marks,passing_marks,exam_date)VALUES(${id(9004)},1,${id(100)},${id(31)},${id(9003)},100,40,'2026-07-03')`;
        await tx`INSERT INTO marks(school_id,exam_subject_id,student_enrollment_id,marks_obtained)VALUES(1,${id(110)},${id(9001)},25),(1,${id(9004)},${id(9002)},50)`;
        await tx`UPDATE exams SET results_published=true WHERE id=${id(100)}`;
        const classScope = await service.snapshot(1, {
          exam_id: id(100),
          class_section_id: id(51)
        }, tx);
        assert.equal(classScope.students.find(s => s.student_id === id(9000)).percentage, null);
        const profile = await service.studentProfile(1, {
          exam_id: id(100),
          class_section_id: id(51),
          student_id: id(9000)
        }, tx);
        assert.equal(profile.student.percentage, null);
        assert.equal(profile.student.rank, null);
        assert.equal(profile.subjects.length, 2);
        const math = profile.subjects.find(s => s.subject_name === 'Mathematics'),
          english = profile.subjects.find(s => s.subject_name === 'English');
        assert.equal(math.percentage, 100);
        assert.equal(math.class_section_id, id(51));
        assert.equal(english.percentage, 50);
        assert.equal(english.class_section_id, id(54));
        assert.equal(english.benchmark.n, 1);
        throw Object.assign(new Error('rollback mid-exam transfer'), {
          midTransferFixture: true
        });
      }).catch(error => {
        if (!error.midTransferFixture) throw error;
      });
    });
    await t.test('snapshot timing, compressed payload and query plan are measured locally', async () => {
      const start = performance.now(),
        data = await request(`/summary?${query}`),
        elapsed = performance.now() - start,
        bytes = gzipSync(JSON.stringify(data.body)).length;
      assert.equal(data.status, 200);
      assert.ok(bytes < 40960);
      const plan = await db`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT m.id FROM marks m JOIN exam_subjects p ON p.id=m.exam_subject_id AND p.school_id=1 WHERE m.school_id=1 AND p.exam_id=${id(101)}`;
      const metrics = {
        fixture: '2 schools, 3 exams each, 28 learners',
        summary_http_ms: elapsed,
        summary_gzip_bytes: bytes,
        query_plan: plan
      };
      await fs.mkdir(new URL('../docs/exam-intelligence/verification/', import.meta.url), {
        recursive: true
      });
      await fs.writeFile(new URL('../docs/exam-intelligence/verification/local-performance.json', import.meta.url), JSON.stringify(metrics, null, 2));
      t.diagnostic(`Summary ${elapsed.toFixed(1)}ms, ${bytes} bytes gzip (small local fixture; not a production/device benchmark)`);
    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await db.end();
  }
});
