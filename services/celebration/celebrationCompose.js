import {
  CELEBRATION_EVENT_TYPES,
  CELEBRATION_PRIORITIES,
  CELEBRATION_SLIDE_TYPE,
} from './celebration.types.js';

/**
 * One carousel card for a single birthday; a grouped card (no extra cards)
 * when multiple eligible birthdays are visible to the viewer.
 *
 * @param {object[]} formattedCards
 * @param {{ schoolId: number, dateContext: object, schoolName: string, audioEventKey: string, musicEnabled: boolean }} meta
 * @returns {object[]}
 */
export function composeCelebrationSlides(formattedCards, meta) {
  if (!Array.isArray(formattedCards) || formattedCards.length === 0) return [];
  if (formattedCards.length === 1) return formattedCards;

  const { schoolId, dateContext, schoolName, audioEventKey, musicEnabled } = meta;
  return [{
    id: `birthday_group_${schoolId}_${dateContext.localDate}`,
    slide_type: CELEBRATION_SLIDE_TYPE,
    celebration_type: CELEBRATION_EVENT_TYPES.BIRTHDAY,
    event_type: CELEBRATION_EVENT_TYPES.BIRTHDAY,
    is_grouped: true,
    priority: CELEBRATION_PRIORITIES.BIRTHDAY,
    title: "Today's Birthday Stars 🎂",
    message: `Celebrating ${formattedCards.length} birthdays today at ${schoolName}!`,
    count: formattedCards.length,
    stars: formattedCards.map((card) => ({
      ...card.person,
      message: card.message,
    })),
    audio: {
      enabled: Boolean(musicEnabled),
      asset: 'birthday-celebration',
      play_once: true,
      event_key: audioEventKey,
    },
    valid_from: dateContext.validFrom,
    valid_until: dateContext.validUntil,
  }];
}
