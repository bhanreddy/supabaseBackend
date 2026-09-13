/**
 * Central academic-calendar event type catalogue.
 * UI, import, and module sync must map through this file — never hard-code colors/labels elsewhere.
 */

export const CALENDAR_EVENT_TYPES = [
  'HOLIDAY',
  'VACATION',
  'WORKING_DAY',
  'SPECIAL_WORKING_DAY',
  'EXAM',
  'TEST',
  'RESULT',
  'PTM',
  'SCHOOL_EVENT',
  'SPORTS',
  'COMPETITION',
  'TRIP',
  'STAFF_MEETING',
  'TRAINING',
  'FEE_DUE',
  'FEE_LATE_DATE',
  'ADMISSION',
  'DOCUMENT_DEADLINE',
  'HOMEWORK',
  'PROJECT',
  'ASSEMBLY',
  'CELEBRATION',
  'TRANSPORT_EVENT',
  'CUSTOM',
];

export const EVENT_TYPE_ALIASES = {
  MEETING: 'PTM',
  ACTIVITY: 'SCHOOL_EVENT',
  HOMEWORK_DUE: 'HOMEWORK',
  CULTURAL: 'CELEBRATION',
  STAFF_TRAINING: 'TRAINING',
  GENERAL: 'SCHOOL_EVENT',
  ANNUAL_DAY: 'CELEBRATION',
  HOLIDAY: 'HOLIDAY',
};

export const HOLIDAY_TYPE_ALIASES = {
  NATIONAL: 'PUBLIC_HOLIDAY',
  STATE: 'LOCAL_HOLIDAY',
  REGIONAL: 'LOCAL_HOLIDAY',
  SCHOOL_DECLARED: 'SCHOOL_HOLIDAY',
  EMERGENCY_UNPLANNED: 'EMERGENCY_HOLIDAY',
  PUBLIC_HOLIDAY: 'PUBLIC_HOLIDAY',
  SCHOOL_HOLIDAY: 'SCHOOL_HOLIDAY',
  LOCAL_HOLIDAY: 'LOCAL_HOLIDAY',
  VACATION: 'VACATION',
  EMERGENCY_HOLIDAY: 'EMERGENCY_HOLIDAY',
  OPTIONAL_HOLIDAY: 'OPTIONAL_HOLIDAY',
};

export const EVENT_TYPE_META = {
  HOLIDAY: { label: 'Holiday', icon: 'sunny-outline', color: '#DC2626' },
  VACATION: { label: 'Vacation', icon: 'airplane-outline', color: '#F59E0B' },
  WORKING_DAY: { label: 'Working Day', icon: 'briefcase-outline', color: '#0F766E' },
  SPECIAL_WORKING_DAY: { label: 'Special Working Day', icon: 'briefcase-outline', color: '#10B981' },
  EXAM: { label: 'Examination', icon: 'school-outline', color: '#4F46E5' },
  TEST: { label: 'Unit Test', icon: 'document-text-outline', color: '#06B6D4' },
  RESULT: { label: 'Results', icon: 'ribbon-outline', color: '#7C3AED' },
  PTM: { label: 'Parent Teacher Meeting', icon: 'people-outline', color: '#D97706' },
  SCHOOL_EVENT: { label: 'School Event', icon: 'calendar-outline', color: '#475569' },
  SPORTS: { label: 'Sports', icon: 'football-outline', color: '#16A34A' },
  COMPETITION: { label: 'Competition', icon: 'trophy-outline', color: '#CA8A04' },
  TRIP: { label: 'Trip', icon: 'bus-outline', color: '#0891B2' },
  STAFF_MEETING: { label: 'Staff Meeting', icon: 'chatbubbles-outline', color: '#6366F1' },
  TRAINING: { label: 'Training', icon: 'briefcase-outline', color: '#0284C7' },
  FEE_DUE: { label: 'Fee Due', icon: 'cash-outline', color: '#EA580C' },
  FEE_LATE_DATE: { label: 'Late Fee', icon: 'alert-circle-outline', color: '#B91C1C' },
  ADMISSION: { label: 'Admissions', icon: 'person-add-outline', color: '#059669' },
  DOCUMENT_DEADLINE: { label: 'Document Deadline', icon: 'document-attach-outline', color: '#7C2D12' },
  HOMEWORK: { label: 'Homework', icon: 'book-outline', color: '#2563EB' },
  PROJECT: { label: 'Project', icon: 'construct-outline', color: '#1D4ED8' },
  ASSEMBLY: { label: 'Assembly', icon: 'megaphone-outline', color: '#0E7490' },
  CELEBRATION: { label: 'Celebration', icon: 'sparkles-outline', color: '#9333EA' },
  TRANSPORT_EVENT: { label: 'Transport', icon: 'bus-outline', color: '#0369A1' },
  CUSTOM: { label: 'Custom', icon: 'ellipsis-horizontal-circle-outline', color: '#64748B' },
};

const INSTRUCTIONAL_TYPES = new Set(['EXAM', 'TEST', 'STAFF_MEETING', 'TRAINING', 'WORKING_DAY', 'SPECIAL_WORKING_DAY']);
const GATEKEEPER_TYPES = new Set(['HOLIDAY', 'VACATION', 'PTM', 'SCHOOL_EVENT', 'SPORTS', 'CELEBRATION', 'SPECIAL_WORKING_DAY', 'TRIP']);
const DRIVER_TYPES = new Set(['HOLIDAY', 'VACATION', 'SPECIAL_WORKING_DAY', 'TRIP', 'TRANSPORT_EVENT']);
const ACCOUNTS_TYPES = new Set(['FEE_DUE', 'FEE_LATE_DATE', 'HOLIDAY', 'VACATION', 'DOCUMENT_DEADLINE']);

export function canonicalizeEventType(raw) {
  if (!raw) return 'SCHOOL_EVENT';
  const upper = String(raw).trim().toUpperCase().replace(/\s+/g, '_');
  const mapped = EVENT_TYPE_ALIASES[upper] || upper;
  return CALENDAR_EVENT_TYPES.includes(mapped) ? mapped : 'CUSTOM';
}

export function canonicalizeHolidayType(raw) {
  if (!raw) return null;
  const upper = String(raw).trim().toUpperCase().replace(/\s+/g, '_');
  return HOLIDAY_TYPE_ALIASES[upper] || upper;
}

export function canonicalizePriority(raw) {
  const upper = String(raw || 'NORMAL').trim().toUpperCase();
  if (upper === 'MEDIUM') return 'NORMAL';
  if (['LOW', 'NORMAL', 'HIGH', 'URGENT'].includes(upper)) return upper;
  return 'NORMAL';
}

export function isInstructionalEventType(eventType) {
  return INSTRUCTIONAL_TYPES.has(canonicalizeEventType(eventType));
}

export function operationalEventTypesForRole(role) {
  if (role === 'gatekeeper') return [...GATEKEEPER_TYPES];
  if (role === 'driver') return [...DRIVER_TYPES];
  if (role === 'accounts') return [...ACCOUNTS_TYPES];
  return [];
}
