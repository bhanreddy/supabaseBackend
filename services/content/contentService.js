import sql from '../../db.js';
import { logContentAudit } from './contentAuditService.js';
import { setContentTargets, getContentTargets, resolveUserTargetFilterSql } from './contentTargetService.js';
import { processDueContentPublishing, occupyPublishedThoughtSlot } from './contentSchedulerService.js';
import { notifyContentPublished } from './contentNotificationService.js';
import { CONTENT_STATUSES } from './contentWorkflowService.js';
import { sanitizeRichText, isSafeHttpUrl, normalizeTargetId } from './contentUtils.js';
import logger from '../../utils/logger.js';

/**
 * Capture a version snapshot of a content item.
 */
async function captureVersionSnapshot(tx, { schoolId, contentId, changedBy, changeSummary }) {
  const [item] = await tx`
    SELECT
      i.*,
      (SELECT row_to_json(t.*) FROM public.content_thoughts t WHERE t.content_id = i.id) AS thought_data,
      (SELECT row_to_json(n.*) FROM public.content_news n WHERE n.content_id = i.id) AS news_data,
      (
        SELECT COALESCE(json_agg(row_to_json(tg.*)), '[]'::json)
        FROM public.content_targets tg
        WHERE tg.content_id = i.id
      ) AS targets,
      (
        SELECT COALESCE(json_agg(to_jsonb(m) ORDER BY m.sort_order), '[]'::json)
        FROM public.content_media m
        WHERE m.content_id = i.id
      ) AS media
    FROM public.content_items i
    WHERE i.id = ${contentId} AND i.school_id = ${schoolId}
  `;

  if (!item) return null;

  const [versionRow] = await tx`
    SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version
    FROM public.content_versions
    WHERE content_id = ${contentId}
  `;
  const nextVersion = versionRow?.next_version || 1;

  await tx`
    INSERT INTO public.content_versions (
      content_id,
      school_id,
      version_number,
      snapshot,
      changed_by,
      change_summary
    ) VALUES (
      ${contentId},
      ${schoolId},
      ${nextVersion},
      ${sql.json(item)},
      ${changedBy},
      ${changeSummary || `Version ${nextVersion}`}
    )
  `;

  return nextVersion;
}

/**
 * Create a new Content Item (Thought or News).
 */
export async function createContentItem({
  schoolId,
  actorUser,
  type,
  title,
  summary = null,
  body = null,
  language = 'en',
  status = CONTENT_STATUSES.DRAFT,
  priority = 'NORMAL',
  isFeatured = false,
  coverImageUrl = null,
  coverStoragePath = null,
  metadata = {},
  // Thought fields
  quote = null,
  author = null,
  authorDescription = null,
  category = null,
  slotDate = null,
  // News fields
  headline = null,
  sourceName = null,
  sourceUrl = null,
  location = null,
  readingTime = 2,
  tags = [],
  // Audience targets
  targets = [],
  // Media attachments
  media = [],
  expiresAt = null,
  scheduledAt = null,
  overrideDuplicate = false,
  ipAddress = null,
}) {
  const userId = actorUser.internal_id || actorUser.id;
  const roles = actorUser.roles || [];
  const isAdmin = roles.some((r) => ['admin', 'principal'].includes(r));

  if (sourceUrl && !isSafeHttpUrl(sourceUrl)) {
    throw new Error('Source URL must be a valid http or https link.');
  }

  // Staff can only create DRAFT or SUBMITTED
  let initialStatus = status;
  if (!isAdmin && (initialStatus === CONTENT_STATUSES.PUBLISHED || initialStatus === CONTENT_STATUSES.SCHEDULED || initialStatus === CONTENT_STATUSES.APPROVED)) {
    initialStatus = CONTENT_STATUSES.SUBMITTED;
  }

  const safeTitle = sanitizeRichText(title)?.trim();
  const safeSummary = summary != null ? sanitizeRichText(summary)?.trim() : null;
  const safeBody = body != null ? sanitizeRichText(body)?.trim() : null;

  const created = await sql.begin(async (tx) => {
    // 1. Insert master record
    const [item] = await tx`
      INSERT INTO public.content_items (
        school_id,
        type,
        title,
        summary,
        body,
        language,
        status,
        priority,
        author_id,
        published_at,
        scheduled_at,
        expires_at,
        is_featured,
        cover_image_url,
        cover_storage_path,
        metadata
      ) VALUES (
        ${schoolId},
        ${type},
        ${safeTitle},
        ${safeSummary},
        ${safeBody},
        ${language},
        ${initialStatus},
        ${priority},
        ${userId},
        ${initialStatus === CONTENT_STATUSES.PUBLISHED ? sql`NOW()` : null},
        ${initialStatus === CONTENT_STATUSES.SCHEDULED && scheduledAt ? new Date(scheduledAt) : null},
        ${expiresAt ? new Date(expiresAt) : null},
        ${Boolean(isFeatured)},
        ${coverImageUrl},
        ${coverStoragePath},
        ${sql.json(metadata)}
      )
      RETURNING *
    `;

    // 2. Insert type-specific child record
    if (type === 'THOUGHT') {
      await tx`
        INSERT INTO public.content_thoughts (
          content_id,
          school_id,
          quote,
          author,
          author_description,
          category,
          slot_date
        ) VALUES (
          ${item.id},
          ${schoolId},
          ${sanitizeRichText(quote || title).trim()},
          ${(author || 'Anonymous').trim()},
          ${authorDescription ? authorDescription.trim() : null},
          ${(category || 'Inspiration').trim()},
          ${slotDate ? slotDate : sql`CURRENT_DATE`}
        )
      `;
    } else if (type === 'NEWS') {
      await tx`
        INSERT INTO public.content_news (
          content_id,
          school_id,
          headline,
          source_name,
          source_url,
          category,
          location,
          reading_time,
          tags
        ) VALUES (
          ${item.id},
          ${schoolId},
          ${(headline || title).trim()},
          ${sourceName ? sourceName.trim() : null},
          ${sourceUrl ? sourceUrl.trim() : null},
          ${(category || 'General').trim()},
          ${location ? location.trim() : null},
          ${parseInt(readingTime, 10) || 2},
          ${tags || []}
        )
      `;
    }

    // 3. Targets
    const targetList = targets.length > 0
      ? targets
      : [{ target_type: 'SCHOOL', target_id: 'all' }];

    for (const t of targetList) {
      await tx`
        INSERT INTO public.content_targets (
          content_id,
          school_id,
          target_type,
          target_id
        ) VALUES (
          ${item.id},
          ${schoolId},
          ${t.target_type || 'SCHOOL'},
          ${normalizeTargetId(t.target_type, t.target_id)}
        )
        ON CONFLICT (content_id, target_type, target_id) DO NOTHING
      `;
    }

    // 4. Media attachments
    if (Array.isArray(media) && media.length > 0) {
      for (let i = 0; i < media.length; i++) {
        const m = media[i];
        if (m.url) {
          await tx`
            INSERT INTO public.content_media (
              content_id,
              school_id,
              media_type,
              url,
              storage_path,
              thumbnail_url,
              caption,
              sort_order
            ) VALUES (
              ${item.id},
              ${schoolId},
              ${m.media_type || 'image'},
              ${m.url},
              ${m.storage_path || null},
              ${m.thumbnail_url || m.url},
              ${m.caption || null},
              ${i}
            )
          `;
        }
      }
    }

    // 5. Initial Version Snapshot
    await captureVersionSnapshot(tx, {
      schoolId,
      contentId: item.id,
      changedBy: userId,
      changeSummary: 'Initial creation',
    });

    // 6. Audit Log
    await logContentAudit({
      schoolId,
      contentId: item.id,
      action: 'CREATED',
      performedBy: userId,
      changedFields: { type, title, status: initialStatus },
      newState: { status: initialStatus, title },
      ipAddress,
      tx,
    });

    return item;
  });

  if (created.type === 'THOUGHT' && created.status === CONTENT_STATUSES.PUBLISHED) {
    await occupyPublishedThoughtSlot({
      schoolId,
      contentId: created.id,
      overrideDuplicate,
    });
  }

  if (created.status === CONTENT_STATUSES.PUBLISHED) {
    void notifyContentPublished({
      schoolId,
      contentId: created.id,
      type: created.type,
      title: created.title,
      summary: created.summary,
    });
  }

  return created;
}

/**
 * Update a Content Item.
 */
export async function updateContentItem({
  schoolId,
  contentId,
  actorUser,
  title,
  summary,
  body,
  language,
  priority,
  isFeatured,
  coverImageUrl,
  coverStoragePath,
  metadata,
  // Thought fields
  quote,
  author,
  authorDescription,
  category,
  slotDate,
  // News fields
  headline,
  sourceName,
  sourceUrl,
  location,
  readingTime,
  tags,
  // Targets & media
  targets,
  media,
  ipAddress = null,
}) {
  const userId = actorUser.internal_id || actorUser.id;
  const roles = actorUser.roles || [];
  const isAdmin = roles.some((r) => ['admin', 'principal'].includes(r));
  const payload = arguments[0] || {};
  authorDescription = authorDescription ?? payload.author_description;
  slotDate = slotDate ?? payload.slot_date;
  sourceName = sourceName ?? payload.source_name;
  sourceUrl = sourceUrl ?? payload.source_url;
  readingTime = readingTime ?? payload.reading_time;
  coverImageUrl = coverImageUrl ?? payload.cover_image_url;
  coverStoragePath = coverStoragePath ?? payload.cover_storage_path;
  isFeatured = isFeatured ?? payload.is_featured;

  if (sourceUrl && !isSafeHttpUrl(sourceUrl)) {
    throw new Error('Source URL must be a valid http or https link.');
  }
  if (title != null) title = sanitizeRichText(title);
  if (summary != null) summary = sanitizeRichText(summary);
  if (body != null) body = sanitizeRichText(body);
  if (quote != null) quote = sanitizeRichText(quote);

  const [existing] = await sql`
    SELECT * FROM public.content_items
    WHERE id = ${contentId} AND school_id = ${schoolId} AND deleted_at IS NULL
  `;

  if (!existing) {
    throw new Error('Content item not found.');
  }

  if (!isAdmin && existing.author_id !== userId) {
    throw new Error('You do not have permission to edit this content item.');
  }

  return sql.begin(async (tx) => {
    // 1. Update master table
    const [updated] = await tx`
      UPDATE public.content_items
      SET
        title = COALESCE(${title ? title.trim() : null}, title),
        summary = COALESCE(${summary !== undefined ? summary : null}, summary),
        body = COALESCE(${body !== undefined ? body : null}, body),
        language = COALESCE(${language ?? null}, language),
        priority = COALESCE(${priority ?? null}, priority),
        is_featured = COALESCE(${isFeatured !== undefined ? Boolean(isFeatured) : null}, is_featured),
        cover_image_url = COALESCE(${coverImageUrl !== undefined ? coverImageUrl : null}, cover_image_url),
        cover_storage_path = COALESCE(${coverStoragePath !== undefined ? coverStoragePath : null}, cover_storage_path),
        metadata = COALESCE(${metadata ? sql.json(metadata) : null}, metadata),
        updated_at = NOW()
      WHERE id = ${contentId} AND school_id = ${schoolId}
      RETURNING *
    `;

    // 2. Update type-specific table
    if (existing.type === 'THOUGHT') {
      await tx`
        UPDATE public.content_thoughts
        SET
          quote = COALESCE(${quote ? quote.trim() : null}, quote),
          author = COALESCE(${author ? author.trim() : null}, author),
          author_description = COALESCE(${authorDescription !== undefined ? authorDescription : null}, author_description),
          category = COALESCE(${category ? category.trim() : null}, category),
          slot_date = COALESCE(${slotDate ? slotDate : null}, slot_date),
          updated_at = NOW()
        WHERE content_id = ${contentId} AND school_id = ${schoolId}
      `;
    } else if (existing.type === 'NEWS') {
      await tx`
        UPDATE public.content_news
        SET
          headline = COALESCE(${headline ? headline.trim() : null}, headline),
          source_name = COALESCE(${sourceName !== undefined ? sourceName : null}, source_name),
          source_url = COALESCE(${sourceUrl !== undefined ? sourceUrl : null}, source_url),
          category = COALESCE(${category ? category.trim() : null}, category),
          location = COALESCE(${location !== undefined ? location : null}, location),
          reading_time = COALESCE(${readingTime ? parseInt(readingTime, 10) : null}, reading_time),
          tags = COALESCE(${tags !== undefined ? tags : null}, tags),
          updated_at = NOW()
        WHERE content_id = ${contentId} AND school_id = ${schoolId}
      `;
    }

    // 3. Targets (if supplied)
    if (Array.isArray(targets)) {
      await tx`
        DELETE FROM public.content_targets
        WHERE content_id = ${contentId} AND school_id = ${schoolId}
      `;
      for (const t of targets) {
        await tx`
          INSERT INTO public.content_targets (
            content_id,
            school_id,
            target_type,
            target_id
          ) VALUES (
            ${contentId},
            ${schoolId},
            ${t.target_type || 'SCHOOL'},
            ${String(t.target_id || 'all')}
          )
          ON CONFLICT (content_id, target_type, target_id) DO NOTHING
        `;
      }
    }

    // 4. Media (if supplied)
    if (Array.isArray(media)) {
      await tx`
        DELETE FROM public.content_media
        WHERE content_id = ${contentId} AND school_id = ${schoolId}
      `;
      for (let i = 0; i < media.length; i++) {
        const m = media[i];
        if (m.url) {
          await tx`
            INSERT INTO public.content_media (
              content_id,
              school_id,
              media_type,
              url,
              storage_path,
              thumbnail_url,
              caption,
              sort_order
            ) VALUES (
              ${contentId},
              ${schoolId},
              ${m.media_type || 'image'},
              ${m.url},
              ${m.storage_path || null},
              ${m.thumbnail_url || m.url},
              ${m.caption || null},
              ${i}
            )
          `;
        }
      }
    }

    // 5. Version snapshot
    await captureVersionSnapshot(tx, {
      schoolId,
      contentId,
      changedBy: userId,
      changeSummary: 'Content updated',
    });

    // 6. Audit log
    await logContentAudit({
      schoolId,
      contentId,
      action: 'EDITED',
      performedBy: userId,
      changedFields: { title, summary, quote, headline, category },
      previousState: { title: existing.title },
      newState: { title: updated.title },
      ipAddress,
      tx,
    });

    return updated;
  });
}

/**
 * Soft delete a content item.
 */
export async function deleteContentItem({ schoolId, contentId, actorUser, ipAddress = null }) {
  const userId = actorUser.internal_id || actorUser.id;
  const roles = actorUser.roles || [];
  const isAdmin = roles.some((r) => ['admin', 'principal'].includes(r));

  const [existing] = await sql`
    SELECT id, author_id, title FROM public.content_items
    WHERE id = ${contentId} AND school_id = ${schoolId} AND deleted_at IS NULL
  `;

  if (!existing) {
    throw new Error('Content item not found or already deleted.');
  }

  if (!isAdmin && existing.author_id !== userId) {
    throw new Error('You do not have permission to delete this content item.');
  }

  await sql`
    UPDATE public.content_items
    SET deleted_at = NOW(), updated_at = NOW()
    WHERE id = ${contentId} AND school_id = ${schoolId}
  `;

  await logContentAudit({
    schoolId,
    contentId,
    action: 'DELETED',
    performedBy: userId,
    changedFields: { deleted_at: new Date() },
    ipAddress,
  });

  return { success: true, id: contentId };
}

/**
 * Get Content Item details with associated thought/news fields, targets, media, versions.
 */
export async function getContentItemById({ schoolId, contentId, userId = null }) {
  const [item] = await sql`
    SELECT
      i.*,
      au.email AS author_email,
      p.first_name || ' ' || coalesce(p.last_name, '') AS author_name,
      t.quote,
      t.author AS thought_author,
      t.author_description AS thought_author_description,
      t.category AS thought_category,
      t.slot_date,
      n.headline,
      n.source_name,
      n.source_url,
      n.category AS news_category,
      n.location,
      n.reading_time,
      n.tags,
      EXISTS(
        SELECT 1 FROM public.content_bookmarks b
        WHERE b.content_id = i.id AND b.school_id = ${schoolId} AND b.user_id = ${userId}
      ) AS is_bookmarked,
      EXISTS(
        SELECT 1 FROM public.content_analytics a
        WHERE a.content_id = i.id AND a.school_id = ${schoolId} AND a.user_id = ${userId} AND a.event_type = 'LIKE'
      ) AS is_liked,
      (
        SELECT COUNT(*) FROM public.content_analytics a
        WHERE a.content_id = i.id AND a.school_id = ${schoolId} AND a.event_type = 'LIKE'
      ) AS like_count,
      (
        SELECT COUNT(*) FROM public.content_analytics a
        WHERE a.content_id = i.id AND a.school_id = ${schoolId} AND a.event_type = 'VIEW'
      ) AS view_count
    FROM public.content_items i
    LEFT JOIN public.users u ON u.id = i.author_id
    LEFT JOIN auth.users au ON au.id = i.author_id
    LEFT JOIN public.persons p ON p.id = u.person_id
    LEFT JOIN public.content_thoughts t ON t.content_id = i.id
    LEFT JOIN public.content_news n ON n.content_id = i.id
    WHERE i.id = ${contentId} AND i.school_id = ${schoolId} AND i.deleted_at IS NULL
  `;

  if (!item) return null;

  const targets = await sql`
    SELECT id, target_type, target_id
    FROM public.content_targets
    WHERE content_id = ${contentId} AND school_id = ${schoolId}
  `;

  const media = await sql`
    SELECT id, media_type, url, storage_path, thumbnail_url, caption, sort_order
    FROM public.content_media
    WHERE content_id = ${contentId} AND school_id = ${schoolId}
    ORDER BY sort_order ASC, created_at ASC
  `;

  const versions = await sql`
    SELECT
      v.id,
      v.version_number,
      v.change_summary,
      v.created_at,
      au.email AS changed_by_email,
      p.first_name || ' ' || coalesce(p.last_name, '') AS changed_by_name
    FROM public.content_versions v
    LEFT JOIN public.users u ON u.id = v.changed_by
    LEFT JOIN auth.users au ON au.id = v.changed_by
    LEFT JOIN public.persons p ON p.id = u.person_id
    WHERE v.content_id = ${contentId} AND v.school_id = ${schoolId}
    ORDER BY v.version_number DESC
  `;

  return {
    ...item,
    thought: item.type === 'THOUGHT' ? {
      quote: item.quote,
      author: item.thought_author,
      author_description: item.thought_author_description,
      category: item.thought_category,
      slot_date: item.slot_date,
    } : undefined,
    news: item.type === 'NEWS' ? {
      headline: item.headline,
      source_name: item.source_name,
      source_url: item.source_url,
      category: item.news_category,
      location: item.location,
      reading_time: item.reading_time,
      tags: item.tags,
    } : undefined,
    author: item.type === 'THOUGHT' ? item.thought_author : item.author,
    category: item.thought_category || item.news_category,
    targets,
    media,
    versions,
  };
}

/**
 * List / Search content items for Admin or Staff management.
 */
export async function listContentItems({
  schoolId,
  type,
  status,
  category,
  authorId,
  isFeatured,
  startDate,
  endDate,
  search,
  limit = 20,
  offset = 0,
}) {
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const offsetNum = Math.max(0, parseInt(offset, 10) || 0);

  const items = await sql`
    SELECT
      i.id,
      i.school_id,
      i.type,
      i.title,
      i.summary,
      i.language,
      i.status,
      i.priority,
      i.rejection_reason,
      i.is_featured,
      i.cover_image_url,
      i.published_at,
      i.scheduled_at,
      i.created_at,
      i.updated_at,
      au.email AS author_email,
      p.first_name || ' ' || coalesce(p.last_name, '') AS author_name,
      t.quote,
      t.author AS thought_author,
      t.category AS thought_category,
      t.slot_date,
      n.headline,
      n.source_name,
      n.category AS news_category,
      n.reading_time,
      (SELECT COUNT(*) FROM public.content_analytics a WHERE a.content_id = i.id AND a.event_type = 'VIEW') AS view_count,
      (SELECT COUNT(*) FROM public.content_analytics a WHERE a.content_id = i.id AND a.event_type = 'LIKE') AS like_count
    FROM public.content_items i
    LEFT JOIN public.users u ON u.id = i.author_id
    LEFT JOIN auth.users au ON au.id = i.author_id
    LEFT JOIN public.persons p ON p.id = u.person_id
    LEFT JOIN public.content_thoughts t ON t.content_id = i.id
    LEFT JOIN public.content_news n ON n.content_id = i.id
    WHERE i.school_id = ${schoolId}
      AND i.deleted_at IS NULL
      ${type ? sql`AND i.type = ${type}` : sql``}
      ${status ? sql`AND i.status = ${status}` : sql``}
      ${authorId ? sql`AND i.author_id = ${authorId}` : sql``}
      ${isFeatured !== undefined ? sql`AND i.is_featured = ${Boolean(isFeatured)}` : sql``}
      ${startDate ? sql`AND (i.published_at >= ${startDate} OR i.created_at >= ${startDate})` : sql``}
      ${endDate ? sql`AND (i.published_at <= ${endDate} OR i.created_at <= ${endDate})` : sql``}
      ${category ? sql`AND (t.category = ${category} OR n.category = ${category})` : sql``}
      ${search ? sql`AND (
        to_tsvector('english', coalesce(i.title, '') || ' ' || coalesce(i.summary, '') || ' ' || coalesce(i.body, ''))
          @@ plainto_tsquery('english', ${search.trim()})
        OR i.title ILIKE ${'%' + search.trim() + '%'}
        OR i.summary ILIKE ${'%' + search.trim() + '%'}
        OR t.quote ILIKE ${'%' + search.trim() + '%'}
        OR t.author ILIKE ${'%' + search.trim() + '%'}
        OR n.headline ILIKE ${'%' + search.trim() + '%'}
        OR COALESCE(array_to_string(n.tags, ' '), '') ILIKE ${'%' + search.trim() + '%'}
      )` : sql``}
    ORDER BY
      CASE WHEN i.status = 'SUBMITTED' THEN 1 ELSE 2 END ASC,
      COALESCE(i.published_at, i.scheduled_at, i.created_at) DESC
    LIMIT ${limitNum} OFFSET ${offsetNum}
  `;

  const [totalCountRow] = await sql`
    SELECT COUNT(*) AS total
    FROM public.content_items i
    LEFT JOIN public.content_thoughts t ON t.content_id = i.id
    LEFT JOIN public.content_news n ON n.content_id = i.id
    WHERE i.school_id = ${schoolId}
      AND i.deleted_at IS NULL
      ${type ? sql`AND i.type = ${type}` : sql``}
      ${status ? sql`AND i.status = ${status}` : sql``}
      ${authorId ? sql`AND i.author_id = ${authorId}` : sql``}
      ${isFeatured !== undefined ? sql`AND i.is_featured = ${Boolean(isFeatured)}` : sql``}
      ${startDate ? sql`AND (i.published_at >= ${startDate} OR i.created_at >= ${startDate})` : sql``}
      ${endDate ? sql`AND (i.published_at <= ${endDate} OR i.created_at <= ${endDate})` : sql``}
      ${category ? sql`AND (t.category = ${category} OR n.category = ${category})` : sql``}
      ${search ? sql`AND (
        to_tsvector('english', coalesce(i.title, '') || ' ' || coalesce(i.summary, '') || ' ' || coalesce(i.body, ''))
          @@ plainto_tsquery('english', ${search.trim()})
        OR i.title ILIKE ${'%' + search.trim() + '%'}
        OR i.summary ILIKE ${'%' + search.trim() + '%'}
        OR t.quote ILIKE ${'%' + search.trim() + '%'}
        OR t.author ILIKE ${'%' + search.trim() + '%'}
        OR n.headline ILIKE ${'%' + search.trim() + '%'}
        OR COALESCE(array_to_string(n.tags, ' '), '') ILIKE ${'%' + search.trim() + '%'}
      )` : sql``}
  `;

  return {
    items,
    total: parseInt(totalCountRow?.total || '0', 10),
    limit: limitNum,
    offset: offsetNum,
  };
}

/**
 * Mobile Unified Daily Feed API:
 * Resolves today's Thought, Today's News (featured & categorized), and user bookmark status.
 */
export async function getDailyFeedForUser({ user, schoolId: schoolIdOverride = null }) {
  const schoolId = schoolIdOverride || user.schoolId;
  const userId = user.internal_id || user.id;
  const language = user.language_code || user.language || 'en';

  await processDueContentPublishing(schoolId);

  const { roles, classId, sectionId } = await resolveUserTargetFilterSql({ ...user, schoolId });

  // 3. Resolve Today's Thought:
  // Nearest published thought targeted to user, slot_date <= today
  const [thought] = await sql`
    SELECT
      i.id,
      i.title,
      i.summary,
      i.body,
      i.cover_image_url,
      i.published_at,
      t.quote,
      t.author,
      t.author_description,
      t.category,
      t.slot_date,
      EXISTS(
        SELECT 1 FROM public.content_analytics a
        WHERE a.content_id = i.id AND a.school_id = ${schoolId} AND a.user_id = ${userId} AND a.event_type = 'LIKE'
      ) AS is_liked,
      (
        SELECT COUNT(*) FROM public.content_analytics a
        WHERE a.content_id = i.id AND a.school_id = ${schoolId} AND a.event_type = 'LIKE'
      ) AS like_count
    FROM public.content_items i
    JOIN public.content_thoughts t ON t.content_id = i.id
    WHERE i.school_id = ${schoolId}
      AND i.type = 'THOUGHT'
      AND i.status = 'PUBLISHED'
      AND i.deleted_at IS NULL
      AND (i.expires_at IS NULL OR i.expires_at > NOW())
      AND (
        -- Targeted audience check
        NOT EXISTS (SELECT 1 FROM public.content_targets tg WHERE tg.content_id = i.id)
        OR EXISTS (
          SELECT 1 FROM public.content_targets tg
          WHERE tg.content_id = i.id
            AND (
              (tg.target_type = 'SCHOOL' AND tg.target_id = 'all')
              OR (tg.target_type = 'USER' AND tg.target_id = ${userId})
              ${roles.length > 0 ? sql`OR (tg.target_type = 'ROLE' AND tg.target_id = ANY(${roles}::varchar[]))` : sql``}
              ${classId ? sql`OR (tg.target_type = 'CLASS' AND tg.target_id = ${String(classId)})` : sql``}
              ${sectionId ? sql`OR (tg.target_type = 'SECTION' AND tg.target_id = ${String(sectionId)})` : sql``}
            )
        )
      )
    ORDER BY
      CASE WHEN t.slot_date = CURRENT_DATE THEN 1 ELSE 2 END ASC,
      t.slot_date DESC,
      i.published_at DESC
    LIMIT 1
  `;

  // 4. Resolve Today's News (top stories published, targeted to user)
  const newsStories = await sql`
    SELECT
      i.id,
      i.title,
      i.summary,
      i.body,
      i.cover_image_url,
      i.is_featured,
      i.published_at,
      n.headline,
      n.source_name,
      n.source_url,
      n.category,
      n.location,
      n.reading_time,
      n.tags,
      EXISTS(
        SELECT 1 FROM public.content_bookmarks b
        WHERE b.content_id = i.id AND b.school_id = ${schoolId} AND b.user_id = ${userId}
      ) AS is_bookmarked,
      EXISTS(
        SELECT 1 FROM public.content_analytics a
        WHERE a.content_id = i.id AND a.school_id = ${schoolId} AND a.user_id = ${userId} AND a.event_type = 'LIKE'
      ) AS is_liked,
      (
        SELECT COUNT(*) FROM public.content_analytics a
        WHERE a.content_id = i.id AND a.school_id = ${schoolId} AND a.event_type = 'LIKE'
      ) AS like_count,
      (
        SELECT COUNT(*) FROM public.content_analytics a
        WHERE a.content_id = i.id AND a.school_id = ${schoolId} AND a.event_type = 'VIEW'
      ) AS view_count
    FROM public.content_items i
    JOIN public.content_news n ON n.content_id = i.id
    WHERE i.school_id = ${schoolId}
      AND i.type = 'NEWS'
      AND i.status = 'PUBLISHED'
      AND i.deleted_at IS NULL
      AND (i.expires_at IS NULL OR i.expires_at > NOW())
      AND (
        NOT EXISTS (SELECT 1 FROM public.content_targets tg WHERE tg.content_id = i.id)
        OR EXISTS (
          SELECT 1 FROM public.content_targets tg
          WHERE tg.content_id = i.id
            AND (
              (tg.target_type = 'SCHOOL' AND tg.target_id = 'all')
              OR (tg.target_type = 'USER' AND tg.target_id = ${userId})
              ${roles.length > 0 ? sql`OR (tg.target_type = 'ROLE' AND tg.target_id = ANY(${roles}::varchar[]))` : sql``}
              ${classId ? sql`OR (tg.target_type = 'CLASS' AND tg.target_id = ${String(classId)})` : sql``}
              ${sectionId ? sql`OR (tg.target_type = 'SECTION' AND tg.target_id = ${String(sectionId)})` : sql``}
            )
        )
      )
    ORDER BY
      i.is_featured DESC,
      i.published_at DESC
    LIMIT 20
  `;

  const featured = newsStories.filter((n) => n.is_featured);
  const categories = [...new Set(newsStories.map((n) => n.category))];

  let localizedThought = thought || null;
  let localizedNews = newsStories;
  if (language && language !== 'en') {
    const ids = [thought?.id, ...newsStories.map((n) => n.id)].filter(Boolean);
    if (ids.length) {
      const translations = await sql`
        SELECT content_id, title, summary, body
        FROM public.content_translations
        WHERE school_id = ${schoolId}
          AND language = ${language}
          AND content_id = ANY(${ids}::uuid[])
      `;
      const byId = new Map(translations.map((t) => [t.content_id, t]));
      if (localizedThought && byId.has(localizedThought.id)) {
        const tr = byId.get(localizedThought.id);
        localizedThought = {
          ...localizedThought,
          title: tr.title || localizedThought.title,
          summary: tr.summary || localizedThought.summary,
          body: tr.body || localizedThought.body,
          quote: tr.body || localizedThought.quote,
        };
      }
      localizedNews = newsStories.map((n) => {
        const tr = byId.get(n.id);
        if (!tr) return n;
        return {
          ...n,
          title: tr.title || n.title,
          headline: tr.title || n.headline,
          summary: tr.summary || n.summary,
          body: tr.body || n.body,
        };
      });
    }
  }

  return {
    date: new Date().toISOString().split('T')[0],
    thought: localizedThought,
    news: localizedNews,
    featuredNews: localizedNews.filter((n) => n.is_featured),
    featured: localizedNews.filter((n) => n.is_featured),
    categories,
    metadata: { language, schoolId },
  };
}

/**
 * Restore a previous version of a content item.
 */
export async function restoreContentVersion({ schoolId, contentId, versionNumber, actorUser, ipAddress = null }) {
  const userId = actorUser.internal_id || actorUser.id;
  const roles = actorUser.roles || [];
  const isAdmin = roles.some((r) => ['admin', 'principal'].includes(r));

  if (!isAdmin && !actorUser.permissions?.includes('content.manage')) {
    throw new Error('Only administrators can restore content versions.');
  }

  const [versionRow] = await sql`
    SELECT snapshot FROM public.content_versions
    WHERE content_id = ${contentId} AND school_id = ${schoolId} AND version_number = ${versionNumber}
  `;

  if (!versionRow || !versionRow.snapshot) {
    throw new Error(`Version ${versionNumber} not found.`);
  }

  const snap = versionRow.snapshot;

  return sql.begin(async (tx) => {
    // Restore master fields
    await tx`
      UPDATE public.content_items
      SET
        title = ${snap.title},
        summary = ${snap.summary},
        body = ${snap.body},
        language = ${snap.language},
        is_featured = ${snap.is_featured},
        cover_image_url = ${snap.cover_image_url},
        cover_storage_path = ${snap.cover_storage_path},
        updated_at = NOW()
      WHERE id = ${contentId} AND school_id = ${schoolId}
    `;

    // Restore thought fields
    if (snap.thought_data) {
      const td = snap.thought_data;
      await tx`
        UPDATE public.content_thoughts
        SET
          quote = ${td.quote},
          author = ${td.author},
          author_description = ${td.author_description},
          category = ${td.category},
          slot_date = ${td.slot_date},
          updated_at = NOW()
        WHERE content_id = ${contentId} AND school_id = ${schoolId}
      `;
    }

    // Restore news fields
    if (snap.news_data) {
      const nd = snap.news_data;
      await tx`
        UPDATE public.content_news
        SET
          headline = ${nd.headline},
          source_name = ${nd.source_name},
          source_url = ${nd.source_url},
          category = ${nd.category},
          location = ${nd.location},
          reading_time = ${nd.reading_time},
          tags = ${nd.tags || []},
          updated_at = NOW()
        WHERE content_id = ${contentId} AND school_id = ${schoolId}
      `;
    }

    // Snapshot the restore event as a new version
    const newVersion = await captureVersionSnapshot(tx, {
      schoolId,
      contentId,
      changedBy: userId,
      changeSummary: `Restored from version ${versionNumber}`,
    });

    await logContentAudit({
      schoolId,
      contentId,
      action: 'RESTORED_VERSION',
      performedBy: userId,
      changedFields: { restoredFromVersion: versionNumber, newVersion },
      ipAddress,
      tx,
    });

    return { success: true, versionNumber: newVersion };
  });
}

/**
 * News sources management.
 */
export async function listNewsSources({ schoolId }) {
  return sql`
    SELECT * FROM public.news_sources
    WHERE (school_id = ${schoolId} OR school_id IS NULL)
      AND is_active = TRUE
    ORDER BY school_id NULLS LAST, name ASC
  `;
}

export async function createNewsSource({ schoolId, name, sourceUrl, sourceType = 'MANUAL', category = 'General', trustLevel = 'HIGH' }) {
  if (sourceUrl && !isSafeHttpUrl(sourceUrl)) {
    throw new Error('Source URL must be a valid http or https link.');
  }
  const [created] = await sql`
    INSERT INTO public.news_sources (
      school_id,
      name,
      source_url,
      source_type,
      category,
      trust_level
    ) VALUES (
      ${schoolId},
      ${name.trim()},
      ${sourceUrl ? sourceUrl.trim() : null},
      ${sourceType},
      ${category},
      ${trustLevel}
    )
    RETURNING *
  `;
  return created;
}

export async function upsertContentTranslation({
  schoolId,
  contentId,
  language,
  title,
  summary = null,
  body = null,
}) {
  if (!language || !title) {
    throw new Error('Translation language and title are required.');
  }
  const [row] = await sql`
    INSERT INTO public.content_translations (
      content_id, school_id, language, title, summary, body
    ) VALUES (
      ${contentId},
      ${schoolId},
      ${language},
      ${sanitizeRichText(title).trim()},
      ${summary != null ? sanitizeRichText(summary) : null},
      ${body != null ? sanitizeRichText(body) : null}
    )
    ON CONFLICT (content_id, language) DO UPDATE SET
      title = EXCLUDED.title,
      summary = EXCLUDED.summary,
      body = EXCLUDED.body
    RETURNING *
  `;
  return row;
}
