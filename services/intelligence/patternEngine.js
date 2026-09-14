import sql from '../../db.js';

/**
 * Persists detected patterns from evaluated rules.
 */
export async function recordDetectedPatterns({ schoolId, studentId, ruleMatches = [] }) {
  const patterns = [];

  for (const match of ruleMatches) {
    const { pattern_type, title, summary, supportingSignals } = match;

    const [dup] = await sql`
      SELECT *
      FROM public.intelligence_patterns
      WHERE school_id = ${schoolId}
        AND student_id = ${studentId}
        AND pattern_type = ${pattern_type}
        AND detected_at >= now() - INTERVAL '24 hours'
      ORDER BY detected_at DESC
      LIMIT 1
    `;
    if (dup) {
      patterns.push(dup);
      continue;
    }

    const [pattern] = await sql`
      INSERT INTO public.intelligence_patterns (
        school_id,
        student_id,
        pattern_type,
        name,
        description,
        supporting_signal_ids,
        frequency_count,
        window_start,
        window_end
      ) VALUES (
        ${schoolId},
        ${studentId},
        ${pattern_type},
        ${title},
        ${summary},
        ${sql.json(supportingSignals || [])},
        1,
        now() - INTERVAL '30 days',
        now()
      )
      RETURNING *
    `;
    patterns.push(pattern);
  }

  return patterns;
}
