import sql from '../db.js';
import { normalizeEventConfiguration } from './eventModuleUtils.js';

/**
 * AI Event Assistant extension point.
 * Core Event Management never depends on an LLM. This service only stores
 * human-reviewable drafts generated from a structured prompt.
 */
export const EventAssistantService = {
  proposeDraft({ schoolId, prompt, userId }) {
    const text = String(prompt || '').trim();
    if (!text) {
      const err = new Error('prompt is required');
      err.statusCode = 400;
      throw err;
    }

    const lower = text.toLowerCase();
    const isTrip = /trip|picnic|visit|excursion/.test(lower);
    const isSports = /sport|race|athlet/.test(lower);
    const isQuiz = /quiz|debate|coding/.test(lower);
    const isFair = /fair|expo|science|exhibition/.test(lower);

    const category = isTrip ? 'EDUCATIONAL_TRIP'
      : isSports ? 'SPORTS'
      : isQuiz ? 'QUIZ'
      : isFair ? 'SCIENCE_FAIR'
      : 'CUSTOM';

    const configuration = normalizeEventConfiguration({
      modules: {
        registration: true,
        consent: isTrip || isSports,
        payments: isTrip,
        transport: isTrip,
        competition: isSports || isQuiz || isFair,
        qr_passes: true,
        tasks: true,
        expenses: true,
        certificates: isSports || isQuiz || isFair,
        gallery: true,
        feedback: true,
        volunteers: !isQuiz,
      },
      constraints: { fee_amount: isTrip ? 500 : 0, capacity_limit: null },
      approval_flow: ['PRINCIPAL'],
    });

    const draft = {
      title: text.length > 80 ? `${category.replace(/_/g, ' ')} proposal` : text,
      category,
      description: `Draft generated from operator prompt. Human approval is required before publish or spend.`,
      configuration,
      suggested_teams: isTrip
        ? [{ name: 'Transport' }, { name: 'Medical' }, { name: 'Discipline' }]
        : [{ name: 'Event Head' }, { name: 'Registration' }, { name: 'Hospitality' }],
      suggested_tasks: [
        { title: 'Confirm venue and schedule', priority: 'HIGH' },
        { title: 'Notify target audience', priority: 'MEDIUM' },
        { title: 'Prepare day-of operations checklist', priority: 'MEDIUM' },
      ],
      requires_human_approval: true,
    };

    return { schoolId, created_by: userId || null, prompt: text, draft };
  },

  async saveDraft({ schoolId, prompt, userId, draft }) {
    const [row] = await sql`
      INSERT INTO event_ai_drafts (school_id, created_by, prompt, draft_payload, status)
      VALUES (${schoolId}, ${userId || null}, ${prompt}, ${sql.json(draft)}, 'DRAFT')
      RETURNING *
    `;
    return row;
  },
};

export default EventAssistantService;
