import sql from '../db.js';
import logger from '../utils/logger.js';
import { forwardGenerate } from './paperforgeProxy.service.js';

export const QUESTION_TYPES = {
  MCQ: 'MCQ',
  VSA: 'VSA',
  SA: 'SA',
  LA: 'LA',
};

export const DIFFICULTY_LEVELS = {
  EASY: 'EASY',
  MEDIUM: 'MEDIUM',
  HARD: 'HARD',
};

export const BLOOM_LEVELS = {
  KNOWLEDGE: 'KNOWLEDGE',
  UNDERSTANDING: 'UNDERSTANDING',
  APPLICATION: 'APPLICATION',
  ANALYSIS: 'ANALYSIS',
  EVALUATION: 'EVALUATION',
  CREATION: 'CREATION',
};

/**
 * Validate and normalize blueprint before sending to engine.
 */
export function validateBlueprint(blueprint = {}) {
  if (!blueprint.class_level || !String(blueprint.class_level).trim()) {
    throw new Error('Class level is required');
  }
  if (!Array.isArray(blueprint.sections) || blueprint.sections.length === 0) {
    throw new Error('At least one section is required in blueprint');
  }

  let totalMarks = 0;
  let totalQuestions = 0;

  for (let i = 0; i < blueprint.sections.length; i++) {
    const s = blueprint.sections[i];
    if (!s.subject || !String(s.subject).trim()) {
      throw new Error(`Section ${i + 1} must specify a subject`);
    }
    if (!s.question_type || !QUESTION_TYPES[s.question_type]) {
      throw new Error(`Section ${i + 1} has invalid question type: ${s.question_type}`);
    }
    const count = Number.parseInt(s.count, 10);
    if (!Number.isFinite(count) || count <= 0 || count > 50) {
      throw new Error(`Section ${i + 1} count must be between 1 and 50`);
    }
    const marksPerQ = Number.parseInt(s.marks_per_question, 10);
    if (!Number.isFinite(marksPerQ) || marksPerQ <= 0 || marksPerQ > 100) {
      throw new Error(`Section ${i + 1} marks_per_question must be between 1 and 100`);
    }

    totalQuestions += count;
    totalMarks += count * marksPerQ;
  }

  if (totalQuestions > 200) {
    throw new Error('A blueprint may request at most 200 questions');
  }

  return {
    valid: true,
    totalMarks,
    totalQuestions,
  };
}

/**
 * Generate question paper via PaperForge Engine and persist result in SchoolIMS.
 */
export async function generateQuestionPaper({
  schoolId,
  userId,
  subject,
  classLevel,
  examName,
  title,
  blueprint,
  options = {},
}) {
  if (!schoolId || !userId || !subject || !classLevel) {
    throw new Error('schoolId, userId, subject, and classLevel are required');
  }

  // Ensure consistent blueprint structure
  const normalizedBlueprint = {
    blueprint_id: blueprint.blueprint_id || `bp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    class_level: classLevel,
    board: blueprint.board || 'CBSE',
    tolerance_pct: blueprint.tolerance_pct ?? 10.0,
    language: blueprint.language || 'en',
    sections: (blueprint.sections || []).map((sec) => ({
      subject: sec.subject || subject,
      chapters: Array.isArray(sec.chapters) ? sec.chapters : [],
      question_type: sec.question_type || 'MCQ',
      count: Number(sec.count) || 1,
      marks_per_question: Number(sec.marks_per_question) || 1,
      bloom_target: sec.bloom_target || 'UNDERSTANDING',
      difficulty: sec.difficulty || 'MEDIUM',
      topic: sec.topic || null,
    })),
  };

  const blueprintSummary = validateBlueprint(normalizedBlueprint);

  // Request payload formatted strictly for PaperForge engine
  const engineRequest = {
    blueprint: normalizedBlueprint,
    subject,
    class_level: classLevel,
    document_id: options.document_id || null,
    options: {
      allow_regeneration: options.allow_regeneration ?? true,
      language: options.language || 'en',
    },
  };

  // 1. Forward generation call to engine
  const engineResponse = await forwardGenerate({
    schoolId,
    userId,
    blueprint: engineRequest,
  });

  const paperId = engineResponse.paper_id || null;
  const questions = Array.isArray(engineResponse.questions) ? engineResponse.questions : [];
  const compliance = engineResponse.compliance || {};

  // 2. Persist in generated_papers
  const [saved] = await sql`
    INSERT INTO generated_papers (
      school_id,
      paper_id,
      subject,
      subject_id,
      class_level,
      exam_name,
      title,
      blueprint,
      sections,
      questions,
      compliance,
      status,
      total_marks,
      created_by,
      created_by_user,
      created_at
    )
    VALUES (
      ${schoolId},
      ${paperId},
      ${subject},
      ${subject},
      ${classLevel},
      ${examName || null},
      ${title || `${subject} - ${classLevel} Question Paper`},
      ${sql.json(normalizedBlueprint)},
      ${sql.json(normalizedBlueprint.sections)},
      ${sql.json(questions)},
      ${sql.json(compliance)},
      'READY',
      ${blueprintSummary.totalMarks},
      ${userId},
      ${userId},
      ${new Date().toISOString()}
    )
    RETURNING *
  `;

  // 3. Audit log event
  try {
    await sql`
      INSERT INTO audit_logs (school_id, user_id, action, entity, entity_id, details)
      VALUES (
        ${schoolId},
        ${userId},
        'paperforge.generated',
        'generated_papers',
        ${saved.id}::text,
        ${sql.json({
          paper_id: paperId,
          subject,
          class_level: classLevel,
          question_count: questions.length,
          total_marks: compliance?.achieved?.total_marks || normalizedBlueprint.sections.reduce((acc, s) => acc + s.count * s.marks_per_question, 0),
        })}
      )
    `;
  } catch (auditErr) {
    logger.warn({ err: auditErr.message }, 'Failed to write paperforge generation audit log');
  }

  return {
    ...saved,
    engineResponse,
  };
}

/**
 * List generated papers for a school, optionally filtered by teacher.
 */
export async function listGeneratedPapers(schoolId, { userId = null, limit = 20, offset = 0 } = {}) {
  return sql`
    SELECT
      gp.id,
      gp.paper_id,
      gp.subject,
      gp.class_level,
      gp.exam_name,
      gp.title,
      gp.status,
      gp.created_at,
      gp.updated_at,
      jsonb_array_length(gp.questions) AS question_count,
      p.display_name AS created_by_name
    FROM generated_papers gp
    LEFT JOIN users u ON gp.created_by_user = u.id AND u.school_id=${schoolId}
    LEFT JOIN persons p ON u.person_id = p.id AND p.school_id=${schoolId}
    WHERE gp.school_id = ${schoolId}
      ${userId ? sql`AND gp.created_by_user = ${userId}` : sql``}
    ORDER BY gp.created_at DESC
    LIMIT ${limit}
    OFFSET ${offset}
  `;
}

/**
 * Get generated paper details.
 */
export async function getGeneratedPaperById(schoolId, paperRecordId, { userId = null } = {}) {
  const [paper] = await sql`
    SELECT
      gp.*,
      p.display_name AS created_by_name
    FROM generated_papers gp
    LEFT JOIN users u ON gp.created_by_user = u.id AND u.school_id=${schoolId}
    LEFT JOIN persons p ON u.person_id = p.id AND p.school_id=${schoolId}
    WHERE (gp.id::text = ${String(paperRecordId)} OR gp.paper_id = ${String(paperRecordId)})
      AND gp.school_id = ${schoolId}
      ${userId ? sql`AND gp.created_by_user = ${userId}` : sql``}
    LIMIT 1
  `;
  return paper || null;
}

/**
 * Update questions in generated paper (teacher edits).
 */
export async function updateGeneratedPaperQuestions(schoolId, paperRecordId, { questions, title, examName, userId = null }) {
  const [updated] = await sql`
    UPDATE generated_papers
    SET
      questions = COALESCE(${questions ? sql.json(questions) : null}, questions),
      title = COALESCE(${title || null}, title),
      exam_name = COALESCE(${examName || null}, exam_name),
      updated_at = now()
    WHERE id::text = ${String(paperRecordId)}
      AND school_id = ${schoolId}
      ${userId ? sql`AND created_by_user = ${userId}` : sql``}
    RETURNING *
  `;
  return updated || null;
}
