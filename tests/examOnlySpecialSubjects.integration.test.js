import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import sql from '../db.js';
import { getExamResultReadiness } from '../services/examResultPublishingService.js';
import { generateExamTimetable } from '../services/examTimetableService.js';
import {
  ExamOnlySubjectError,
  authorizeExamOnlyMarkRow,
  listClassTeacherSpecialAssignments,
  loadLegacyExamOnlyMarks,
  replaceExamOnlySubjects,
  resolveLegacyExamOnlyContext,
  saveLegacyExamOnlyUpload,
} from '../services/examOnlySubjectService.js';

const migrationSql = fs.readFileSync(
  new URL('../migrations/20260926_exam_only_special_subjects.sql', import.meta.url),
  'utf8',
);

test('exam-only special subjects stay compatible with the legacy marks contract', async () => {
  await sql.unsafe(migrationSql);
  const suffix = `${Date.now().toString(36)}${Math.random().toString(16).slice(2, 6)}`;

  try {
    await sql.begin(async (tx) => {
      const [school] = await tx`
        INSERT INTO schools (name, code, is_active)
        VALUES (${`Special ${suffix}`}, ${`sp${suffix}`.slice(0, 20)}, true)
        RETURNING id
      `;
      const [otherSchool] = await tx`
        INSERT INTO schools (name, code, is_active)
        VALUES (${`Special B ${suffix}`}, ${`sb${suffix}`.slice(0, 20)}, true)
        RETURNING id
      `;
      const schoolId = school.id;
      const [year] = await tx`
        INSERT INTO academic_years (school_id, code, start_date, end_date)
        VALUES (${schoolId}, ${`Y${suffix}`.slice(0, 20)}, '2026-06-01', '2027-04-30')
        RETURNING id
      `;
      const [klass] = await tx`
        INSERT INTO classes (school_id, name) VALUES (${schoolId}, 'Class 4') RETURNING id
      `;
      const [otherClass] = await tx`
        INSERT INTO classes (school_id, name) VALUES (${otherSchool.id}, 'Class 9') RETURNING id
      `;
      const [sectionA] = await tx`INSERT INTO sections (school_id, name) VALUES (${schoolId}, 'A') RETURNING id`;
      const [sectionB] = await tx`INSERT INTO sections (school_id, name) VALUES (${schoolId}, 'B') RETURNING id`;
      const [sectionC] = await tx`INSERT INTO sections (school_id, name) VALUES (${schoolId}, 'C') RETURNING id`;
      const [secA] = await tx`
        INSERT INTO class_sections (school_id, class_id, section_id, academic_year_id)
        VALUES (${schoolId}, ${klass.id}, ${sectionA.id}, ${year.id}) RETURNING id
      `;
      const [secB] = await tx`
        INSERT INTO class_sections (school_id, class_id, section_id, academic_year_id)
        VALUES (${schoolId}, ${klass.id}, ${sectionB.id}, ${year.id}) RETURNING id
      `;
      const [secC] = await tx`
        INSERT INTO class_sections (school_id, class_id, section_id, academic_year_id)
        VALUES (${schoolId}, ${klass.id}, ${sectionC.id}, ${year.id}) RETURNING id
      `;

      const [{ id: genderId }] = await tx`SELECT id FROM genders ORDER BY id LIMIT 1`;
      const makePerson = async (name) => {
        const [person] = await tx`
          INSERT INTO persons (school_id, first_name, gender_id, display_name)
          VALUES (${schoolId}, ${name}, ${genderId}, ${name}) RETURNING id
        `;
        return person;
      };
      const teacherAPerson = await makePerson('Teacher A');
      const teacherBPerson = await makePerson('Teacher B');
      const strangerPerson = await makePerson('Subject Teacher');
      const [teacherA] = await tx`
        INSERT INTO staff (school_id, person_id, staff_code, joining_date)
        VALUES (${schoolId}, ${teacherAPerson.id}, ${`TA${suffix}`.slice(0, 20)}, '2026-06-01')
        RETURNING id
      `;
      const [teacherB] = await tx`
        INSERT INTO staff (school_id, person_id, staff_code, joining_date)
        VALUES (${schoolId}, ${teacherBPerson.id}, ${`TB${suffix}`.slice(0, 20)}, '2026-06-01')
        RETURNING id
      `;
      const [stranger] = await tx`
        INSERT INTO staff (school_id, person_id, staff_code, joining_date)
        VALUES (${schoolId}, ${strangerPerson.id}, ${`TS${suffix}`.slice(0, 20)}, '2026-06-01')
        RETURNING id
      `;
      const [userA] = await tx`
        INSERT INTO users (school_id, person_id) VALUES (${schoolId}, ${teacherAPerson.id}) RETURNING id
      `;
      const [userB] = await tx`
        INSERT INTO users (school_id, person_id) VALUES (${schoolId}, ${teacherBPerson.id}) RETURNING id
      `;
      await tx`
        UPDATE class_sections SET class_teacher_id = ${teacherA.id} WHERE id = ${secA.id}
      `;
      await tx`
        UPDATE class_sections SET class_teacher_id = ${teacherA.id} WHERE id = ${secB.id}
      `;
      await tx`
        UPDATE class_sections SET class_teacher_id = ${teacherB.id} WHERE id = ${secC.id}
      `;

      const [{ id: statusId }] = await tx`SELECT id FROM student_statuses WHERE id = 1`;
      const makeStudent = async (sectionId, name) => {
        const person = await makePerson(name);
        const [student] = await tx`
          INSERT INTO students (school_id, person_id, admission_no, admission_date, status_id)
          VALUES (${schoolId}, ${person.id}, ${`${name}${suffix}`.slice(0, 30)}, '2026-06-01', ${statusId})
          RETURNING id
        `;
        const [enrollment] = await tx`
          INSERT INTO student_enrollments (
            school_id, student_id, academic_year_id, class_section_id, start_date, status
          )
          VALUES (${schoolId}, ${student.id}, ${year.id}, ${sectionId}, '2026-06-01', 'active')
          RETURNING id
        `;
        return { student, enrollment };
      };
      const studentA = await makeStudent(secA.id, 'Asha');
      const studentB = await makeStudent(secB.id, 'Bina');
      const studentC = await makeStudent(secC.id, 'Chitra');

      const [legacySubject] = await tx`
        INSERT INTO subjects (school_id, name, code, is_exam_only)
        VALUES (${schoolId}, 'Drawing', ${`DR${suffix}`.slice(0, 20)}, false)
        RETURNING id
      `;
      const [exam] = await tx`
        INSERT INTO exams (school_id, name, academic_year_id, exam_type, status)
        VALUES (${schoolId}, 'Special-1', ${year.id}, 'special', 'scheduled')
        RETURNING id, exam_type, academic_year_id, results_published
      `;
      const [historical] = await tx`
        INSERT INTO exam_subjects (
          school_id, exam_id, subject_id, class_id, max_marks, passing_marks, is_exam_only, marks_responsibility
        )
        VALUES (${schoolId}, ${exam.id}, ${legacySubject.id}, ${klass.id}, 50, 18, false, 'subject_teacher')
        RETURNING id, is_exam_only, marks_responsibility
      `;

      const saved = await replaceExamOnlySubjects(tx, {
        schoolId,
        exam,
        subjects: [{
          name: 'Handwriting',
          max_marks: 40,
          passing_marks: 0,
          targets: [
            { class_id: klass.id, class_section_id: secA.id },
            { class_id: klass.id, class_section_id: secB.id },
            { class_id: klass.id, class_section_id: secC.id },
          ],
        }],
      });
      assert.equal(saved.length, 3);
      const [unchangedHistorical] = await tx`
        SELECT is_exam_only, marks_responsibility FROM exam_subjects WHERE id = ${historical.id}
      `;
      assert.equal(unchangedHistorical.is_exam_only, false);
      assert.equal(unchangedHistorical.marks_responsibility, 'subject_teacher');
      const timetableSlots = await tx`
        SELECT id FROM timetable_slots WHERE school_id = ${schoolId}
      `;
      const teachingRows = await tx`
        SELECT id FROM class_subjects WHERE school_id = ${schoolId}
      `;
      assert.equal(timetableSlots.length, 0);
      assert.equal(teachingRows.length, 0);

      const discovered = await listClassTeacherSpecialAssignments(tx, { schoolId, staffId: teacherA.id });
      assert.equal(discovered.length, 2);
      assert.equal(discovered.every((row) => row.subject_name === 'Handwriting'), true);
      assert.deepEqual(
        discovered.map((row) => row.class_section_id).sort(),
        [secA.id, secB.id].sort(),
      );
      const discoveredFields = discovered[0];
      for (const field of ['class_section_id', 'class_id', 'class_name', 'section_id', 'section_name', 'subject_id', 'subject_name']) {
        assert.equal(typeof discoveredFields[field], 'string');
      }

      const noClassTeacher = await listClassTeacherSpecialAssignments(tx, { schoolId, staffId: stranger.id });
      assert.equal(noClassTeacher.length, 0);

      const actorA = { person_id: teacherAPerson.id, internal_id: userA.id, roles: ['teacher'] };
      const upload = await saveLegacyExamOnlyUpload(tx, {
        schoolId,
        classSection: { id: secA.id, class_id: klass.id, academic_year_id: year.id },
        examCategory: 'special',
        subExam: 'Special-1',
        subjectId: saved[0].subject_id,
        results: [
          { student_id: studentA.student.id, marks: 30, max_marks: 25 },
          { student_id: studentC.student.id, marks: 10, max_marks: 25 },
        ],
        assessmentSchema: 'consolidated',
        user: actorA,
      });
      assert.equal(upload.status, 200);
      assert.equal(upload.body.uploaded_count, 1);
      assert.equal(upload.body.failed_count, 1);
      assert.equal(upload.body.results.find((row) => row.student_id === studentC.student.id).error, 'Active enrollment not found');
      const [paperAfterDefault] = await tx`
        SELECT max_marks FROM exam_subjects WHERE id = ${upload.body.exam_subject_id}
      `;
      assert.equal(Number(paperAfterDefault.max_marks), 40);
      const [stored] = await tx`
        SELECT marks_obtained, is_absent, entered_by
        FROM marks WHERE exam_subject_id = ${upload.body.exam_subject_id}
      `;
      assert.equal(Number(stored.marks_obtained), 30);
      assert.equal(stored.is_absent, false);
      assert.equal(stored.entered_by, userA.id);

      const tooHigh = await saveLegacyExamOnlyUpload(tx, {
        schoolId,
        classSection: { id: secA.id, class_id: klass.id, academic_year_id: year.id },
        examCategory: 'special',
        subExam: 'Special-1',
        subjectId: saved[0].subject_id,
        results: [{ student_id: studentA.student.id, marks: 41, max_marks: 100 }],
        assessmentSchema: 'consolidated',
        user: actorA,
      });
      assert.equal(tooHigh.status, 400);

      const absent = await saveLegacyExamOnlyUpload(tx, {
        schoolId,
        classSection: { id: secB.id, class_id: klass.id, academic_year_id: year.id },
        examCategory: 'special',
        subExam: 'Special-1',
        subjectId: saved[0].subject_id,
        results: [{ student_id: studentB.student.id, marks: 'A', max_marks: 25 }],
        assessmentSchema: 'consolidated',
        user: actorA,
      });
      assert.equal(absent.status, 200);
      const [absentMark] = await tx`
        SELECT is_absent, marks_obtained FROM marks
        WHERE student_enrollment_id = ${studentB.enrollment.id}
      `;
      assert.equal(absentMark.is_absent, true);
      assert.equal(absentMark.marks_obtained, null);

      const crossSection = await saveLegacyExamOnlyUpload(tx, {
        schoolId,
        classSection: { id: secC.id, class_id: klass.id, academic_year_id: year.id },
        examCategory: 'special',
        subExam: 'Special-1',
        subjectId: saved[0].subject_id,
        results: [{ student_id: studentC.student.id, marks: 12 }],
        assessmentSchema: 'consolidated',
        user: actorA,
      });
      assert.equal(crossSection.status, 403);

      const otherTeacher = await saveLegacyExamOnlyUpload(tx, {
        schoolId,
        classSection: { id: secA.id, class_id: klass.id, academic_year_id: year.id },
        examCategory: 'special',
        subExam: 'Special-1',
        subjectId: saved[0].subject_id,
        results: [{ student_id: studentA.student.id, marks: 12 }],
        assessmentSchema: 'consolidated',
        user: { person_id: strangerPerson.id, internal_id: userB.id, roles: ['teacher'] },
      });
      assert.equal(otherTeacher.status, 403);

      const [foreignSection] = await tx`
        INSERT INTO class_sections (school_id, class_id, section_id, academic_year_id)
        VALUES (${otherSchool.id}, ${otherClass.id}, ${sectionA.id}, ${year.id})
        RETURNING id
      `;
      const crossSchool = await resolveLegacyExamOnlyContext(tx, {
        schoolId,
        classId: klass.id,
        classSectionId: foreignSection.id,
        academicYearId: year.id,
        examCategory: 'special',
        subExam: 'Special-1',
        subjectId: saved[0].subject_id,
      });
      assert.equal(crossSchool.kind, 'missing');
      const crossWrite = await saveLegacyExamOnlyUpload(tx, {
        schoolId,
        classSection: { id: foreignSection.id, class_id: otherClass.id, academic_year_id: year.id },
        examCategory: 'special',
        subExam: 'Special-1',
        subjectId: saved[0].subject_id,
        results: [{ student_id: studentA.student.id, marks: 5 }],
        user: actorA,
      });
      assert.equal(crossWrite.status, 404);

      await tx`UPDATE class_sections SET class_teacher_id = ${teacherB.id} WHERE id = ${secA.id}`;
      const reassigned = await saveLegacyExamOnlyUpload(tx, {
        schoolId,
        classSection: { id: secA.id, class_id: klass.id, academic_year_id: year.id },
        examCategory: 'special',
        subExam: 'Special-1',
        subjectId: saved[0].subject_id,
        results: [{ student_id: studentA.student.id, marks: 18 }],
        user: actorA,
      });
      assert.equal(reassigned.status, 403);
      const corrected = await saveLegacyExamOnlyUpload(tx, {
        schoolId,
        classSection: { id: secA.id, class_id: klass.id, academic_year_id: year.id },
        examCategory: 'special',
        subExam: 'Special-1',
        subjectId: saved[0].subject_id,
        results: [{ student_id: studentA.student.id, marks: 18 }],
        user: { person_id: teacherBPerson.id, internal_id: userB.id, roles: ['teacher'] },
      });
      assert.equal(corrected.status, 200);
      const [correctedMark] = await tx`
        SELECT entered_by, marks_obtained FROM marks
        WHERE exam_subject_id = ${upload.body.exam_subject_id}
          AND student_enrollment_id = ${studentA.enrollment.id}
      `;
      assert.equal(Number(correctedMark.marks_obtained), 18);
      assert.equal(correctedMark.entered_by, userB.id);
      await tx`UPDATE class_sections SET class_teacher_id = ${teacherA.id} WHERE id = ${secA.id}`;

      const [secondExam] = await tx`
        INSERT INTO exams (school_id, name, academic_year_id, exam_type, status)
        VALUES (${schoolId}, 'Special-1', ${year.id}, 'special', 'scheduled')
        RETURNING id, exam_type, academic_year_id, results_published
      `;
      await replaceExamOnlySubjects(tx, {
        schoolId,
        exam: secondExam,
        subjects: [{
          name: 'Handwriting',
          max_marks: 10,
          passing_marks: 4,
          targets: [{ class_id: klass.id, class_section_id: secA.id }],
        }],
      });
      const ambiguous = await resolveLegacyExamOnlyContext(tx, {
        schoolId,
        classId: klass.id,
        classSectionId: secA.id,
        academicYearId: year.id,
        examCategory: 'special',
        subExam: 'Special-1',
        subjectId: saved[0].subject_id,
      });
      assert.equal(ambiguous.kind, 'ambiguous');
      await tx`UPDATE exams SET deleted_at = now() WHERE id = ${secondExam.id}`;

      const [classWideExam] = await tx`
        INSERT INTO exams (school_id, name, academic_year_id, exam_type, status)
        VALUES (${schoolId}, 'Special-2', ${year.id}, 'special', 'scheduled')
        RETURNING id, exam_type, academic_year_id, results_published
      `;
      await assert.rejects(
        () => replaceExamOnlySubjects(tx, {
          schoolId,
          exam: classWideExam,
          subjects: [
            {
              name: 'Craft',
              max_marks: 15,
              passing_marks: 5,
              targets: [{ class_id: klass.id, class_section_id: null }],
            },
            {
              name: 'Craft',
              max_marks: 12,
              passing_marks: 4,
              targets: [{ class_id: klass.id, class_section_id: secA.id }],
            },
          ],
        }),
        (error) => error instanceof ExamOnlySubjectError && /Duplicate special subject/.test(error.message),
      );

      throw Object.assign(new Error('rollback'), { code: 'ROLLBACK' });
    });
  } catch (error) {
    if (error?.code !== 'ROLLBACK') throw error;
  }

  await sql.begin(async (tx) => {
    const [school] = await tx`
      INSERT INTO schools (name, code, is_active)
      VALUES (${`Special2 ${suffix}`}, ${`s2${suffix}`.slice(0, 20)}, true)
      RETURNING id
    `;
    const schoolId = school.id;
    const [year] = await tx`
      INSERT INTO academic_years (school_id, code, start_date, end_date)
      VALUES (${schoolId}, ${`Z${suffix}`.slice(0, 20)}, '2026-06-01', '2027-04-30')
      RETURNING id
    `;
    const [klass] = await tx`INSERT INTO classes (school_id, name) VALUES (${schoolId}, 'Class 3') RETURNING id`;
    const [sectionA] = await tx`INSERT INTO sections (school_id, name) VALUES (${schoolId}, 'A') RETURNING id`;
    const [sectionB] = await tx`INSERT INTO sections (school_id, name) VALUES (${schoolId}, 'B') RETURNING id`;
    const [secA] = await tx`
      INSERT INTO class_sections (school_id, class_id, section_id, academic_year_id)
      VALUES (${schoolId}, ${klass.id}, ${sectionA.id}, ${year.id}) RETURNING id
    `;
    const [secB] = await tx`
      INSERT INTO class_sections (school_id, class_id, section_id, academic_year_id)
      VALUES (${schoolId}, ${klass.id}, ${sectionB.id}, ${year.id}) RETURNING id
    `;
    const [{ id: genderId }] = await tx`SELECT id FROM genders ORDER BY id LIMIT 1`;
    const [person] = await tx`
      INSERT INTO persons (school_id, first_name, gender_id, display_name)
      VALUES (${schoolId}, 'Meera', ${genderId}, 'Meera') RETURNING id
    `;
    const [teacher] = await tx`
      INSERT INTO staff (school_id, person_id, staff_code, joining_date)
      VALUES (${schoolId}, ${person.id}, ${`TM${suffix}`.slice(0, 20)}, '2026-06-01')
      RETURNING id
    `;
    const [user] = await tx`INSERT INTO users (school_id, person_id) VALUES (${schoolId}, ${person.id}) RETURNING id`;
    await tx`UPDATE class_sections SET class_teacher_id = ${teacher.id} WHERE id = ${secA.id}`;
    const [{ id: statusId }] = await tx`SELECT id FROM student_statuses WHERE id = 1`;
    const [studentPerson] = await tx`
      INSERT INTO persons (school_id, first_name, gender_id, display_name)
      VALUES (${schoolId}, 'Ravi', ${genderId}, 'Ravi') RETURNING id
    `;
    const [student] = await tx`
      INSERT INTO students (school_id, person_id, admission_no, admission_date, status_id)
      VALUES (${schoolId}, ${studentPerson.id}, ${`RV${suffix}`.slice(0, 30)}, '2026-06-01', ${statusId})
      RETURNING id
    `;
    const [enrollment] = await tx`
      INSERT INTO student_enrollments (school_id, student_id, academic_year_id, class_section_id, start_date, status)
      VALUES (${schoolId}, ${student.id}, ${year.id}, ${secA.id}, '2026-06-01', 'active')
      RETURNING id
    `;
    const [exam] = await tx`
      INSERT INTO exams (school_id, name, academic_year_id, exam_type, status)
      VALUES (${schoolId}, 'Special-2', ${year.id}, 'special', 'scheduled')
      RETURNING id, exam_type, academic_year_id, results_published
    `;
    const papers = await replaceExamOnlySubjects(tx, {
      schoolId,
      exam,
      subjects: [{
        name: 'Handwriting',
        max_marks: 25,
        passing_marks: 8,
        targets: [
          { class_id: klass.id, class_section_id: null },
        ],
      }],
    });
    const sectionSpecific = await replaceExamOnlySubjects(tx, {
      schoolId,
      exam,
      subjects: [{
        name: 'Handwriting',
        max_marks: 25,
        passing_marks: 8,
        targets: [{ class_id: klass.id, class_section_id: secB.id }],
      }],
    });
    assert.equal(sectionSpecific.length, 1);
    const resolved = await resolveLegacyExamOnlyContext(tx, {
      schoolId,
      classId: klass.id,
      classSectionId: secB.id,
      academicYearId: year.id,
      examCategory: 'special',
      subExam: 'Special-2',
      subjectId: papers[0].subject_id,
    });
    assert.equal(resolved.paper.id, sectionSpecific[0].id);

    const classWideAgain = await replaceExamOnlySubjects(tx, {
      schoolId,
      exam,
      subjects: [{
        name: 'Handwriting',
        max_marks: 25,
        passing_marks: 8,
        targets: [{ class_id: klass.id, class_section_id: null }],
      }],
    });
    const uploaded = await saveLegacyExamOnlyUpload(tx, {
      schoolId,
      classSection: { id: secA.id, class_id: klass.id, academic_year_id: year.id },
      examCategory: 'special',
      subExam: 'Special-2',
      subjectId: classWideAgain[0].subject_id,
      results: [{ student_id: student.id, marks: 21 }],
      user: { person_id: person.id, internal_id: user.id, roles: ['teacher'] },
    });
    assert.equal(uploaded.status, 200);

    const loaded = await loadLegacyExamOnlyMarks(tx, {
      schoolId,
      classSection: { id: secA.id, class_id: klass.id, academic_year_id: year.id },
      examCategory: 'special',
      subExam: 'Special-2',
      subjectId: classWideAgain[0].subject_id,
      user: { person_id: person.id, internal_id: user.id, roles: ['teacher'] },
    });
    assert.equal(loaded.status, 200);
    assert.equal(loaded.maxMarks, 25);
    assert.equal(Number(loaded.marks[0].marks_obtained), 21);

    const [otherStudentPerson] = await tx`
      INSERT INTO persons (school_id, first_name, gender_id, display_name)
      VALUES (${schoolId}, 'Kiran', ${genderId}, 'Kiran') RETURNING id
    `;
    const [otherStudent] = await tx`
      INSERT INTO students (school_id, person_id, admission_no, admission_date, status_id)
      VALUES (${schoolId}, ${otherStudentPerson.id}, ${`KR${suffix}`.slice(0, 30)}, '2026-06-01', ${statusId})
      RETURNING id
    `;
    const [otherEnrollment] = await tx`
      INSERT INTO student_enrollments (school_id, student_id, academic_year_id, class_section_id, start_date, status)
      VALUES (${schoolId}, ${otherStudent.id}, ${year.id}, ${secB.id}, '2026-06-01', 'active')
      RETURNING id
    `;
    const deniedRow = await authorizeExamOnlyMarkRow(tx, {
      schoolId,
      paper: { ...classWideAgain[0], is_exam_only: true, marks_responsibility: 'class_teacher' },
      enrollmentId: otherEnrollment.id,
      user: { person_id: person.id, roles: ['teacher'] },
    });
    assert.equal(deniedRow.ok, false);
    const allowedRow = await authorizeExamOnlyMarkRow(tx, {
      schoolId,
      paper: { ...classWideAgain[0], is_exam_only: true, marks_responsibility: 'class_teacher' },
      enrollmentId: enrollment.id,
      user: { person_id: person.id, roles: ['teacher'] },
    });
    assert.equal(allowedRow.ok, true);
    const adminRow = await authorizeExamOnlyMarkRow(tx, {
      schoolId,
      paper: { ...classWideAgain[0], is_exam_only: true, marks_responsibility: 'class_teacher' },
      enrollmentId: otherEnrollment.id,
      user: { person_id: person.id, roles: ['admin'] },
    });
    assert.equal(adminRow.ok, true);

    await assert.rejects(
      () => replaceExamOnlySubjects(tx, {
        schoolId,
        exam,
        subjects: [{
          name: 'Calligraphy',
          max_marks: 25,
          passing_marks: 8,
          targets: [{ id: classWideAgain[0].id, class_id: klass.id, class_section_id: null }],
        }],
      }),
      (error) => error instanceof ExamOnlySubjectError && /rename/.test(error.message),
    );
    await assert.rejects(
      () => replaceExamOnlySubjects(tx, {
        schoolId,
        exam,
        subjects: [{
          name: 'Handwriting',
          max_marks: 10,
          passing_marks: 4,
          targets: [{ id: classWideAgain[0].id, class_id: klass.id, class_section_id: null }],
        }],
      }),
      /already-recorded marks/,
    );

    const missing = await resolveLegacyExamOnlyContext(tx, {
      schoolId,
      classId: klass.id,
      classSectionId: secA.id,
      academicYearId: year.id,
      examCategory: 'special',
      subExam: 'Special-9',
      subjectId: classWideAgain[0].subject_id,
    });
    assert.equal(missing.kind, 'missing');
    const notCreated = await tx`
      SELECT count(*)::int AS count FROM exam_subjects
      WHERE exam_id = ${exam.id} AND deleted_at IS NULL
    `;
    assert.equal(notCreated[0].count, 1);

    const regular = await resolveLegacyExamOnlyContext(tx, {
      schoolId,
      classId: klass.id,
      classSectionId: secA.id,
      academicYearId: year.id,
      examCategory: 'fa_results',
      subExam: 'FA-1',
      subjectId: (
        await tx`
          INSERT INTO subjects (school_id, name, is_exam_only)
          VALUES (${schoolId}, 'Math', false) RETURNING id
        `
      )[0].id,
    });
    assert.equal(regular.kind, 'regular');

    exam.results_published = true;
    await tx`UPDATE exams SET results_published = true WHERE id = ${exam.id}`;
    const lockedExam = { ...exam, results_published: true };
    await assert.rejects(
      () => replaceExamOnlySubjects(tx, { schoolId, exam: lockedExam, subjects: [] }),
      /Unpublish/,
    );
    await tx`UPDATE exams SET results_published = false WHERE id = ${exam.id}`;

    const generated = await generateExamTimetable({
      schoolId,
      examId: exam.id,
      db: tx,
      params: {
        class_ids: [klass.id],
        start_date: '2026-09-01',
        end_date: '2026-09-05',
        start_time: '09:30',
        end_time: '12:30',
        max_marks: 100,
        passing_marks: 35,
      },
    });
    assert.ok(generated);
    const [kept] = await tx`
      SELECT max_marks, subject_name_snapshot, exam_date, is_exam_only
      FROM exam_subjects WHERE id = ${classWideAgain[0].id}
    `;
    assert.equal(Number(kept.max_marks), 25);
    assert.equal(kept.subject_name_snapshot, 'Handwriting');
    assert.equal(kept.is_exam_only, true);
    assert.ok(kept.exam_date);
    const [markKept] = await tx`
      SELECT marks_obtained FROM marks WHERE student_enrollment_id = ${enrollment.id}
    `;
    assert.equal(Number(markKept.marks_obtained), 21);

    const [pendingPerson] = await tx`
      INSERT INTO persons (school_id, first_name, gender_id, display_name)
      VALUES (${schoolId}, 'Nila', ${genderId}, 'Nila') RETURNING id
    `;
    const [pendingStudent] = await tx`
      INSERT INTO students (school_id, person_id, admission_no, admission_date, status_id)
      VALUES (${schoolId}, ${pendingPerson.id}, ${`NL${suffix}`.slice(0, 30)}, '2026-06-01', ${statusId})
      RETURNING id
    `;
    await tx`
      INSERT INTO student_enrollments (school_id, student_id, academic_year_id, class_section_id, start_date, status)
      VALUES (${schoolId}, ${pendingStudent.id}, ${year.id}, ${secA.id}, '2026-06-01', 'active')
    `;

    const readiness = await getExamResultReadiness({ schoolId, examId: exam.id, db: tx });
    const paper = readiness.papers.find((row) => row.subject_name === 'Handwriting');
    assert.ok(paper);
    assert.equal(paper.pending_teachers[0]?.teacher_id, teacher.id);
    assert.ok(paper.pending_teachers[0].missing_entries >= 1);
    assert.equal(paper.unassigned_sections.some((section) => section.section_name === 'B'), true);
    assert.equal(
      paper.unassigned_sections.find((section) => section.section_name === 'B')?.responsibility,
      'class_teacher',
    );

    throw Object.assign(new Error('rollback'), { code: 'ROLLBACK' });
  }).catch((error) => {
    if (error?.code !== 'ROLLBACK') throw error;
  });
});
