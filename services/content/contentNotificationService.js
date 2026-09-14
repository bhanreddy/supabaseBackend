import { resolveEligibleRecipientsForContent } from './contentTargetService.js';
import { sendNotificationToUsers } from '../notificationService.js';
import logger from '../../utils/logger.js';

/**
 * Fan-out a Daily Thought / Daily News push to the resolved audience.
 * Failures never block the publish transaction.
 */
export async function notifyContentPublished({ schoolId, contentId, type, title, summary = null }) {
  if (process.env.NODE_TEST_CONTEXT) {
    return { sent: 0, skipped: true };
  }
  try {
    const userIds = await resolveEligibleRecipientsForContent({ schoolId, contentId });
    if (!userIds.length) return { sent: 0 };

    const isThought = type === 'THOUGHT';
    const eventType = isThought ? 'DAILY_THOUGHT' : 'DAILY_NEWS';
    const message = isThought
      ? (summary || `Start your day with today's SchoolIMS thought.`)
      : (summary || 'Important stories from today.');

    await sendNotificationToUsers(
      userIds,
      eventType,
      {
        title: title || (isThought ? "Today's Thought" : "Today's News"),
        message,
        contentId,
      },
      {
        schoolId,
        deepLink: `/Screen/schoolDaily?contentId=${contentId}`,
      },
    );

    return { sent: userIds.length };
  } catch (err) {
    logger.error(
      { err: err.message, schoolId, contentId, type },
      'Failed to dispatch content publish notifications',
    );
    return { sent: 0, error: err.message };
  }
}
