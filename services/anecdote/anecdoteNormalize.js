const VALID_CONTEXTS = new Set([
  'classroom',
  'playground',
  'laboratory',
  'corridor',
  'sports_field',
  'bus',
  'cafeteria',
  'assembly',
  'online',
  'other',
]);

const CONTEXT_ALIASES = {
  class: 'classroom',
  classroom: 'classroom',
  'class room': 'classroom',
  playground: 'playground',
  laboratory: 'laboratory',
  lab: 'laboratory',
  corridor: 'corridor',
  hallway: 'corridor',
  assembly: 'assembly',
  bus: 'bus',
  'bus / transport': 'bus',
  transport: 'bus',
  'sports ground': 'sports_field',
  'sports field': 'sports_field',
  sports_field: 'sports_field',
  library: 'other',
  'dining hall': 'cafeteria',
  cafeteria: 'cafeteria',
  canteen: 'cafeteria',
  dining: 'cafeteria',
  online: 'online',
  other: 'other',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeAnecdoteContext(raw, fallback = 'classroom') {
  const key = String(raw || '').trim().toLowerCase();
  if (!key) return fallback;
  if (VALID_CONTEXTS.has(key)) return key;
  return CONTEXT_ALIASES[key] || fallback;
}

export function normalizeClientGeneratedId(raw) {
  if (!raw) return null;
  const value = String(raw).trim();
  return UUID_RE.test(value) ? value : null;
}
