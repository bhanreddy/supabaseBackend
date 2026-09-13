import sql from '../../db.js';
import { resolveBirthdays, getSchoolTimezone } from './birthdayResolver.js';
import { getCelebrationSettings } from './celebrationSettingsService.js';
import { filterCelebrationsForUser } from './celebrationPolicy.js';
import { renderCelebrationTemplate } from './celebrationTemplateEngine.js';
import { getInitials, getSchoolDateContext } from './celebrationUtils.js';
import { enrichCelebrationViewer } from './celebrationAudience.js';
import { composeCelebrationSlides } from './celebrationCompose.js';
import {
  CELEBRATION_EVENT_TYPES,
  CELEBRATION_PRIORITIES,
  CELEBRATION_SLIDE_TYPE,
} from './celebration.types.js';
import logger from '../../utils/logger.js';

const celebrationCache = new Map();
const CACHE_TTL_MS = 45 * 60 * 1000;
const DEFAULT_STUDENT_TEMPLATE = 'Happy Birthday, {{first_name}}! 🎉\nWishing you joy, success, and a wonderful year ahead.';
const DEFAULT_STAFF_TEMPLATE = 'Celebrating {{full_name}}! 🎂\nHave a fantastic birthday from everyone at {{school_name}}!';

/**
 * Cache invalidator (called when settings or birthdays are modified).
 * @param {number} [schoolId]
 */
export function invalidateCelebrationCache(schoolId) {
  if (schoolId) {
    const prefix = `${schoolId}:`;
    for (const key of celebrationCache.keys()) {
      if (key.startsWith(prefix)) celebrationCache.delete(key);
    }
  } else {
    celebrationCache.clear();
  }
}

async function getSchoolName(schoolId) {
  try {
    const [row] = await sql`
      SELECT name FROM schools WHERE id = ${schoolId} LIMIT 1
    `;
    return row?.name || 'School';
  } catch {
    return 'School';
  }
}

function formatCelebrationCard(item, settings, schoolName, dateContext, audioEventKey) {
  const isStudent = item.targetType === 'STUDENT';
  const template = isStudent
    ? (settings.student_template || DEFAULT_STUDENT_TEMPLATE)
    : (settings.staff_template || DEFAULT_STAFF_TEMPLATE);

  const message = renderCelebrationTemplate(template, {
    first_name: item.firstName,
    full_name: item.displayName,
    class: isStudent && settings.show_class ? item.className : '',
    section: isStudent && settings.show_section ? item.sectionName : '',
    designation: !isStudent && settings.show_staff_designation ? item.designation : '',
    department: '',
    school_name: schoolName,
  });

  if (!message) {
    logger.warn({
      event: 'celebration_template_missing',
      schoolId: item.schoolId,
      targetType: item.targetType,
    });
  }

  const showPhoto = isStudent ? settings.show_student_photo : settings.show_staff_photo;

  return {
    id: `birthday_${item.targetType.toLowerCase()}_${item.targetId}_${dateContext.localDate}`,
    slide_type: CELEBRATION_SLIDE_TYPE,
    celebration_type: CELEBRATION_EVENT_TYPES.BIRTHDAY,
    event_type: CELEBRATION_EVENT_TYPES.BIRTHDAY,
    priority: CELEBRATION_PRIORITIES.BIRTHDAY,
    title: 'Happy Birthday 🎉',
    message: message || `Wishing you a wonderful birthday from ${schoolName}!`,
    person: {
      type: item.targetType,
      id: item.targetId,
      name: item.displayName,
      first_name: item.firstName,
      photo_url: showPhoto ? item.photoUrl : null,
      initials: getInitials(item.displayName),
      class_name: isStudent && settings.show_class ? item.className : null,
      section_name: isStudent && settings.show_section ? item.sectionName : null,
      designation: !isStudent && settings.show_staff_designation ? item.designation : null,
    },
    audio: {
      enabled: Boolean(settings.birthday_music_enabled),
      asset: 'birthday-celebration',
      play_once: true,
      event_key: audioEventKey,
    },
    valid_from: dateContext.validFrom,
    valid_until: dateContext.validUntil,
  };
}

export { composeCelebrationSlides };

/**
 * Generates celebration slide items for a school and authenticated user.
 *
 * @param {number} schoolId
 * @param {object} user
 * @returns {Promise<Array<object>>}
 */
export async function getCelebrationSlides(schoolId, user = null) {
  if (!schoolId) return [];

  try {
    const settings = await getCelebrationSettings(schoolId);
    if (!settings.is_enabled) return [];
    if (!settings.student_birthday_enabled && !settings.staff_birthday_enabled) return [];

    const viewer = await enrichCelebrationViewer(schoolId, user);
    const now = new Date();
    const timezone = await getSchoolTimezone(schoolId);
    const dateHint = getSchoolDateContext(timezone, now);
    const cacheKey = `${schoolId}:raw:${dateHint.localDate}`;
    const cached = celebrationCache.get(cacheKey);
    let resolvedData = (cached && Date.now() - cached.timestamp < CACHE_TTL_MS)
      ? cached.data
      : null;

    if (!resolvedData) {
      resolvedData = await resolveBirthdays({
        schoolId,
        asOfDate: now,
        includeStudents: settings.student_birthday_enabled,
        includeStaff: settings.staff_birthday_enabled,
      });
      celebrationCache.set(cacheKey, {
        timestamp: Date.now(),
        data: resolvedData,
      });
    }

    const { dateContext, students, staff } = resolvedData;
    const allEligible = [...students, ...staff];
    const permitted = filterCelebrationsForUser(allEligible, viewer, settings);
    if (permitted.length === 0) return [];

    const schoolName = await getSchoolName(schoolId);
    const userId = viewer?.internal_id || viewer?.userId || viewer?.id || 'guest';
    const audioEventKey = `birthday_audio_${userId}_${schoolId}_${dateContext.localDate}`;

    const formattedCards = permitted.map((item) => (
      formatCelebrationCard(item, settings, schoolName, dateContext, audioEventKey)
    ));

    const slides = composeCelebrationSlides(formattedCards, {
      schoolId,
      dateContext,
      schoolName,
      audioEventKey,
      musicEnabled: settings.birthday_music_enabled,
    });

    logger.info({
      event: 'celebration_banner_generated',
      schoolId,
      slideCount: slides.length,
      visibleBirthdayCount: formattedCards.length,
      grouped: Boolean(slides[0]?.is_grouped),
    });

    return slides;
  } catch (error) {
    logger.error({
      event: 'celebration_banner_failed',
      schoolId,
      err: error,
    }, 'Failed to resolve celebration slides');
    return [];
  }
}
