import sql from '../db.js';
import { randomUUID } from 'node:crypto';
import { normalizeWebsiteGalleryImage } from '../utils/websiteGalleryImage.js';
import {
  actorUserId,
  groupStoriesByAuthor,
  normalizePortalText,
  resolveStoryAuthorRole,
  schoolStoryObjectPath,
  uploadSchoolPortalImage,
  removeSchoolPortalImage,
} from '../utils/schoolPortalMedia.js';

export const STORY_TTL_HOURS = 24;
export const MAX_ACTIVE_STORIES_PER_AUTHOR = 8;
export const MAX_ACTIVE_STORIES_PER_SCHOOL = 80;

function missingRelation(error) {
  return error?.code === '42P01' || /does not exist/i.test(error?.message || '');
}

export { groupStoriesByAuthor };

async function loadAuthorProfile(userId, schoolId) {
  const [person] = await sql`
    SELECT
      COALESCE(NULLIF(BTRIM(p.display_name), ''), NULLIF(BTRIM(p.first_name), ''), 'School') AS author_name,
      p.photo_url AS author_photo_url
    FROM users u
    JOIN persons p ON p.id = u.person_id
    WHERE u.id = ${userId}
      AND u.school_id = ${schoolId}
      AND u.deleted_at IS NULL
    LIMIT 1
  `;
  return {
    author_name: person?.author_name || 'School',
    author_photo_url: person?.author_photo_url || null,
  };
}

export async function listActiveStories(schoolId, viewerUserId) {
  try {
    const rows = await sql`
    SELECT
      s.id,
      s.media_url,
      s.caption,
      s.created_at,
      s.expires_at,
      s.uploaded_by,
      s.author_name,
      s.author_photo_url,
      s.author_role,
      EXISTS (
        SELECT 1
        FROM school_story_views v
        WHERE v.story_id = s.id
          AND v.user_id = ${viewerUserId}
          AND v.school_id = ${schoolId}
      ) AS seen
    FROM school_stories s
    WHERE s.school_id = ${schoolId}
      AND s.deleted_at IS NULL
      AND s.expires_at > NOW()
    ORDER BY s.created_at DESC
  `;
    return groupStoriesByAuthor(rows);
  } catch (error) {
    if (missingRelation(error)) return [];
    throw error;
  }
}

export async function listManagedStories(schoolId, user, { all = false } = {}) {
  const userId = actorUserId(user);
  const isAdmin = (user?.roles || []).some((role) => ['admin', 'principal'].includes(role));
  const showAll = all && isAdmin;

  const rows = await sql`
    SELECT
      s.id,
      s.media_url,
      s.caption,
      s.created_at,
      s.expires_at,
      s.uploaded_by,
      s.author_name,
      s.author_photo_url,
      s.author_role,
      FALSE AS seen,
      (${isAdmin} OR s.uploaded_by = ${userId}) AS can_delete
    FROM school_stories s
    WHERE s.school_id = ${schoolId}
      AND s.deleted_at IS NULL
      AND s.expires_at > NOW()
      AND (${showAll} OR s.uploaded_by = ${userId})
    ORDER BY s.created_at DESC
  `;
  return groupStoriesByAuthor(rows);
}

export async function createStory(schoolId, user, { buffer, caption } = {}) {
  const userId = actorUserId(user);
  if (!userId) {
    const error = new Error('Unauthorized');
    error.statusCode = 401;
    throw error;
  }
  if (!buffer?.length) {
    const error = new Error('Attach an image under the "image" field.');
    error.statusCode = 400;
    throw error;
  }

  const [{ schoolCount }] = await sql`
    SELECT COUNT(*)::int AS "schoolCount"
    FROM school_stories
    WHERE school_id = ${schoolId}
      AND deleted_at IS NULL
      AND expires_at > NOW()
  `;
  if (schoolCount >= MAX_ACTIVE_STORIES_PER_SCHOOL) {
    const error = new Error(`A school can have up to ${MAX_ACTIVE_STORIES_PER_SCHOOL} live stories.`);
    error.statusCode = 400;
    throw error;
  }

  const [{ authorCount }] = await sql`
    SELECT COUNT(*)::int AS "authorCount"
    FROM school_stories
    WHERE school_id = ${schoolId}
      AND uploaded_by = ${userId}
      AND deleted_at IS NULL
      AND expires_at > NOW()
  `;
  if (authorCount >= MAX_ACTIVE_STORIES_PER_AUTHOR) {
    const error = new Error(`You can have up to ${MAX_ACTIVE_STORIES_PER_AUTHOR} live stories at once.`);
    error.statusCode = 400;
    throw error;
  }

  let normalized;
  try {
    normalized = await normalizeWebsiteGalleryImage(buffer);
  } catch (err) {
    const error = new Error(
      /optimize/i.test(err?.message || '') ? err.message : 'The uploaded file is not a valid supported image.',
    );
    error.statusCode = 400;
    throw error;
  }

  const profile = await loadAuthorProfile(userId, schoolId);
  const imageId = randomUUID();
  const storagePath = schoolStoryObjectPath(schoolId, imageId);
  const { imageUrl } = await uploadSchoolPortalImage(storagePath, normalized.buffer);

  try {
    const [item] = await sql`
      INSERT INTO school_stories (
        id, school_id, media_url, storage_path, caption, uploaded_by,
        author_name, author_photo_url, author_role, expires_at
      )
      VALUES (
        ${imageId},
        ${schoolId},
        ${imageUrl},
        ${storagePath},
        ${normalizePortalText(caption, 180)},
        ${userId},
        ${profile.author_name},
        ${profile.author_photo_url},
        ${resolveStoryAuthorRole(user.roles)},
        NOW() + INTERVAL '24 hours'
      )
      RETURNING
        id, media_url, caption, created_at, expires_at, uploaded_by,
        author_name, author_photo_url, author_role
    `;
    return item;
  } catch (error) {
    await removeSchoolPortalImage(storagePath).catch(() => {});
    throw error;
  }
}

export async function deleteStory(schoolId, user, storyId) {
  const userId = actorUserId(user);
  const isAdmin = (user?.roles || []).some((role) => ['admin', 'principal'].includes(role));
  const [removed] = await sql`
    UPDATE school_stories
    SET deleted_at = NOW()
    WHERE id = ${storyId}
      AND school_id = ${schoolId}
      AND deleted_at IS NULL
      AND (${isAdmin} OR uploaded_by = ${userId})
    RETURNING id, storage_path
  `;
  if (!removed) {
    const error = new Error('Story not found');
    error.statusCode = 404;
    throw error;
  }
  await removeSchoolPortalImage(removed.storage_path).catch(() => {});
  return { id: removed.id };
}

export async function markStoryViewed(schoolId, user, storyId) {
  const userId = actorUserId(user);
  const [story] = await sql`
    SELECT id
    FROM school_stories
    WHERE id = ${storyId}
      AND school_id = ${schoolId}
      AND deleted_at IS NULL
      AND expires_at > NOW()
    LIMIT 1
  `;
  if (!story) {
    const error = new Error('Story not found');
    error.statusCode = 404;
    throw error;
  }

  await sql`
    INSERT INTO school_story_views (school_id, story_id, user_id)
    VALUES (${schoolId}, ${storyId}, ${userId})
    ON CONFLICT (school_id, story_id, user_id) DO UPDATE SET viewed_at = NOW()
  `;
  return { id: storyId, viewed: true };
}
