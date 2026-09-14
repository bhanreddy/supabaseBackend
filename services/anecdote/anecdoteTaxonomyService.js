import sql from '../../db.js';

/**
 * Default taxonomy keyword dictionary for deterministic NLP/token classification.
 * Matches user observation statements against domain vocabulary.
 */
const TAXONOMY_RULES = [
  // --- Social / Leadership / Peer Support ---
  {
    category: 'SOCIAL',
    subcategory: 'PEER_SUPPORT',
    type: 'RECOGNITION',
    sentiment: 'POSITIVE',
    severity: 'LEVEL_1_POSITIVE',
    skills: ['Peer Support', 'Empathy', 'Collaboration'],
    keywords: ['helped', 'helping', 'assisting', 'assisted', 'guided', 'tutored', 'supported classmate', 'peer', 'shared notes', 'explained problem', 'comforted', 'encouraged classmate'],
  },
  {
    category: 'SOCIAL',
    subcategory: 'LEADERSHIP',
    type: 'RECOGNITION',
    sentiment: 'POSITIVE',
    severity: 'LEVEL_1_POSITIVE',
    skills: ['Leadership', 'Initiative', 'Responsibility'],
    keywords: ['led', 'leader', 'leadership', 'initiative', 'organized group', 'coordinated', 'captain', 'monitor', 'took charge', 'guided the team'],
  },
  {
    category: 'SOCIAL',
    subcategory: 'TEAMWORK',
    type: 'OBSERVATION',
    sentiment: 'POSITIVE',
    severity: 'LEVEL_1_POSITIVE',
    skills: ['Teamwork', 'Collaboration'],
    keywords: ['teamwork', 'group work', 'collaborative', 'worked together', 'cooperative in group', 'team player', 'joint presentation'],
  },
  {
    category: 'SOCIAL',
    subcategory: 'INCLUSIVENESS',
    type: 'RECOGNITION',
    sentiment: 'POSITIVE',
    severity: 'LEVEL_1_POSITIVE',
    skills: ['Inclusiveness', 'Empathy'],
    keywords: ['included', 'welcomed', 'invited new student', 'made feel welcome', 'stood up for', 'befriended'],
  },

  // --- Academic ---
  {
    category: 'ACADEMIC',
    subcategory: 'CONCEPT_MASTERY',
    type: 'RECOGNITION',
    sentiment: 'POSITIVE',
    severity: 'LEVEL_1_POSITIVE',
    skills: ['Critical Thinking', 'Concept Mastery'],
    keywords: ['grasped quickly', 'solved advanced', 'exceptional understanding', 'deep insight', 'concept mastery', 'perfect explanation', 'quick learner'],
  },
  {
    category: 'ACADEMIC',
    subcategory: 'ACAD_IMPROVEMENT',
    type: 'IMPROVEMENT',
    sentiment: 'POSITIVE',
    severity: 'LEVEL_1_POSITIVE',
    skills: ['Perseverance', 'Growth Mindset'],
    keywords: ['improved', 'improvement', 'steady progress', 'better score', 'practiced diligently', 'turned around', 'great bounce back'],
  },
  {
    category: 'ACADEMIC',
    subcategory: 'HOMEWORK',
    type: 'CONCERN',
    sentiment: 'ATTENTION',
    severity: 'LEVEL_2_WATCH',
    skills: ['Work Ethic', 'Consistency'],
    keywords: ['homework incomplete', 'incomplete homework', 'forgot homework', 'no homework', 'homework missing', 'failed to submit homework', 'unprepared notebook', 'did not bring notebook'],
  },
  {
    category: 'ACADEMIC',
    subcategory: 'ACAD_CONCERN',
    type: 'CONCERN',
    sentiment: 'CONCERN',
    severity: 'LEVEL_3_ATTENTION',
    skills: ['Academic Support'],
    keywords: ['struggling with', 'difficulty understanding', 'failing tests', 'unable to solve', 'declining scores', 'academic difficulty', 'low marks', 'confused in algebra', 'unable to follow lesson'],
  },

  // --- Behaviour ---
  {
    category: 'BEHAVIOUR',
    subcategory: 'RESPONSIBILITY',
    type: 'RECOGNITION',
    sentiment: 'POSITIVE',
    severity: 'LEVEL_1_POSITIVE',
    skills: ['Responsibility', 'Integrity'],
    keywords: ['responsible', 'honest', 'returned lost item', 'volunteered to clean', 'dutiful', 'punctual in submission', 'dependable'],
  },
  {
    category: 'BEHAVIOUR',
    subcategory: 'RESPECT',
    type: 'RECOGNITION',
    sentiment: 'POSITIVE',
    severity: 'LEVEL_1_POSITIVE',
    skills: ['Respect', 'Manners'],
    keywords: ['polite', 'respectful', 'courteous', 'greeted well', 'mannerly', 'attentive listener'],
  },
  {
    category: 'BEHAVIOUR',
    subcategory: 'DISRUPTION',
    type: 'INCIDENT',
    sentiment: 'CONCERN',
    severity: 'LEVEL_2_WATCH',
    skills: ['Self-Regulation'],
    keywords: ['disrupting', 'disrupted', 'talking during lecture', 'distracting others', 'shouting', 'throwing paper', 'restless in class', 'interrupting teacher'],
  },
  {
    category: 'BEHAVIOUR',
    subcategory: 'CONFLICT',
    type: 'INCIDENT',
    sentiment: 'CONCERN',
    severity: 'LEVEL_3_ATTENTION',
    skills: ['Conflict Resolution'],
    keywords: ['fight', 'fought', 'quarreled', 'argued aggressively', 'pushing classmate', 'bullying', 'verbal abuse', 'physical altercation', 'heated dispute'],
  },
  {
    category: 'BEHAVIOUR',
    subcategory: 'RULE_COMPLIANCE',
    type: 'CONCERN',
    sentiment: 'ATTENTION',
    severity: 'LEVEL_2_WATCH',
    skills: ['Compliance'],
    keywords: ['without uniform', 'improper uniform', 'mobile phone in class', 'bunking', 'unauthorized leave', 'violated lab rule'],
  },

  // --- Achievement ---
  {
    category: 'ACHIEVEMENT',
    subcategory: 'COMPETITION',
    type: 'ACHIEVEMENT',
    sentiment: 'ACHIEVEMENT',
    severity: 'LEVEL_1_POSITIVE',
    skills: ['Excellence', 'Competition'],
    keywords: ['won 1st prize', 'won prize', 'won medal', 'first place', 'olympiad gold', 'champion', 'quiz winner', 'competition victory', 'certificate of merit', 'award', 'awarded'],
  },
  {
    category: 'ACHIEVEMENT',
    subcategory: 'SPORTS',
    type: 'ACHIEVEMENT',
    sentiment: 'ACHIEVEMENT',
    severity: 'LEVEL_1_POSITIVE',
    skills: ['Athleticism', 'Sportsmanship'],
    keywords: ['scored goal', 'man of the match', 'cricket tournament', 'athletics race', 'badminton win', 'sports day gold', 'basketball championship'],
  },
  {
    category: 'ACHIEVEMENT',
    subcategory: 'ARTS',
    type: 'ACHIEVEMENT',
    sentiment: 'ACHIEVEMENT',
    severity: 'LEVEL_1_POSITIVE',
    skills: ['Creativity', 'Arts'],
    keywords: ['drawing competition', 'singing contest', 'drama performance', 'art exhibition', 'dance award', 'cultural fest winner'],
  },

  // --- Attendance ---
  {
    category: 'ATTENDANCE',
    subcategory: 'LATE_ARRIVAL',
    type: 'CONCERN',
    sentiment: 'ATTENTION',
    severity: 'LEVEL_2_WATCH',
    skills: ['Punctuality'],
    keywords: ['late to school', 'late arrival', 'arrived after bell', 'missed morning assembly', 'tardy', 'delayed reporting'],
  },
  {
    category: 'ATTENDANCE',
    subcategory: 'REPEATED_ABSENCE',
    type: 'CONCERN',
    sentiment: 'CONCERN',
    severity: 'LEVEL_3_ATTENTION',
    skills: ['Consistency'],
    keywords: ['absent for 3 days', 'frequent absence', 'uninformed absence', 'repeated absence', 'chronic absence', 'irregular attendance'],
  },

  // --- Participation ---
  {
    category: 'PARTICIPATION',
    subcategory: 'CLASS_PARTICIPATION',
    type: 'OBSERVATION',
    sentiment: 'POSITIVE',
    severity: 'LEVEL_1_POSITIVE',
    skills: ['Engagement', 'Curiosity'],
    keywords: ['active participant', 'raised hand', 'answered enthusiastically', 'asked thoughtful questions', 'contributed to debate', 'engaged throughout'],
  }
];

const CONTEXT_KEYWORDS = {
  classroom: ['class', 'classroom', 'period', 'lecture', 'blackboard', 'desk', 'lesson', 'teacher'],
  playground: ['playground', 'ground', 'recess', 'lunch time', 'interval', 'break', 'games'],
  laboratory: ['lab', 'laboratory', 'practical', 'experiment', 'beaker', 'computer lab', 'science lab'],
  sports_field: ['field', 'court', 'track', 'pitch', 'stadium', 'football field', 'cricket ground'],
  bus: ['bus', 'van', 'transit', 'route', 'driver', 'bus stop'],
  assembly: ['assembly', 'prayer', 'auditorium', 'morning line', 'pledge'],
  corridor: ['corridor', 'hallway', 'staircase', 'passage'],
  cafeteria: ['canteen', 'cafeteria', 'mess', 'dining', 'lunch hall'],
};

/**
 * Fetch taxonomy categories with their subcategories for a given school.
 */
export async function getTaxonomy({ schoolId }) {
  const categories = await sql`
    SELECT id, school_id, code, name, description, icon, color, is_system, sort_order
    FROM public.anecdote_categories
    WHERE school_id IS NULL OR school_id = ${schoolId}
    ORDER BY sort_order ASC, name ASC
  `;

  const categoryIds = categories.map((c) => c.id);
  let subcategories = [];
  if (categoryIds.length > 0) {
    subcategories = await sql`
      SELECT id, category_id, code, name, description, is_system, sort_order
      FROM public.anecdote_subcategories
      WHERE category_id IN ${sql(categoryIds)}
      ORDER BY sort_order ASC, name ASC
    `;
  }

  const subcatMap = new Map();
  for (const sub of subcategories) {
    if (!subcatMap.has(sub.category_id)) {
      subcatMap.set(sub.category_id, []);
    }
    subcatMap.get(sub.category_id).push(sub);
  }

  return categories.map((cat) => ({
    ...cat,
    subcategories: subcatMap.get(cat.id) || [],
  }));
}

/**
 * Deterministic keyword & token inference engine.
 * Classifies teacher observation text without LLM latency or cost.
 *
 * @param {string} text - Raw observation statement from teacher
 * @returns {object} Inferred categorization metadata
 */
export function inferAnecdoteTaxonomy(text = '') {
  const normalized = String(text).toLowerCase().trim();
  if (!normalized) {
    return {
      category_code: 'BEHAVIOUR',
      subcategory_code: 'CLASSROOM_CONDUCT',
      observation_type: 'OBSERVATION',
      sentiment: 'NEUTRAL',
      severity: 'LEVEL_0_INFORMATIONAL',
      context: 'classroom',
      suggested_skills: [],
      matched_keywords: [],
      confidence: 'LOW',
    };
  }

  let bestRule = null;
  let maxMatchedScore = 0;
  let matchedTokens = [];

  for (const rule of TAXONOMY_RULES) {
    let score = 0;
    const ruleMatched = [];
    for (const kw of rule.keywords) {
      if (normalized.includes(kw.toLowerCase())) {
        score += kw.split(' ').length * 2; // multi-word match gives higher weight
        ruleMatched.push(kw);
      }
    }
    if (score > maxMatchedScore) {
      maxMatchedScore = score;
      bestRule = rule;
      matchedTokens = ruleMatched;
    }
  }

  // Infer Context: score each context using word boundaries so 'playground' or 'laboratory' isn't shadowed by 'class' inside 'classmate'
  let inferredContext = 'classroom';
  let maxContextScore = 0;
  for (const [ctx, kws] of Object.entries(CONTEXT_KEYWORDS)) {
    let ctxScore = 0;
    for (const kw of kws) {
      const regex = new RegExp(`\\b${kw}\\b`, 'i');
      if (regex.test(normalized)) {
        // Specific locations like playground, lab, sports_field, bus get higher priority
        const weight = (ctx === 'classroom' && kw === 'class') ? 1 : 2;
        ctxScore += weight;
      }
    }
    if (ctxScore > maxContextScore) {
      maxContextScore = ctxScore;
      inferredContext = ctx;
    }
  }

  if (bestRule && maxMatchedScore > 0) {
    const confidence = maxMatchedScore >= 2 ? 'HIGH' : 'MODERATE';
    return {
      category_code: bestRule.category,
      subcategory_code: bestRule.subcategory,
      observation_type: bestRule.type,
      sentiment: bestRule.sentiment,
      severity: bestRule.severity,
      context: inferredContext,
      suggested_skills: bestRule.skills,
      matched_keywords: matchedTokens,
      confidence,
    };
  }

  // Fallback defaults if no specific keywords hit
  const isPositiveGeneral = ['good', 'great', 'excellent', 'well', 'star', 'nice', 'appreciated', 'proud'].some((w) => normalized.includes(w));
  const isConcernGeneral = ['bad', 'poor', 'warning', 'trouble', 'complaint', 'problem', 'unacceptable'].some((w) => normalized.includes(w));

  if (isPositiveGeneral) {
    return {
      category_code: 'ACADEMIC',
      subcategory_code: 'LEARNING_PROGRESS',
      observation_type: 'RECOGNITION',
      sentiment: 'POSITIVE',
      severity: 'LEVEL_1_POSITIVE',
      context: inferredContext,
      suggested_skills: ['General Progress'],
      matched_keywords: [],
      confidence: 'LOW',
    };
  }

  if (isConcernGeneral) {
    return {
      category_code: 'BEHAVIOUR',
      subcategory_code: 'DISCIPLINE',
      observation_type: 'CONCERN',
      sentiment: 'CONCERN',
      severity: 'LEVEL_2_WATCH',
      context: inferredContext,
      suggested_skills: ['Attention'],
      matched_keywords: [],
      confidence: 'LOW',
    };
  }

  return {
    category_code: 'BEHAVIOUR',
    subcategory_code: 'CLASSROOM_CONDUCT',
    observation_type: 'OBSERVATION',
    sentiment: 'NEUTRAL',
    severity: 'LEVEL_0_INFORMATIONAL',
    context: inferredContext,
    suggested_skills: [],
    matched_keywords: [],
    confidence: 'LOW',
  };
}

/**
 * NLP Adapter interface: Ready for future LLM integration.
 * In Phase 1, delegates to deterministic rule matcher.
 * When LLM is configured, LLM output is validated against this taxonomy schema.
 */
export async function parseNLPStructuredInput(text, { schoolId } = {}) {
  const deterministicResult = inferAnecdoteTaxonomy(text);
  // Retrieve concrete DB category & subcategory IDs
  const [categoryRow] = await sql`
    SELECT id FROM public.anecdote_categories
    WHERE code = ${deterministicResult.category_code}
      AND (school_id IS NULL OR school_id = ${schoolId || null})
    LIMIT 1
  `;

  let subcategoryRow = null;
  if (categoryRow) {
    [subcategoryRow] = await sql`
      SELECT id FROM public.anecdote_subcategories
      WHERE category_id = ${categoryRow.id}
        AND code = ${deterministicResult.subcategory_code}
      LIMIT 1
    `;
  }

  return {
    ...deterministicResult,
    category_id: categoryRow?.id || null,
    subcategory_id: subcategoryRow?.id || null,
  };
}
