import sql from '../../db.js';
import logger from '../../utils/logger.js';

export const ANALYTICS_EVENT_TYPES = Object.freeze({
  VIEW: 'VIEW',
  LIKE: 'LIKE',
  BOOKMARK: 'BOOKMARK',
  SHARE: 'SHARE',
  NOTIFICATION_OPEN: 'NOTIFICATION_OPEN',
  READ_PROGRESS: 'READ_PROGRESS',
  READ_COMPLETED: 'READ_COMPLETED',
});

/**
 * Record a content analytics event.
 */
export async function recordContentEvent({
  schoolId,
  contentId,
  userId = null,
  eventType,
  durationSeconds = 0,
  metadata = {},
}) {
  if (!schoolId || !contentId || !eventType) return;

  try {
    await sql`
      INSERT INTO public.content_analytics (
        school_id,
        content_id,
        user_id,
        event_type,
        duration_seconds,
        metadata
      ) VALUES (
        ${schoolId},
        ${contentId},
        ${userId},
        ${eventType},
        ${Math.max(0, parseInt(durationSeconds, 10) || 0)},
        ${sql.json(metadata)}
      )
    `;
  } catch (err) {
    logger.warn({ err: err.message, schoolId, contentId, eventType }, 'Failed to record content analytics event');
  }
}

/**
 * Toggle a user's LIKE on a content item (idempotent).
 */
export async function toggleContentLike({ schoolId, contentId, userId }) {
  const [existing] = await sql`
    SELECT id FROM public.content_analytics
    WHERE school_id = ${schoolId}
      AND content_id = ${contentId}
      AND user_id = ${userId}
      AND event_type = 'LIKE'
    LIMIT 1
  `;

  if (existing) {
    await sql`DELETE FROM public.content_analytics WHERE id = ${existing.id}`;
    return { liked: false };
  }

  await sql`
    INSERT INTO public.content_analytics (school_id, content_id, user_id, event_type)
    VALUES (${schoolId}, ${contentId}, ${userId}, 'LIKE')
  `;
  return { liked: true };
}

/**
 * Toggle user bookmark on a content item.
 */
export async function toggleContentBookmark({ schoolId, contentId, userId }) {
  const [existing] = await sql`
    SELECT id FROM public.content_bookmarks
    WHERE school_id = ${schoolId} AND content_id = ${contentId} AND user_id = ${userId}
  `;

  if (existing) {
    await sql`
      DELETE FROM public.content_bookmarks
      WHERE id = ${existing.id}
    `;
    return { bookmarked: false };
  } else {
    await sql`
      INSERT INTO public.content_bookmarks (school_id, content_id, user_id)
      VALUES (${schoolId}, ${contentId}, ${userId})
    `;
    // Also record bookmark event in analytics
    void recordContentEvent({
      schoolId,
      contentId,
      userId,
      eventType: ANALYTICS_EVENT_TYPES.BOOKMARK,
    });
    return { bookmarked: true };
  }
}

/**
 * List all saved bookmarks for a specific user.
 */
export async function listUserBookmarks({ schoolId, userId, limit = 50, offset = 0 }) {
  return sql`
    SELECT
      i.id,
      i.school_id,
      i.type,
      i.title,
      i.summary,
      i.cover_image_url,
      i.published_at,
      n.category AS news_category,
      n.source_name,
      n.reading_time,
      t.quote,
      t.author AS thought_author,
      b.created_at AS bookmarked_at
    FROM public.content_bookmarks b
    JOIN public.content_items i ON i.id = b.content_id
    LEFT JOIN public.content_news n ON n.content_id = i.id
    LEFT JOIN public.content_thoughts t ON t.content_id = i.id
    WHERE b.school_id = ${schoolId}
      AND b.user_id = ${userId}
      AND i.deleted_at IS NULL
      AND i.status = 'PUBLISHED'
    ORDER BY b.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
}

/**
 * Get aggregated analytics overview for admin dashboard.
 */
export async function getAdminContentAnalytics({ schoolId, days = 30 }) {
  const [totals] = await sql`
    SELECT
      COUNT(DISTINCT CASE WHEN i.type = 'THOUGHT' AND i.status = 'PUBLISHED' THEN i.id END) AS total_published_thoughts,
      COUNT(DISTINCT CASE WHEN i.type = 'NEWS' AND i.status = 'PUBLISHED' THEN i.id END) AS total_published_news,
      COUNT(DISTINCT CASE WHEN i.status = 'SUBMITTED' THEN i.id END) AS pending_approvals,
      COUNT(DISTINCT CASE WHEN i.status = 'SCHEDULED' THEN i.id END) AS scheduled_items
    FROM public.content_items i
    WHERE i.school_id = ${schoolId} AND i.deleted_at IS NULL
  `;

  const [eventCounts] = await sql`
    SELECT
      COUNT(CASE WHEN event_type = 'VIEW' THEN 1 END) AS total_views,
      COUNT(DISTINCT CASE WHEN event_type = 'VIEW' AND user_id IS NOT NULL THEN user_id END) AS unique_viewers,
      COUNT(CASE WHEN event_type = 'LIKE' THEN 1 END) AS total_likes,
      COUNT(CASE WHEN event_type = 'BOOKMARK' THEN 1 END) AS total_bookmarks,
      COUNT(CASE WHEN event_type = 'SHARE' THEN 1 END) AS total_shares,
      COALESCE(AVG(CASE WHEN event_type = 'READ_COMPLETED' AND duration_seconds > 0 THEN duration_seconds END), 0) AS avg_read_duration_seconds
    FROM public.content_analytics
    WHERE school_id = ${schoolId}
      AND created_at >= NOW() - (${days} || ' days')::interval
  `;

  const topNewsCategories = await sql`
    SELECT
      n.category,
      COUNT(a.id) AS view_count
    FROM public.content_analytics a
    JOIN public.content_news n ON n.content_id = a.content_id
    WHERE a.school_id = ${schoolId}
      AND a.event_type = 'VIEW'
      AND a.created_at >= NOW() - (${days} || ' days')::interval
    GROUP BY n.category
    ORDER BY view_count DESC
    LIMIT 6
  `;

  const topStories = await sql`
    SELECT
      i.id,
      i.type,
      i.title,
      i.published_at,
      COUNT(CASE WHEN a.event_type = 'VIEW' THEN 1 END) AS views,
      COUNT(CASE WHEN a.event_type = 'LIKE' THEN 1 END) AS likes,
      COUNT(CASE WHEN a.event_type = 'BOOKMARK' THEN 1 END) AS bookmarks
    FROM public.content_items i
    LEFT JOIN public.content_analytics a ON a.content_id = i.id
    WHERE i.school_id = ${schoolId}
      AND i.status = 'PUBLISHED'
      AND i.deleted_at IS NULL
    GROUP BY i.id, i.type, i.title, i.published_at
    ORDER BY views DESC, likes DESC
    LIMIT 10
  `;

  return {
    overview: {
      totalPublishedThoughts: parseInt(totals?.total_published_thoughts || '0', 10),
      totalPublishedNews: parseInt(totals?.total_published_news || '0', 10),
      pendingApprovals: parseInt(totals?.pending_approvals || '0', 10),
      scheduledItems: parseInt(totals?.scheduled_items || '0', 10),
      totalViews: parseInt(eventCounts?.total_views || '0', 10),
      uniqueViewers: parseInt(eventCounts?.unique_viewers || '0', 10),
      totalLikes: parseInt(eventCounts?.total_likes || '0', 10),
      totalBookmarks: parseInt(eventCounts?.total_bookmarks || '0', 10),
      totalShares: parseInt(eventCounts?.total_shares || '0', 10),
      avgReadDurationSeconds: Math.round(Number(eventCounts?.avg_read_duration_seconds || 0)),
    },
    topCategories: topNewsCategories,
    topStories,
  };
}
