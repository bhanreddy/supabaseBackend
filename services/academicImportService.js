import * as XLSX from 'xlsx';
import sql from '../db.js';

/**
 * Service for Excel Curriculum Import & Template Generation
 * Follows strict Upload -> Parse -> Validate -> Preview -> Confirm workflow.
 */
class AcademicImportService {
  /**
   * Generate downloadable Excel template workbook
   */
  static generateExcelTemplate() {
    const headers = [
      'Class Name',
      'Subject Name',
      'Term Name',
      'Unit Title',
      'Chapter Title',
      'Topic Title',
      'Estimated Periods',
      'Sequence',
      'Is Optional (Yes/No)'
    ];

    const sampleRows = [
      [
        'Class 7',
        'Mathematics',
        'Term 1',
        'Unit 1: Number Systems',
        'Chapter 1: Integers',
        'Addition & Subtraction of Integers',
        2,
        1,
        'No'
      ],
      [
        'Class 7',
        'Mathematics',
        'Term 1',
        'Unit 1: Number Systems',
        'Chapter 1: Integers',
        'Multiplication of Integers',
        2,
        2,
        'No'
      ],
      [
        'Class 7',
        'Mathematics',
        'Term 1',
        'Unit 1: Number Systems',
        'Chapter 2: Fractions & Decimals',
        'Addition of Unlike Fractions',
        3,
        1,
        'No'
      ],
      [
        'Class 7',
        'Mathematics',
        'Term 1',
        'Unit 1: Number Systems',
        'Chapter 2: Fractions & Decimals',
        'Enrichment: Vedic Fraction Tricks',
        1,
        2,
        'Yes'
      ]
    ];

    const ws = XLSX.utils.aoa_to_sheet([headers, ...sampleRows]);
    // Set column widths
    ws['!cols'] = [
      { wch: 15 },
      { wch: 18 },
      { wch: 12 },
      { wch: 25 },
      { wch: 25 },
      { wch: 35 },
      { wch: 18 },
      { wch: 10 },
      { wch: 20 }
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Curriculum_Template');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  }

  /**
   * Parse uploaded Excel buffer and validate against school database
   */
  static async parseAndValidate({ schoolId, fileBuffer, academicYearId }) {
    const numericSchoolId = Number(schoolId);

    const wb = XLSX.read(fileBuffer, { type: 'buffer' });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) throw new Error('Uploaded workbook has no sheets');

    const rawRows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1 });
    if (!rawRows || rawRows.length < 2) {
      throw new Error('Workbook is empty or missing data rows');
    }

    const headers = rawRows[0].map(h => String(h || '').trim().toLowerCase());
    const classIdx = headers.findIndex(h => h.includes('class'));
    const subjectIdx = headers.findIndex(h => h.includes('subject'));
    const termIdx = headers.findIndex(h => h.includes('term'));
    const unitIdx = headers.findIndex(h => h.includes('unit'));
    const chapterIdx = headers.findIndex(h => h.includes('chapter'));
    const topicIdx = headers.findIndex(h => h.includes('topic'));
    const periodsIdx = headers.findIndex(h => h.includes('period'));
    const seqIdx = headers.findIndex(h => h.includes('seq'));
    const optIdx = headers.findIndex(h => h.includes('optional'));

    if (classIdx === -1 || subjectIdx === -1 || chapterIdx === -1 || topicIdx === -1) {
      throw new Error('Required columns missing: Class, Subject, Chapter, and Topic are mandatory.');
    }

    // Fetch existing classes & subjects for this school
    const classes = await sql`
      SELECT id, name FROM classes
      WHERE school_id = ${numericSchoolId} AND deleted_at IS NULL
    `;
    const subjects = await sql`
      SELECT id, name FROM subjects
      WHERE school_id = ${numericSchoolId} AND deleted_at IS NULL
    `;
    const terms = await sql`
      SELECT id, name FROM academic_terms
      WHERE school_id = ${numericSchoolId} AND deleted_at IS NULL
        ${academicYearId ? sql`AND academic_year_id = ${academicYearId}` : sql``}
    `;

    const classMap = new Map(classes.map(c => [c.name.trim().toLowerCase(), c.id]));
    const subjectMap = new Map(subjects.map(s => [s.name.trim().toLowerCase(), s.id]));
    const termMap = new Map(terms.map(t => [t.name.trim().toLowerCase(), t.id]));

    const previewRows = [];
    const errors = [];

    for (let r = 1; r < rawRows.length; r++) {
      const row = rawRows[r];
      if (!row || row.length === 0 || !row[classIdx]) continue;

      const className = String(row[classIdx] || '').trim();
      const subjectName = String(row[subjectIdx] || '').trim();
      const termName = termIdx !== -1 ? String(row[termIdx] || '').trim() : '';
      const unitTitle = unitIdx !== -1 ? String(row[unitIdx] || '').trim() : '';
      const chapterTitle = String(row[chapterIdx] || '').trim();
      const topicTitle = String(row[topicIdx] || '').trim();
      const periods = periodsIdx !== -1 ? Math.max(1, parseInt(row[periodsIdx] || '1', 10)) : 1;
      const sequence = seqIdx !== -1 ? Math.max(1, parseInt(row[seqIdx] || `${r}`, 10)) : r;
      const isOptionalStr = optIdx !== -1 ? String(row[optIdx] || '').trim().toLowerCase() : 'no';
      const isOptional = isOptionalStr.startsWith('y') || isOptionalStr === 'true';

      const rowErrors = [];
      const classId = classMap.get(className.toLowerCase());
      if (!classId) {
        rowErrors.push(`Class "${className}" not found in school.`);
      }

      const subjectId = subjectMap.get(subjectName.toLowerCase());
      if (!subjectId) {
        rowErrors.push(`Subject "${subjectName}" not found in school.`);
      }

      if (!chapterTitle) {
        rowErrors.push('Chapter title cannot be empty.');
      }

      if (!topicTitle) {
        rowErrors.push('Topic title cannot be empty.');
      }

      const termId = termName ? termMap.get(termName.toLowerCase()) || null : null;

      const parsedRow = {
        row_number: r + 1,
        class_name: className,
        class_id: classId || null,
        subject_name: subjectName,
        subject_id: subjectId || null,
        term_name: termName,
        term_id: termId,
        unit_title: unitTitle || null,
        chapter_title: chapterTitle,
        topic_title: topicTitle,
        estimated_periods: periods,
        sequence,
        is_optional: isOptional,
        is_valid: rowErrors.length === 0,
        errors: rowErrors
      };

      if (rowErrors.length > 0) {
        errors.push({ row: r + 1, errors: rowErrors });
      }

      previewRows.push(parsedRow);
    }

    return {
      total_rows: previewRows.length,
      valid_rows_count: previewRows.filter(p => p.is_valid).length,
      invalid_rows_count: errors.length,
      is_valid: errors.length === 0,
      preview_rows: previewRows.slice(0, 50), // First 50 rows for preview modal
      all_rows: previewRows,
      errors
    };
  }

  /**
   * Commit validated rows to database inside a transaction
   */
  static async commitImport({ schoolId, academicYearId, rows, createdBy }) {
    const numericSchoolId = Number(schoolId);

    // Group rows by class_id and subject_id to build distinct curricula
    const grouped = new Map();
    rows.forEach(r => {
      if (!r.is_valid || !r.class_id || !r.subject_id) return;
      const key = `${r.class_id}_${r.subject_id}`;
      if (!grouped.has(key)) {
        grouped.set(key, {
          class_id: r.class_id,
          class_name: r.class_name,
          subject_id: r.subject_id,
          subject_name: r.subject_name,
          units: new Map(), // unitTitle -> { term_id, chapters: Map() }
          standaloneChapters: new Map() // chapterTitle -> topics: []
        });
      }

      const currGroup = grouped.get(key);
      const unitKey = r.unit_title || '__NO_UNIT__';

      if (r.unit_title) {
        if (!currGroup.units.has(unitKey)) {
          currGroup.units.set(unitKey, {
            title: r.unit_title,
            term_id: r.term_id,
            chapters: new Map()
          });
        }
        const unitObj = currGroup.units.get(unitKey);
        if (!unitObj.chapters.has(r.chapter_title)) {
          unitObj.chapters.set(r.chapter_title, {
            title: r.chapter_title,
            topics: []
          });
        }
        unitObj.chapters.get(r.chapter_title).topics.push(r);
      } else {
        if (!currGroup.standaloneChapters.has(r.chapter_title)) {
          currGroup.standaloneChapters.set(r.chapter_title, {
            title: r.chapter_title,
            topics: []
          });
        }
        currGroup.standaloneChapters.get(r.chapter_title).topics.push(r);
      }
    });

    return sql.begin(async (tx) => {
      const createdCurricula = [];

      for (const [key, group] of grouped.entries()) {
        // 1. Get or create curriculum
        const [existing] = await tx`
          SELECT id, version FROM curricula
          WHERE school_id = ${numericSchoolId}
            AND academic_year_id = ${academicYearId}
            AND class_id = ${group.class_id}
            AND subject_id = ${group.subject_id}
            AND deleted_at IS NULL
          ORDER BY version DESC LIMIT 1
        `;

        let curriculumId;
        if (existing) {
          curriculumId = existing.id;
        } else {
          const [newCurr] = await tx`
            INSERT INTO curricula (
              school_id, academic_year_id, class_id, subject_id,
              name, version, status, created_by
            ) VALUES (
              ${numericSchoolId}, ${academicYearId}, ${group.class_id}, ${group.subject_id},
              ${group.class_name + ' ' + group.subject_name + ' Curriculum'}, 1, 'ACTIVE', ${createdBy || null}
            )
            RETURNING id
          `;
          curriculumId = newCurr.id;
        }
        createdCurricula.push(curriculumId);

        // 2. Insert Units & their Chapters/Topics
        let unitSeq = 1;
        for (const [uTitle, uObj] of group.units.entries()) {
          const [uRow] = await tx`
            INSERT INTO curriculum_units (
              school_id, curriculum_id, term_id, title, sequence, estimated_periods
            ) VALUES (
              ${numericSchoolId}, ${curriculumId}, ${uObj.term_id || null}, ${uObj.title},
              ${unitSeq++}, 0
            )
            RETURNING id
          `;

          let chSeq = 1;
          for (const [chTitle, chObj] of uObj.chapters.entries()) {
            const [chRow] = await tx`
              INSERT INTO curriculum_chapters (
                school_id, curriculum_id, unit_id, title, sequence, estimated_periods, weight
              ) VALUES (
                ${numericSchoolId}, ${curriculumId}, ${uRow.id}, ${chObj.title},
                ${chSeq++}, 1, 1.0
              )
              RETURNING id
            `;

            for (let t = 0; t < chObj.topics.length; t++) {
              const tp = chObj.topics[t];
              await tx`
                INSERT INTO curriculum_topics (
                  school_id, chapter_id, title, sequence, estimated_periods, weight, is_optional
                ) VALUES (
                  ${numericSchoolId}, ${chRow.id}, ${tp.topic_title},
                  ${t + 1}, ${tp.estimated_periods}, 1.0, ${tp.is_optional}
                )
              `;
            }
          }
        }

        // 3. Insert standalone Chapters/Topics
        let chSeq = 1;
        for (const [chTitle, chObj] of group.standaloneChapters.entries()) {
          const [chRow] = await tx`
            INSERT INTO curriculum_chapters (
              school_id, curriculum_id, unit_id, title, sequence, estimated_periods, weight
            ) VALUES (
              ${numericSchoolId}, ${curriculumId}, null, ${chObj.title},
              ${chSeq++}, 1, 1.0
            )
            RETURNING id
          `;

          for (let t = 0; t < chObj.topics.length; t++) {
            const tp = chObj.topics[t];
            await tx`
              INSERT INTO curriculum_topics (
                school_id, chapter_id, title, sequence, estimated_periods, weight, is_optional
              ) VALUES (
                ${numericSchoolId}, ${chRow.id}, ${tp.topic_title},
                ${t + 1}, ${tp.estimated_periods}, 1.0, ${tp.is_optional}
              )
            `;
          }
        }
      }

      return {
        imported_curricula_count: createdCurricula.length,
        total_rows_imported: rows.filter(r => r.is_valid).length
      };
    });
  }
}

export default AcademicImportService;
