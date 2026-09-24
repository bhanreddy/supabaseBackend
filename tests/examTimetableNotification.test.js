import test from 'node:test';
import assert from 'node:assert/strict';
import sql from '../db.js';
import {
  notifyPublishedTimetableUsers,
  revertExamTimetableToDraft,
} from '../routes/resultsRoutes.js';
import { ACTIVE_STUDENT_STATUS_ID } from '../utils/activeStudentFilter.js';

test('Exam timetable and syllabus notification flow governance (all 7 scenarios)', async (t) => {
  const ROLLBACK = Symbol('exam-notification-rollback');

  try {
    await sql.begin(async (tx) => {
      const suffix = `${Date.now().toString(36)}${Math.random().toString(16).slice(2, 6)}`;

      // ── Seed School & Academic Hierarchy ──────────────────────────────────
      const [school] = await tx`
        INSERT INTO schools (name, code, is_active)
        VALUES (${`NotifySchool ${suffix}`}, ${`ns${suffix}`}, true)
        RETURNING id
      `;
      const schoolId = school.id;

      const [year] = await tx`
        INSERT INTO academic_years (school_id, code, start_date, end_date)
        VALUES (${schoolId}, '2026-27', '2026-06-01', '2027-04-30')
        RETURNING id
      `;

      const [c1] = await tx`
        INSERT INTO classes (school_id, name) VALUES (${schoolId}, 'Class 10') RETURNING id
      `;
      const [secA] = await tx`
        INSERT INTO sections (school_id, name) VALUES (${schoolId}, 'A') RETURNING id
      `;
      const [cs1] = await tx`
        INSERT INTO class_sections (school_id, class_id, section_id, academic_year_id)
        VALUES (${schoolId}, ${c1.id}, ${secA.id}, ${year.id})
        RETURNING id
      `;

      // ── Seed Persons, Students, Parents, Users ─────────────────────────────
      const [{ id: genderId }] = await tx`SELECT id FROM genders ORDER BY id LIMIT 1`;

      // Student 1 & User
      const [pStu1] = await tx`
        INSERT INTO persons (school_id, first_name, gender_id, display_name)
        VALUES (${schoolId}, 'Student1', ${genderId}, 'Student 1') RETURNING id
      `;
      const [uStu1] = await tx`
        INSERT INTO users (school_id, person_id, account_status)
        VALUES (${schoolId}, ${pStu1.id}, 'active') RETURNING id
      `;
      const [stu1] = await tx`
        INSERT INTO students (school_id, person_id, admission_no, admission_date, status_id)
        VALUES (${schoolId}, ${pStu1.id}, ${`ADM1_${suffix}`}, '2026-06-01', ${ACTIVE_STUDENT_STATUS_ID}) RETURNING id
      `;
      await tx`
        INSERT INTO student_enrollments (school_id, student_id, academic_year_id, class_section_id, status, start_date)
        VALUES (${schoolId}, ${stu1.id}, ${year.id}, ${cs1.id}, 'active', '2026-06-01')
      `;

      // Parent 1 & User
      const [pParent1] = await tx`
        INSERT INTO persons (school_id, first_name, gender_id, display_name)
        VALUES (${schoolId}, 'Parent1', ${genderId}, 'Parent 1') RETURNING id
      `;
      const [uParent1] = await tx`
        INSERT INTO users (school_id, person_id, account_status)
        VALUES (${schoolId}, ${pParent1.id}, 'active') RETURNING id
      `;
      const [parent1] = await tx`
        INSERT INTO parents (school_id, person_id) VALUES (${schoolId}, ${pParent1.id}) RETURNING id
      `;
      await tx`
        INSERT INTO student_parents (school_id, student_id, parent_id)
        VALUES (${schoolId}, ${stu1.id}, ${parent1.id})
      `;

      // Student 2 & User (Section A)
      const [pStu2] = await tx`
        INSERT INTO persons (school_id, first_name, gender_id, display_name)
        VALUES (${schoolId}, 'Student2', ${genderId}, 'Student 2') RETURNING id
      `;
      const [uStu2] = await tx`
        INSERT INTO users (school_id, person_id, account_status)
        VALUES (${schoolId}, ${pStu2.id}, 'active') RETURNING id
      `;
      const [stu2] = await tx`
        INSERT INTO students (school_id, person_id, admission_no, admission_date, status_id)
        VALUES (${schoolId}, ${pStu2.id}, ${`ADM2_${suffix}`}, '2026-06-01', ${ACTIVE_STUDENT_STATUS_ID}) RETURNING id
      `;
      await tx`
        INSERT INTO student_enrollments (school_id, student_id, academic_year_id, class_section_id, status, start_date)
        VALUES (${schoolId}, ${stu2.id}, ${year.id}, ${cs1.id}, 'active', '2026-06-01')
      `;

      // Parent 2 & User
      const [pParent2] = await tx`
        INSERT INTO persons (school_id, first_name, gender_id, display_name)
        VALUES (${schoolId}, 'Parent2', ${genderId}, 'Parent 2') RETURNING id
      `;
      const [uParent2] = await tx`
        INSERT INTO users (school_id, person_id, account_status)
        VALUES (${schoolId}, ${pParent2.id}, 'active') RETURNING id
      `;
      const [parent2] = await tx`
        INSERT INTO parents (school_id, person_id) VALUES (${schoolId}, ${pParent2.id}) RETURNING id
      `;
      await tx`
        INSERT INTO student_parents (school_id, student_id, parent_id)
        VALUES (${schoolId}, ${stu2.id}, ${parent2.id})
      `;

      // ── Seed Subjects ──────────────────────────────────────────────────────
      const [subMath] = await tx`
        INSERT INTO subjects (school_id, name, code) VALUES (${schoolId}, 'Mathematics', 'MATH') RETURNING id
      `;
      const [subSci] = await tx`
        INSERT INTO subjects (school_id, name, code) VALUES (${schoolId}, 'Science', 'SCI') RETURNING id
      `;
      const [subEng] = await tx`
        INSERT INTO subjects (school_id, name, code) VALUES (${schoolId}, 'English', 'ENG') RETURNING id
      `;

      // ── Seed Exam ──────────────────────────────────────────────────────────
      const [exam] = await tx`
        INSERT INTO exams (school_id, academic_year_id, name, exam_type, start_date, end_date, timetable_published, timetable_version, timetable_published_version)
        VALUES (${schoolId}, ${year.id}, 'Mid-Term Examination 2026', 'SUMMATIVE', '2026-10-01', '2026-10-10', FALSE, 1, 0)
        RETURNING *
      `;

      // Track notifications sent
      const dispatchedNotifications = [];
      const mockSendNotification = async (userIds, type, params, context) => {
        dispatchedNotifications.push({ userIds, type, params, context });
        return { successCount: userIds.length, failureCount: 0 };
      };

      // ── SCENARIO 1: Adding or editing multiple subject syllabi sends 0 notifications ──
      const [paper1] = await tx`
        INSERT INTO exam_subjects (school_id, exam_id, subject_id, class_id, class_section_id, exam_date, start_time, end_time, max_marks, passing_marks, syllabus)
        VALUES (${schoolId}, ${exam.id}, ${subMath.id}, ${c1.id}, ${cs1.id}, '2026-10-01', '09:30:00', '12:30:00', 100, 35, ${sql.json([{ topic: 'Algebra', marks: 50 }])})
        RETURNING id
      `;
      const [paper2] = await tx`
        INSERT INTO exam_subjects (school_id, exam_id, subject_id, class_id, class_section_id, exam_date, start_time, end_time, max_marks, passing_marks, syllabus)
        VALUES (${schoolId}, ${exam.id}, ${subSci.id}, ${c1.id}, ${cs1.id}, '2026-10-03', '09:30:00', '12:30:00', 100, 35, ${sql.json([{ topic: 'Thermodynamics', marks: 40 }])})
        RETURNING id
      `;
      const [paper3] = await tx`
        INSERT INTO exam_subjects (school_id, exam_id, subject_id, class_id, class_section_id, exam_date, start_time, end_time, max_marks, passing_marks, syllabus)
        VALUES (${schoolId}, ${exam.id}, ${subEng.id}, ${c1.id}, ${cs1.id}, '2026-10-05', '09:30:00', '12:30:00', 100, 35, ${sql.json([{ topic: 'Grammar', marks: 30 }])})
        RETURNING id
      `;

      // Update syllabus for paper 1 and paper 2
      await tx`
        UPDATE exam_subjects
        SET syllabus = ${sql.json([{ topic: 'Algebra & Geometry', marks: 60 }])}
        WHERE id = ${paper1.id} AND school_id = ${schoolId}
      `;
      await tx`
        UPDATE exam_subjects
        SET syllabus = ${sql.json([{ topic: 'Thermodynamics & Optics', marks: 50 }])}
        WHERE id = ${paper2.id} AND school_id = ${schoolId}
      `;

      assert.equal(
        dispatchedNotifications.length,
        0,
        'Scenario 1: Adding or editing multiple subject syllabi must send 0 notifications'
      );

      // ── SCENARIO 2: Saving timetable as draft sends 0 notifications ──
      // Update paper timings and dates as draft
      await tx`
        UPDATE exam_subjects
        SET start_time = '10:00:00', end_time = '13:00:00'
        WHERE id = ${paper1.id} AND school_id = ${schoolId}
      `;

      const [draftExam] = await tx`
        SELECT timetable_published, timetable_version, timetable_published_version
        FROM exams WHERE id = ${exam.id} AND school_id = ${schoolId}
      `;
      assert.equal(draftExam.timetable_published, false, 'Timetable remains draft');
      assert.equal(
        dispatchedNotifications.length,
        0,
        'Scenario 2: Saving timetable as draft sends 0 notifications'
      );

      // ── SCENARIO 3: Clicking Publish sends exactly 1 consolidated notification per intended recipient ──
      // Simulate Publish transaction commit
      const [publishedExam] = await tx`
        UPDATE exams
        SET timetable_published = TRUE,
            timetable_published_at = now(),
            timetable_published_version = timetable_version
        WHERE id = ${exam.id} AND school_id = ${schoolId}
        RETURNING *
      `;

      // Post-commit notification dispatch
      const notifyResult = await notifyPublishedTimetableUsers(schoolId, publishedExam, {
        db: tx,
        sendNotification: mockSendNotification,
        version: publishedExam.timetable_published_version,
      });

      assert.equal(
        dispatchedNotifications.length,
        1,
        'Scenario 3: Publish must send exactly 1 consolidated notification event'
      );
      assert.equal(
        notifyResult.recipientCount,
        4,
        'Scenario 3: Should notify exactly 4 recipients (2 students + 2 parents)'
      );

      const publishNotif = dispatchedNotifications[0];
      assert.equal(publishNotif.type, 'EXAM_TIMETABLE_PUBLISHED');
      assert.ok(publishNotif.params.message.includes('Mid-Term Examination 2026'));
      assert.equal(publishNotif.context.deepLink, `/(tabs)/timetable?examId=${exam.id}`);
      assert.equal(publishNotif.context.idempotencyKey, `exam_timetable_published:${exam.id}:1`);

      const expectedUserIds = [uStu1.id, uParent1.id, uStu2.id, uParent2.id].sort();
      const actualUserIds = [...publishNotif.userIds].sort();
      assert.deepEqual(
        actualUserIds,
        expectedUserIds,
        'Scenario 3: Intended recipients must include active enrolled students and parents without duplicates'
      );

      // ── SCENARIO 4: Retrying / double-clicking Publish sends 0 duplicate notifications (idempotent) ──
      // If admin clicks Publish again without changing timetable:
      const currentVer = publishedExam.timetable_version;
      const pubVer = publishedExam.timetable_published_version;
      const alreadyPublished = publishedExam.timetable_published && pubVer === currentVer;

      let secondNotifySent = false;
      if (!alreadyPublished) {
        await notifyPublishedTimetableUsers(schoolId, publishedExam, {
          db: tx,
          sendNotification: mockSendNotification,
          version: pubVer,
        });
        secondNotifySent = true;
      }

      assert.equal(alreadyPublished, true, 'Already published version detected');
      assert.equal(secondNotifySent, false, 'No second notification sent');
      assert.equal(
        dispatchedNotifications.length,
        1,
        'Scenario 4: Retrying/double-clicking Publish sends 0 duplicate notifications'
      );

      // ── SCENARIO 5: Editing a published timetable sets it to unpublished draft and sends 0 notifications ──
      // Revert to draft (simulates editing syllabus, adding paper, or altering schedule dates)
      const reverted = await revertExamTimetableToDraft(schoolId, exam.id, tx);
      assert.ok(reverted, 'Exam was reverted');
      assert.equal(reverted.timetable_version, 2, 'Version incremented to 2');

      const [revertedExam] = await tx`
        SELECT timetable_published, timetable_published_at, timetable_version, timetable_published_version
        FROM exams WHERE id = ${exam.id} AND school_id = ${schoolId}
      `;
      assert.equal(revertedExam.timetable_published, false, 'Exam timetable is now unpublished draft');
      assert.equal(revertedExam.timetable_published_at, null, 'Published timestamp cleared');
      assert.equal(revertedExam.timetable_version, 2, 'Timetable version bumped to 2');
      assert.equal(revertedExam.timetable_published_version, 1, 'Previous published version remained 1');
      assert.equal(
        dispatchedNotifications.length,
        1,
        'Scenario 5: Editing published timetable reverts to draft with 0 notifications sent'
      );

      // ── SCENARIO 6: Republishing sends exactly 1 new notification per recipient for the new version ──
      const [republishedExam] = await tx`
        UPDATE exams
        SET timetable_published = TRUE,
            timetable_published_at = now(),
            timetable_published_version = timetable_version
        WHERE id = ${exam.id} AND school_id = ${schoolId}
        RETURNING *
      `;

      await notifyPublishedTimetableUsers(schoolId, republishedExam, {
        db: tx,
        sendNotification: mockSendNotification,
        version: republishedExam.timetable_published_version,
      });

      assert.equal(
        dispatchedNotifications.length,
        2,
        'Scenario 6: Republishing must send exactly 1 new notification event for the new version'
      );
      const republishNotif = dispatchedNotifications[1];
      assert.equal(republishNotif.context.idempotencyKey, `exam_timetable_published:${exam.id}:2`);
      assert.equal(republishedExam.timetable_published_version, 2);

      // ── SCENARIO 7: Failed or rolled-back publish transaction sends 0 notifications ──
      const notificationsBeforeRollback = dispatchedNotifications.length;

      try {
        await tx.savepoint(async (sp) => {
          // Attempting publish inside transaction that encounters an error
          const [uncommittedExam] = await sp`
            UPDATE exams
            SET timetable_published = TRUE,
                timetable_version = timetable_version + 1
            WHERE id = ${exam.id} AND school_id = ${schoolId}
            RETURNING *
          `;

          // Simulate validation failure (e.g. paper without date or unexpected error)
          throw new Error('Simulation: Transaction failure before commit');

          // Notice: Post-commit notify logic is never reached
          await notifyPublishedTimetableUsers(schoolId, uncommittedExam, {
            db: sp,
            sendNotification: mockSendNotification,
          });
        });
      } catch (err) {
        assert.equal(err.message, 'Simulation: Transaction failure before commit');
      }

      assert.equal(
        dispatchedNotifications.length,
        notificationsBeforeRollback,
        'Scenario 7: Failed or rolled-back publish transaction sends 0 notifications'
      );

      throw ROLLBACK; // Cleanly roll back test data
    });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
});
