/**
 * Shared Event Engine helpers — module aliases, type mapping, request field picking.
 * Keep event-type business logic generic; never hard-code a school or a single event kind.
 */

const LEGACY_EVENT_TYPES = new Set(['academic', 'cultural', 'sports', 'holiday', 'meeting', 'exam', 'other']);

const EVENT_TYPE_MAP = {
  SCHOOL_EVENT: 'other',
  SPORTS: 'sports',
  COMPETITION: 'sports',
  TRIP: 'other',
  FIELD_TRIP: 'other',
  EDUCATIONAL_TRIP: 'other',
  CELEBRATION: 'cultural',
  ANNUAL_DAY: 'cultural',
  STAFF_MEETING: 'meeting',
  PTM: 'meeting',
  WORKSHOP: 'academic',
  SEMINAR: 'academic',
  QUIZ: 'academic',
  SCIENCE_FAIR: 'academic',
  ACADEMIC: 'academic',
  CULTURAL: 'cultural',
  HOLIDAY: 'holiday',
  EXAM: 'exam',
  MEETING: 'meeting',
};

export function pickField(source, ...keys) {
  if (!source || typeof source !== 'object') return undefined;
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== '') {
      return source[key];
    }
  }
  return undefined;
}

export function mapLegacyEventType(value) {
  if (!value) return 'other';
  const raw = String(value).trim();
  const lower = raw.toLowerCase();
  if (LEGACY_EVENT_TYPES.has(lower)) return lower;
  return EVENT_TYPE_MAP[raw.toUpperCase()] || 'other';
}

export function splitDateTime(value) {
  if (!value) return { date: null, time: null };
  const str = String(value).trim();
  if (str.includes('T')) {
    const [d, rest] = str.split('T');
    return { date: d.slice(0, 10), time: (rest || '').replace('Z', '').slice(0, 8) || null };
  }
  if (/\s/.test(str) && str.length > 10) {
    const [d, t] = str.split(/\s+/);
    return { date: d.slice(0, 10), time: (t || '').slice(0, 8) || null };
  }
  return { date: str.slice(0, 10), time: null };
}

export function normalizeEventConfiguration(input = {}) {
  const source = input.configuration || input.config || input || {};
  const modulesIn = source.modules || {};
  const constraintsIn = source.constraints || {};

  const modules = {
    registration: modulesIn.registration !== false,
    consent: Boolean(modulesIn.consent),
    payments: Boolean(modulesIn.payments || Number(constraintsIn.fee_amount) > 0),
    transport: Boolean(modulesIn.transport),
    competition: Boolean(modulesIn.competition || modulesIn.competitions),
    attendance: modulesIn.attendance !== false,
    qr_passes: Boolean(modulesIn.qr_passes || modulesIn.ticketing),
    guests: Boolean(modulesIn.guests),
    volunteers: Boolean(modulesIn.volunteers),
    tasks: modulesIn.tasks !== false,
    vendors: Boolean(modulesIn.vendors),
    expenses: Boolean(modulesIn.expenses || modulesIn.budget),
    certificates: Boolean(modulesIn.certificates),
    gallery: modulesIn.gallery !== false,
    feedback: modulesIn.feedback !== false,
  };

  // Frontend aliases — keep both spellings in persisted JSON so tabs render.
  modules.ticketing = modules.qr_passes;
  modules.budget = modules.expenses;
  modules.competitions = modules.competition;

  return {
    modules,
    constraints: {
      max_activities_per_student: Number(constraintsIn.max_activities_per_student || 3),
      capacity_limit: constraintsIn.capacity_limit ?? constraintsIn.max_capacity ?? null,
      fee_amount: Number(constraintsIn.fee_amount || 0),
      min_staff_required: constraintsIn.min_staff_required ?? null,
      requires_consent: constraintsIn.requires_consent ?? modules.consent,
      consent_deadline: constraintsIn.consent_deadline || null,
      registration_deadline: constraintsIn.registration_deadline || null,
    },
    approval_flow: Array.isArray(source.approval_flow) && source.approval_flow.length
      ? source.approval_flow
      : ['PRINCIPAL'],
    notifications: source.notifications || {},
    ai_extension: source.ai_extension || { enabled: false, last_draft_id: null },
  };
}

export function isModuleEnabled(configuration, key) {
  const modules = configuration?.modules || {};
  if (key === 'ticketing' || key === 'qr_passes') return Boolean(modules.qr_passes || modules.ticketing);
  if (key === 'budget' || key === 'expenses') return Boolean(modules.expenses || modules.budget);
  if (key === 'competition' || key === 'competitions') return Boolean(modules.competition || modules.competitions);
  return Boolean(modules[key]);
}

export function nextApprovalStage(flow = ['PRINCIPAL'], currentStage) {
  const stages = Array.isArray(flow) && flow.length ? flow : ['PRINCIPAL'];
  const idx = stages.indexOf(currentStage);
  if (idx < 0) return stages[0];
  return stages[idx + 1] || null;
}

export function mapBoardingStatus(status) {
  const raw = String(status || 'PENDING').toUpperCase();
  if (raw === 'NOT_BOARDED') return 'PENDING';
  if (raw === 'DROPPED') return 'RETURNED';
  return raw;
}
