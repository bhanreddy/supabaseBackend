import express from 'express';
import multer from 'multer';
import sql from '../db.js';
import { requireAuth, requirePermission, requireAnyPermission } from '../middleware/auth.js';
import { requireFeature } from '../middleware/requireFeature.js';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  createContentItem,
  updateContentItem,
  deleteContentItem,
  getContentItemById,
  listContentItems,
  getDailyFeedForUser,
  restoreContentVersion,
  listNewsSources,
  createNewsSource,
  upsertContentTranslation,
} from '../services/content/contentService.js';
import {
  transitionContentStatus,
  CONTENT_STATUSES,
} from '../services/content/contentWorkflowService.js';
import {
  recordContentEvent,
  toggleContentBookmark,
  toggleContentLike,
  listUserBookmarks,
  getAdminContentAnalytics,
  ANALYTICS_EVENT_TYPES,
} from '../services/content/contentAnalyticsService.js';
import { uploadContentMedia, ALLOWED_MIME_TYPES } from '../services/content/contentMediaService.js';
import { getContentAuditLogs } from '../services/content/contentAuditService.js';
import { notifyContentPublished } from '../services/content/contentNotificationService.js';
import { upsertContentSchedule } from '../services/content/contentSchedulerService.js';

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 }, // 12MB limit
  fileFilter: (_req, file, cb) => {
    const mime = String(file.mimetype || '').toLowerCase();
    if (!ALLOWED_MIME_TYPES.has(mime)) {
      return cb(new Error('Only JPEG, PNG, or WebP images are allowed.'));
    }
    cb(null, true);
  },
});

// Preserve existing legacy endpoint
router.get('/science-projects', requireAuth, requireFeature('quick.science_projects'), asyncHandler(async (req, res) => {
  const projects = await sql`
    SELECT
      id,
      title,
      description,
      difficulty_level,
      is_group_project,
      min_participants,
      max_participants,
      materials_required,
      safety_instructions,
      thumbnail_url,
      content_url,
      created_at
    FROM science_projects
    WHERE school_id = ${req.schoolId}
    ORDER BY created_at DESC
  `;
  return sendSuccess(res, req.schoolId, projects);
}));

/**
 * GET /api/v1/content/daily
 * Mobile Unified Daily Feed API
 */
router.get('/daily', requireAuth, requirePermission('content.view'), asyncHandler(async (req, res) => {
  const feed = await getDailyFeedForUser({ user: req.user, schoolId: req.schoolId });
  return sendSuccess(res, req.schoolId, feed);
}));

/**
 * GET /api/v1/content
 * List / search content items with pagination and filters
 */
router.get('/', requireAuth, requirePermission('content.view'), asyncHandler(async (req, res) => {
  const {
    type,
    status,
    category,
    author_id,
    is_featured,
    start_date,
    end_date,
    search,
    limit,
    offset,
  } = req.query;

  const result = await listContentItems({
    schoolId: req.schoolId,
    type,
    status,
    category,
    authorId: author_id,
    isFeatured: is_featured !== undefined ? is_featured === 'true' || is_featured === true : undefined,
    startDate: start_date,
    endDate: end_date,
    search,
    limit,
    offset,
  });

  return sendSuccess(res, req.schoolId, result);
}));

/**
 * GET /api/v1/content/sources
 * List configured news sources
 */
router.get('/sources', requireAuth, requirePermission('content.view'), asyncHandler(async (req, res) => {
  const sources = await listNewsSources({ schoolId: req.schoolId });
  return sendSuccess(res, req.schoolId, sources);
}));

/**
 * POST /api/v1/content/sources
 * Create a new news source
 */
router.post('/sources', requireAuth, requirePermission('content.manage'), asyncHandler(async (req, res) => {
  const { name, source_url, source_type, category, trust_level } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Source name is required.' });
  }
  const source = await createNewsSource({
    schoolId: req.schoolId,
    name,
    sourceUrl: source_url,
    sourceType: source_type,
    category,
    trustLevel: trust_level,
  });
  return sendSuccess(res, req.schoolId, source);
}));

/**
 * GET /api/v1/content/bookmarks
 * User's saved bookmarks
 */
router.get('/bookmarks', requireAuth, requirePermission('content.view'), asyncHandler(async (req, res) => {
  const userId = req.user.internal_id || req.user.id;
  const bookmarks = await listUserBookmarks({
    schoolId: req.schoolId,
    userId,
    limit: req.query.limit,
    offset: req.query.offset,
  });
  return sendSuccess(res, req.schoolId, bookmarks);
}));

/**
 * GET /api/v1/content/admin/metrics
 * Analytics overview KPIs for admin dashboard
 */
router.get('/admin/metrics', requireAuth, requireAnyPermission(['content.view', 'content.manage']), asyncHandler(async (req, res) => {
  const days = req.query.days ? parseInt(req.query.days, 10) : 30;
  const analytics = await getAdminContentAnalytics({ schoolId: req.schoolId, days });
  return sendSuccess(res, req.schoolId, analytics);
}));

/**
 * POST /api/v1/content/upload-media
 * Upload & optimize an image (generates JPEG + thumbnail)
 */
router.post(
  '/upload-media',
  requireAuth,
  requireAnyPermission(['content.create', 'content.manage']),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No media file provided.' });
    }
    const uploaded = await uploadContentMedia({
      schoolId: req.schoolId,
      buffer: req.file.buffer,
      mimeType: req.file.mimetype,
      caption: req.body.caption || null,
    });
    return sendSuccess(res, req.schoolId, uploaded);
  }),
);

/**
 * GET /api/v1/content/:id
 * Single item detail with versions, targets, media, audit history
 */
router.get('/:id', requireAuth, requirePermission('content.view'), asyncHandler(async (req, res) => {
  const userId = req.user.internal_id || req.user.id;
  const item = await getContentItemById({
    schoolId: req.schoolId,
    contentId: req.params.id,
    userId,
  });
  if (!item) {
    return res.status(404).json({ error: 'Content item not found.' });
  }
  return sendSuccess(res, req.schoolId, item);
}));

/**
 * GET /api/v1/content/:id/audit
 * Audit history for a content item
 */
router.get('/:id/audit', requireAuth, requireAnyPermission(['content.manage', 'content.approve']), asyncHandler(async (req, res) => {
  const logs = await getContentAuditLogs({
    schoolId: req.schoolId,
    contentId: req.params.id,
  });
  return sendSuccess(res, req.schoolId, logs);
}));

/**
 * POST /api/v1/content
 * Create a content item (Thought or News)
 */
router.post('/', requireAuth, requireAnyPermission(['content.create', 'content.manage']), asyncHandler(async (req, res) => {
  const {
    type,
    title,
    summary,
    body,
    language,
    status,
    priority,
    is_featured,
    cover_image_url,
    cover_storage_path,
    metadata,
    // Thought fields
    quote,
    author,
    author_description,
    category,
    slot_date,
    // News fields
    headline,
    source_name,
    source_url,
    location,
    reading_time,
    tags,
    targets,
    media,
    expires_at,
    scheduled_at,
    override_duplicate,
  } = req.body;

  if (!type || !['THOUGHT', 'NEWS'].includes(type)) {
    return res.status(400).json({ error: 'Valid content type (THOUGHT or NEWS) is required.' });
  }
  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'Title is required.' });
  }

  const created = await createContentItem({
    schoolId: req.schoolId,
    actorUser: req.user,
    type,
    title,
    summary,
    body,
    language,
    status,
    priority,
    isFeatured: is_featured,
    coverImageUrl: cover_image_url,
    coverStoragePath: cover_storage_path,
    metadata,
    quote,
    author,
    authorDescription: author_description,
    category,
    slotDate: slot_date,
    headline,
    sourceName: source_name,
    sourceUrl: source_url,
    location,
    readingTime: reading_time,
    tags,
    targets,
    media,
    expiresAt: expires_at,
    scheduledAt: scheduled_at,
    overrideDuplicate: override_duplicate,
    ipAddress: req.ip,
  });

  return sendSuccess(res, req.schoolId, created, 201);
}));

/**
 * PATCH /api/v1/content/:id
 * Update a content item
 */
router.patch('/:id', requireAuth, requireAnyPermission(['content.create', 'content.manage']), asyncHandler(async (req, res) => {
  const updated = await updateContentItem({
    schoolId: req.schoolId,
    contentId: req.params.id,
    actorUser: req.user,
    ...req.body,
    ipAddress: req.ip,
  });
  return sendSuccess(res, req.schoolId, updated);
}));

/**
 * DELETE /api/v1/content/:id
 * Soft delete a content item
 */
router.delete('/:id', requireAuth, requireAnyPermission(['content.create', 'content.manage']), asyncHandler(async (req, res) => {
  const result = await deleteContentItem({
    schoolId: req.schoolId,
    contentId: req.params.id,
    actorUser: req.user,
    ipAddress: req.ip,
  });
  return sendSuccess(res, req.schoolId, result);
}));

/**
 * POST /api/v1/content/:id/submit
 * Submit content for review
 */
router.post('/:id/submit', requireAuth, requireAnyPermission(['content.submit', 'content.create', 'content.manage']), asyncHandler(async (req, res) => {
  const result = await transitionContentStatus({
    schoolId: req.schoolId,
    contentId: req.params.id,
    toStatus: CONTENT_STATUSES.SUBMITTED,
    actorUser: req.user,
    ipAddress: req.ip,
  });
  return sendSuccess(res, req.schoolId, result);
}));

/**
 * POST /api/v1/content/:id/approve
 * Approve submitted content
 */
router.post('/:id/approve', requireAuth, requireAnyPermission(['content.approve', 'content.manage']), asyncHandler(async (req, res) => {
  const result = await transitionContentStatus({
    schoolId: req.schoolId,
    contentId: req.params.id,
    toStatus: CONTENT_STATUSES.APPROVED,
    actorUser: req.user,
    ipAddress: req.ip,
  });
  return sendSuccess(res, req.schoolId, result);
}));

/**
 * POST /api/v1/content/:id/reject
 * Reject submitted content with reason
 */
router.post('/:id/reject', requireAuth, requireAnyPermission(['content.approve', 'content.manage']), asyncHandler(async (req, res) => {
  const { rejection_reason } = req.body;
  if (!rejection_reason || !rejection_reason.trim()) {
    return res.status(400).json({ error: 'Rejection reason is required.' });
  }
  const result = await transitionContentStatus({
    schoolId: req.schoolId,
    contentId: req.params.id,
    toStatus: CONTENT_STATUSES.REJECTED,
    actorUser: req.user,
    rejectionReason: rejection_reason,
    ipAddress: req.ip,
  });
  return sendSuccess(res, req.schoolId, result);
}));

/**
 * POST /api/v1/content/:id/publish
 * Publish content immediately + dispatch push notification
 */
router.post('/:id/publish', requireAuth, requireAnyPermission(['content.publish', 'content.manage']), asyncHandler(async (req, res) => {
  const result = await transitionContentStatus({
    schoolId: req.schoolId,
    contentId: req.params.id,
    toStatus: CONTENT_STATUSES.PUBLISHED,
    actorUser: req.user,
    overrideDuplicate: Boolean(req.body?.override_duplicate),
    ipAddress: req.ip,
  });

  void notifyContentPublished({
    schoolId: req.schoolId,
    contentId: result.id,
    type: result.type,
    title: result.title,
    summary: result.summary,
  });

  return sendSuccess(res, req.schoolId, result);
}));

/**
 * POST /api/v1/content/:id/schedule
 * Schedule content for future publication
 */
router.post('/:id/schedule', requireAuth, requireAnyPermission(['content.publish', 'content.manage']), asyncHandler(async (req, res) => {
  const { scheduled_at, recurrence_type, time_of_day, weekdays, override_duplicate } = req.body;
  if (!scheduled_at && (!recurrence_type || recurrence_type === 'ONCE')) {
    return res.status(400).json({ error: 'scheduled_at timestamp is required.' });
  }
  const result = await transitionContentStatus({
    schoolId: req.schoolId,
    contentId: req.params.id,
    toStatus: CONTENT_STATUSES.SCHEDULED,
    actorUser: req.user,
    scheduledAt: scheduled_at || new Date(Date.now() + 60 * 1000).toISOString(),
    overrideDuplicate: Boolean(override_duplicate),
    ipAddress: req.ip,
  });
  if (recurrence_type && recurrence_type !== 'ONCE') {
    await upsertContentSchedule({
      schoolId: req.schoolId,
      contentId: req.params.id,
      recurrenceType: recurrence_type,
      timeOfDay: time_of_day || '08:00',
      weekdays: weekdays || [],
      overrideDuplicate: Boolean(override_duplicate),
      scheduledAt: scheduled_at,
    });
  }
  return sendSuccess(res, req.schoolId, result);
}));

router.post('/:id/review', requireAuth, requireAnyPermission(['content.approve', 'content.manage']), asyncHandler(async (req, res) => {
  const result = await transitionContentStatus({
    schoolId: req.schoolId,
    contentId: req.params.id,
    toStatus: CONTENT_STATUSES.UNDER_REVIEW,
    actorUser: req.user,
    ipAddress: req.ip,
  });
  return sendSuccess(res, req.schoolId, result);
}));

router.post('/:id/unpublish', requireAuth, requireAnyPermission(['content.publish', 'content.manage']), asyncHandler(async (req, res) => {
  const result = await transitionContentStatus({
    schoolId: req.schoolId,
    contentId: req.params.id,
    toStatus: CONTENT_STATUSES.APPROVED,
    actorUser: req.user,
    ipAddress: req.ip,
  });
  return sendSuccess(res, req.schoolId, result);
}));

router.post('/:id/translations', requireAuth, requireAnyPermission(['content.create', 'content.manage']), asyncHandler(async (req, res) => {
  const { language, title, summary, body } = req.body;
  const row = await upsertContentTranslation({
    schoolId: req.schoolId,
    contentId: req.params.id,
    language,
    title,
    summary,
    body,
  });
  return sendSuccess(res, req.schoolId, row);
}));

/**
 * POST /api/v1/content/:id/archive
 * Archive content
 */
router.post('/:id/archive', requireAuth, requireAnyPermission(['content.publish', 'content.manage']), asyncHandler(async (req, res) => {
  const result = await transitionContentStatus({
    schoolId: req.schoolId,
    contentId: req.params.id,
    toStatus: CONTENT_STATUSES.ARCHIVED,
    actorUser: req.user,
    ipAddress: req.ip,
  });
  return sendSuccess(res, req.schoolId, result);
}));

/**
 * POST /api/v1/content/:id/restore-version/:versionNumber
 * Rollback content to a previous version
 */
router.post('/:id/restore-version/:versionNumber', requireAuth, requirePermission('content.manage'), asyncHandler(async (req, res) => {
  const result = await restoreContentVersion({
    schoolId: req.schoolId,
    contentId: req.params.id,
    versionNumber: parseInt(req.params.versionNumber, 10),
    actorUser: req.user,
    ipAddress: req.ip,
  });
  return sendSuccess(res, req.schoolId, result);
}));

/**
 * POST /api/v1/content/:id/bookmark
 * Toggle bookmark for user
 */
router.post('/:id/bookmark', requireAuth, requirePermission('content.view'), asyncHandler(async (req, res) => {
  const userId = req.user.internal_id || req.user.id;
  const result = await toggleContentBookmark({
    schoolId: req.schoolId,
    contentId: req.params.id,
    userId,
  });
  return sendSuccess(res, req.schoolId, result);
}));

router.post('/:id/like', requireAuth, requirePermission('content.view'), asyncHandler(async (req, res) => {
  const userId = req.user.internal_id || req.user.id;
  const result = await toggleContentLike({
    schoolId: req.schoolId,
    contentId: req.params.id,
    userId,
  });
  return sendSuccess(res, req.schoolId, result);
}));

/**
 * POST /api/v1/content/:id/analytics
 * Record engagement event (view, like, share, reading completion)
 */
router.post('/:id/analytics', requireAuth, requirePermission('content.view'), asyncHandler(async (req, res) => {
  const userId = req.user.internal_id || req.user.id;
  const { event_type, duration_seconds, metadata } = req.body;
  if (!event_type || !ANALYTICS_EVENT_TYPES[event_type]) {
    return res.status(400).json({ error: 'Valid event_type is required.' });
  }
  await recordContentEvent({
    schoolId: req.schoolId,
    contentId: req.params.id,
    userId,
    eventType: event_type,
    durationSeconds: duration_seconds || 0,
    metadata: metadata || {},
  });
  return sendSuccess(res, req.schoolId, { recorded: true });
}));

export default router;
