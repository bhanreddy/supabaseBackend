import sql from '../db.js';

/**
 * Service for managing Curriculum Hierarchy:
 * Curriculum -> Unit -> Chapter -> Topic
 * Supports multi-tenancy (school_id isolation), versioning, copying, and reordering.
 */
class CurriculumService {
  /**
   * List curricula with optional filters
   */
  static async listCurricula({ schoolId, classId, subjectId, academicYearId, status }) {
    const numericSchoolId = Number(schoolId);
    return sql`
      SELECT 
        c.id, c.school_id, c.academic_year_id, c.class_id, c.subject_id,
        c.name, c.version, c.status, c.description, c.created_at, c.updated_at,
        cl.name AS class_name,
        s.name AS subject_name,
        ay.code AS academic_year_code,
        COUNT(DISTINCT u.id)::int AS units_count,
        COUNT(DISTINCT ch.id)::int AS chapters_count,
        COUNT(DISTINCT tp.id)::int AS topics_count,
        COALESCE(SUM(tp.estimated_periods), 0)::int AS total_estimated_periods
      FROM curricula c
      JOIN classes cl ON c.class_id = cl.id AND cl.school_id = ${numericSchoolId} AND cl.deleted_at IS NULL
      JOIN subjects s ON c.subject_id = s.id AND s.school_id = ${numericSchoolId} AND s.deleted_at IS NULL
      JOIN academic_years ay ON c.academic_year_id = ay.id AND ay.school_id = ${numericSchoolId}
      LEFT JOIN curriculum_units u ON u.curriculum_id = c.id AND u.school_id = ${numericSchoolId} AND u.deleted_at IS NULL
      LEFT JOIN curriculum_chapters ch ON ch.curriculum_id = c.id AND ch.school_id = ${numericSchoolId} AND ch.deleted_at IS NULL
      LEFT JOIN curriculum_topics tp ON tp.chapter_id = ch.id AND tp.school_id = ${numericSchoolId} AND tp.deleted_at IS NULL
      WHERE c.school_id = ${numericSchoolId}
        AND c.deleted_at IS NULL
        ${classId ? sql`AND c.class_id = ${classId}` : sql``}
        ${subjectId ? sql`AND c.subject_id = ${subjectId}` : sql``}
        ${academicYearId ? sql`AND c.academic_year_id = ${academicYearId}` : sql``}
        ${status ? sql`AND c.status = ${status}` : sql``}
      GROUP BY c.id, cl.name, s.name, ay.code
      ORDER BY cl.name ASC, s.name ASC, c.version DESC
    `;
  }

  /**
   * Get single curriculum by ID with full nested structure (Units -> Chapters -> Topics)
   */
  static async getCurriculumById({ schoolId, curriculumId }) {
    const numericSchoolId = Number(schoolId);
    const [curriculum] = await sql`
      SELECT 
        c.*,
        cl.name AS class_name,
        s.name AS subject_name,
        ay.code AS academic_year_code
      FROM curricula c
      JOIN classes cl ON c.class_id = cl.id AND cl.school_id = ${numericSchoolId}
      JOIN subjects s ON c.subject_id = s.id AND s.school_id = ${numericSchoolId}
      JOIN academic_years ay ON c.academic_year_id = ay.id AND ay.school_id = ${numericSchoolId}
      WHERE c.id = ${curriculumId}
        AND c.school_id = ${numericSchoolId}
        AND c.deleted_at IS NULL
    `;

    if (!curriculum) return null;

    // Fetch units
    const units = await sql`
      SELECT u.*, t.name AS term_name
      FROM curriculum_units u
      LEFT JOIN academic_terms t ON u.term_id = t.id AND t.school_id = ${numericSchoolId}
      WHERE u.curriculum_id = ${curriculumId}
        AND u.school_id = ${numericSchoolId}
        AND u.deleted_at IS NULL
      ORDER BY u.sequence ASC, u.created_at ASC
    `;

    // Fetch chapters
    const chapters = await sql`
      SELECT *
      FROM curriculum_chapters
      WHERE curriculum_id = ${curriculumId}
        AND school_id = ${numericSchoolId}
        AND deleted_at IS NULL
      ORDER BY sequence ASC, created_at ASC
    `;

    // Fetch topics
    const chapterIds = chapters.map(ch => ch.id);
    let topics = [];
    if (chapterIds.length > 0) {
      topics = await sql`
        SELECT *
        FROM curriculum_topics
        WHERE chapter_id IN ${sql(chapterIds)}
          AND school_id = ${numericSchoolId}
          AND deleted_at IS NULL
        ORDER BY sequence ASC, created_at ASC
      `;
    }

    // Nest topics inside chapters
    const chapterMap = new Map();
    chapters.forEach(ch => {
      chapterMap.set(ch.id, {
        ...ch,
        topics: []
      });
    });

    topics.forEach(tp => {
      const ch = chapterMap.get(tp.chapter_id);
      if (ch) {
        ch.topics.push(tp);
      }
    });

    // Nest chapters inside units (or unassigned bucket)
    const unitMap = new Map();
    units.forEach(u => {
      unitMap.set(u.id, {
        ...u,
        chapters: []
      });
    });

    const unassignedChapters = [];
    chapterMap.forEach(ch => {
      if (ch.unit_id && unitMap.has(ch.unit_id)) {
        unitMap.get(ch.unit_id).chapters.push(ch);
      } else {
        unassignedChapters.push(ch);
      }
    });

    return {
      ...curriculum,
      units: Array.from(unitMap.values()),
      unassigned_chapters: unassignedChapters,
      all_chapters: Array.from(chapterMap.values())
    };
  }

  /**
   * Create new curriculum
   */
  static async createCurriculum({ schoolId, academicYearId, classId, subjectId, name, description, createdBy, status = 'ACTIVE' }) {
    const numericSchoolId = Number(schoolId);

    // Compute next version
    const [latest] = await sql`
      SELECT COALESCE(MAX(version), 0) AS max_version
      FROM curricula
      WHERE school_id = ${numericSchoolId}
        AND academic_year_id = ${academicYearId}
        AND class_id = ${classId}
        AND subject_id = ${subjectId}
        AND deleted_at IS NULL
    `;
    const nextVersion = (latest?.max_version || 0) + 1;

    const [created] = await sql`
      INSERT INTO curricula (
        school_id, academic_year_id, class_id, subject_id, name,
        version, status, description, created_by
      ) VALUES (
        ${numericSchoolId}, ${academicYearId}, ${classId}, ${subjectId}, ${name},
        ${nextVersion}, ${status}, ${description || null}, ${createdBy || null}
      )
      RETURNING *
    `;

    return created;
  }

  /**
   * Update curriculum header details
   */
  static async updateCurriculum({ schoolId, curriculumId, data }) {
    const numericSchoolId = Number(schoolId);
    const { name, description, status } = data;

    const [updated] = await sql`
      UPDATE curricula
      SET
        name = COALESCE(${name}, name),
        description = COALESCE(${description}, description),
        status = COALESCE(${status}, status),
        updated_at = now()
      WHERE id = ${curriculumId}
        AND school_id = ${numericSchoolId}
        AND deleted_at IS NULL
      RETURNING *
    `;

    return updated;
  }

  /**
   * Create new version of an existing curriculum (non-destructive audit trail)
   */
  static async createNewVersion({ schoolId, curriculumId, createdBy }) {
    const numericSchoolId = Number(schoolId);
    const full = await this.getCurriculumById({ schoolId, curriculumId });
    if (!full) throw new Error('Curriculum not found');

    return sql.begin(async (tx) => {
      // 1. Get max version
      const [latest] = await tx`
        SELECT COALESCE(MAX(version), 0) AS max_version
        FROM curricula
        WHERE school_id = ${numericSchoolId}
          AND academic_year_id = ${full.academic_year_id}
          AND class_id = ${full.class_id}
          AND subject_id = ${full.subject_id}
          AND deleted_at IS NULL
      `;
      const nextVersion = (latest?.max_version || 0) + 1;

      // 2. Insert new curriculum version
      const [newCurriculum] = await tx`
        INSERT INTO curricula (
          school_id, academic_year_id, class_id, subject_id, name,
          version, status, description, created_by
        ) VALUES (
          ${numericSchoolId}, ${full.academic_year_id}, ${full.class_id}, ${full.subject_id},
          ${full.name}, ${nextVersion}, 'ACTIVE', ${full.description}, ${createdBy || null}
        )
        RETURNING *
      `;

      // 3. Clone units, chapters, topics
      const unitOldToNew = new Map();
      for (const unit of full.units) {
        const [clonedUnit] = await tx`
          INSERT INTO curriculum_units (
            school_id, curriculum_id, term_id, title, description, sequence, estimated_periods
          ) VALUES (
            ${numericSchoolId}, ${newCurriculum.id}, ${unit.term_id}, ${unit.title},
            ${unit.description}, ${unit.sequence}, ${unit.estimated_periods}
          )
          RETURNING *
        `;
        unitOldToNew.set(unit.id, clonedUnit.id);
      }

      for (const ch of full.all_chapters) {
        const newUnitId = ch.unit_id ? unitOldToNew.get(ch.unit_id) || null : null;
        const [clonedCh] = await tx`
          INSERT INTO curriculum_chapters (
            school_id, curriculum_id, unit_id, title, description, sequence, estimated_periods, weight
          ) VALUES (
            ${numericSchoolId}, ${newCurriculum.id}, ${newUnitId}, ${ch.title},
            ${ch.description}, ${ch.sequence}, ${ch.estimated_periods}, ${ch.weight}
          )
          RETURNING *
        `;

        for (const tp of (ch.topics || [])) {
          await tx`
            INSERT INTO curriculum_topics (
              school_id, chapter_id, title, description, sequence, estimated_periods, weight, is_optional
            ) VALUES (
              ${numericSchoolId}, ${clonedCh.id}, ${tp.title}, ${tp.description},
              ${tp.sequence}, ${tp.estimated_periods}, ${tp.weight}, ${tp.is_optional}
            )
          `;
        }
      }

      return newCurriculum;
    });
  }

  /**
   * Copy Curriculum to a new Academic Year
   * Copies structure and estimated periods, but omits execution progress, logs, or dates.
   */
  static async copyCurriculumToYear({ schoolId, sourceCurriculumId, targetAcademicYearId, createdBy }) {
    const numericSchoolId = Number(schoolId);
    const source = await this.getCurriculumById({ schoolId, curriculumId: sourceCurriculumId });
    if (!source) throw new Error('Source curriculum not found');

    return sql.begin(async (tx) => {
      // Find or start version 1 for target year
      const [existing] = await tx`
        SELECT COALESCE(MAX(version), 0) AS max_version
        FROM curricula
        WHERE school_id = ${numericSchoolId}
          AND academic_year_id = ${targetAcademicYearId}
          AND class_id = ${source.class_id}
          AND subject_id = ${source.subject_id}
          AND deleted_at IS NULL
      `;
      const version = (existing?.max_version || 0) + 1;

      const [newCurriculum] = await tx`
        INSERT INTO curricula (
          school_id, academic_year_id, class_id, subject_id, name,
          version, status, description, created_by
        ) VALUES (
          ${numericSchoolId}, ${targetAcademicYearId}, ${source.class_id}, ${source.subject_id},
          ${source.name}, ${version}, 'ACTIVE', ${source.description}, ${createdBy || null}
        )
        RETURNING *
      `;

      const unitOldToNew = new Map();
      for (const unit of source.units) {
        const [clonedUnit] = await tx`
          INSERT INTO curriculum_units (
            school_id, curriculum_id, term_id, title, description, sequence, estimated_periods
          ) VALUES (
            ${numericSchoolId}, ${newCurriculum.id}, null, ${unit.title},
            ${unit.description}, ${unit.sequence}, ${unit.estimated_periods}
          )
          RETURNING *
        `;
        unitOldToNew.set(unit.id, clonedUnit.id);
      }

      for (const ch of source.all_chapters) {
        const newUnitId = ch.unit_id ? unitOldToNew.get(ch.unit_id) || null : null;
        const [clonedCh] = await tx`
          INSERT INTO curriculum_chapters (
            school_id, curriculum_id, unit_id, title, description, sequence, estimated_periods, weight
          ) VALUES (
            ${numericSchoolId}, ${newCurriculum.id}, ${newUnitId}, ${ch.title},
            ${ch.description}, ${ch.sequence}, ${ch.estimated_periods}, ${ch.weight}
          )
          RETURNING *
        `;

        for (const tp of (ch.topics || [])) {
          await tx`
            INSERT INTO curriculum_topics (
              school_id, chapter_id, title, description, sequence, estimated_periods, weight, is_optional
            ) VALUES (
              ${numericSchoolId}, ${clonedCh.id}, ${tp.title}, ${tp.description},
              ${tp.sequence}, ${tp.estimated_periods}, ${tp.weight}, ${tp.is_optional}
            )
          `;
        }
      }

      return newCurriculum;
    });
  }

  // ── Unit CRUD ─────────────────────────────────────────────────────────────
  static async createUnit({ schoolId, curriculumId, termId, title, description, sequence, estimatedPeriods }) {
    const numericSchoolId = Number(schoolId);
    let seq = sequence;
    if (!seq) {
      const [maxRow] = await sql`
        SELECT COALESCE(MAX(sequence), 0) AS max_seq
        FROM curriculum_units
        WHERE curriculum_id = ${curriculumId} AND school_id = ${numericSchoolId} AND deleted_at IS NULL
      `;
      seq = (maxRow?.max_seq || 0) + 1;
    }

    const [unit] = await sql`
      INSERT INTO curriculum_units (
        school_id, curriculum_id, term_id, title, description, sequence, estimated_periods
      ) VALUES (
        ${numericSchoolId}, ${curriculumId}, ${termId || null}, ${title},
        ${description || null}, ${seq}, ${estimatedPeriods || 0}
      )
      RETURNING *
    `;
    return unit;
  }

  static async updateUnit({ schoolId, unitId, data }) {
    const numericSchoolId = Number(schoolId);
    const { title, description, term_id, sequence, estimated_periods } = data;
    const [updated] = await sql`
      UPDATE curriculum_units
      SET
        title = COALESCE(${title}, title),
        description = COALESCE(${description}, description),
        term_id = CASE WHEN ${term_id !== undefined} THEN ${term_id} ELSE term_id END,
        sequence = COALESCE(${sequence}, sequence),
        estimated_periods = COALESCE(${estimated_periods}, estimated_periods),
        updated_at = now()
      WHERE id = ${unitId} AND school_id = ${numericSchoolId} AND deleted_at IS NULL
      RETURNING *
    `;
    return updated;
  }

  static async deleteUnit({ schoolId, unitId }) {
    const numericSchoolId = Number(schoolId);
    const [deleted] = await sql`
      UPDATE curriculum_units
      SET deleted_at = now()
      WHERE id = ${unitId} AND school_id = ${numericSchoolId} AND deleted_at IS NULL
      RETURNING id
    `;
    return Boolean(deleted);
  }

  // ── Chapter CRUD ──────────────────────────────────────────────────────────
  static async createChapter({ schoolId, curriculumId, unitId, title, description, sequence, estimatedPeriods = 1, weight = 1.0 }) {
    const numericSchoolId = Number(schoolId);
    let seq = sequence;
    if (!seq) {
      const [maxRow] = await sql`
        SELECT COALESCE(MAX(sequence), 0) AS max_seq
        FROM curriculum_chapters
        WHERE curriculum_id = ${curriculumId} AND school_id = ${numericSchoolId} AND deleted_at IS NULL
      `;
      seq = (maxRow?.max_seq || 0) + 1;
    }

    const [chapter] = await sql`
      INSERT INTO curriculum_chapters (
        school_id, curriculum_id, unit_id, title, description, sequence, estimated_periods, weight
      ) VALUES (
        ${numericSchoolId}, ${curriculumId}, ${unitId || null}, ${title},
        ${description || null}, ${seq}, ${estimatedPeriods}, ${weight}
      )
      RETURNING *
    `;
    return chapter;
  }

  static async updateChapter({ schoolId, chapterId, data }) {
    const numericSchoolId = Number(schoolId);
    const { title, description, unit_id, sequence, estimated_periods, weight } = data;
    const [updated] = await sql`
      UPDATE curriculum_chapters
      SET
        title = COALESCE(${title}, title),
        description = COALESCE(${description}, description),
        unit_id = CASE WHEN ${unit_id !== undefined} THEN ${unit_id} ELSE unit_id END,
        sequence = COALESCE(${sequence}, sequence),
        estimated_periods = COALESCE(${estimated_periods}, estimated_periods),
        weight = COALESCE(${weight}, weight),
        updated_at = now()
      WHERE id = ${chapterId} AND school_id = ${numericSchoolId} AND deleted_at IS NULL
      RETURNING *
    `;
    return updated;
  }

  static async deleteChapter({ schoolId, chapterId }) {
    const numericSchoolId = Number(schoolId);
    const [deleted] = await sql`
      UPDATE curriculum_chapters
      SET deleted_at = now()
      WHERE id = ${chapterId} AND school_id = ${numericSchoolId} AND deleted_at IS NULL
      RETURNING id
    `;
    return Boolean(deleted);
  }

  // ── Topic CRUD ────────────────────────────────────────────────────────────
  static async createTopic({ schoolId, chapterId, title, description, sequence, estimatedPeriods = 1, weight = 1.0, isOptional = false }) {
    const numericSchoolId = Number(schoolId);
    let seq = sequence;
    if (!seq) {
      const [maxRow] = await sql`
        SELECT COALESCE(MAX(sequence), 0) AS max_seq
        FROM curriculum_topics
        WHERE chapter_id = ${chapterId} AND school_id = ${numericSchoolId} AND deleted_at IS NULL
      `;
      seq = (maxRow?.max_seq || 0) + 1;
    }

    const [topic] = await sql`
      INSERT INTO curriculum_topics (
        school_id, chapter_id, title, description, sequence, estimated_periods, weight, is_optional
      ) VALUES (
        ${numericSchoolId}, ${chapterId}, ${title}, ${description || null},
        ${seq}, ${estimatedPeriods}, ${weight}, ${Boolean(isOptional)}
      )
      RETURNING *
    `;
    return topic;
  }

  static async updateTopic({ schoolId, topicId, data }) {
    const numericSchoolId = Number(schoolId);
    const { title, description, sequence, estimated_periods, weight, is_optional } = data;
    const [updated] = await sql`
      UPDATE curriculum_topics
      SET
        title = COALESCE(${title}, title),
        description = COALESCE(${description}, description),
        sequence = COALESCE(${sequence}, sequence),
        estimated_periods = COALESCE(${estimated_periods}, estimated_periods),
        weight = COALESCE(${weight}, weight),
        is_optional = COALESCE(${is_optional}, is_optional),
        updated_at = now()
      WHERE id = ${topicId} AND school_id = ${numericSchoolId} AND deleted_at IS NULL
      RETURNING *
    `;
    return updated;
  }

  static async deleteTopic({ schoolId, topicId }) {
    const numericSchoolId = Number(schoolId);
    const [deleted] = await sql`
      UPDATE curriculum_topics
      SET deleted_at = now()
      WHERE id = ${topicId} AND school_id = ${numericSchoolId} AND deleted_at IS NULL
      RETURNING id
    `;
    return Boolean(deleted);
  }

  // ── Bulk Reordering ───────────────────────────────────────────────────────
  static async reorderUnits({ schoolId, curriculumId, unitIds }) {
    const numericSchoolId = Number(schoolId);
    return sql.begin(async (tx) => {
      for (let i = 0; i < unitIds.length; i++) {
        await tx`
          UPDATE curriculum_units
          SET sequence = ${i + 1}, updated_at = now()
          WHERE id = ${unitIds[i]} AND curriculum_id = ${curriculumId} AND school_id = ${numericSchoolId}
        `;
      }
      return true;
    });
  }

  static async reorderChapters({ schoolId, curriculumId, chapterIds }) {
    const numericSchoolId = Number(schoolId);
    return sql.begin(async (tx) => {
      for (let i = 0; i < chapterIds.length; i++) {
        await tx`
          UPDATE curriculum_chapters
          SET sequence = ${i + 1}, updated_at = now()
          WHERE id = ${chapterIds[i]} AND curriculum_id = ${curriculumId} AND school_id = ${numericSchoolId}
        `;
      }
      return true;
    });
  }

  static async reorderTopics({ schoolId, chapterId, topicIds }) {
    const numericSchoolId = Number(schoolId);
    return sql.begin(async (tx) => {
      for (let i = 0; i < topicIds.length; i++) {
        await tx`
          UPDATE curriculum_topics
          SET sequence = ${i + 1}, updated_at = now()
          WHERE id = ${topicIds[i]} AND chapter_id = ${chapterId} AND school_id = ${numericSchoolId}
        `;
      }
      return true;
    });
  }
}

export default CurriculumService;
