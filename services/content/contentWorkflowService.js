import sql from '../../db.js';
import { logContentAudit } from './contentAuditService.js';
import { occupyPublishedThoughtSlot } from './contentSchedulerService.js';

export const CONTENT_STATUSES = Object.freeze({
  DRAFT: 'DRAFT',
  SUBMITTED: 'SUBMITTED',
  UNDER_REVIEW: 'UNDER_REVIEW',
  APPROVED: 'APPROVED',
  SCHEDULED: 'SCHEDULED',
  PUBLISHED: 'PUBLISHED',
  REJECTED: 'REJECTED',
  ARCHIVED: 'ARCHIVED',
});

const VALID_TRANSITIONS = {
  [CONTENT_STATUSES.DRAFT]: [CONTENT_STATUSES.SUBMITTED, CONTENT_STATUSES.PUBLISHED, CONTENT_STATUSES.SCHEDULED, CONTENT_STATUSES.ARCHIVED],
  [CONTENT_STATUSES.SUBMITTED]: [CONTENT_STATUSES.UNDER_REVIEW, CONTENT_STATUSES.APPROVED, CONTENT_STATUSES.REJECTED, CONTENT_STATUSES.DRAFT],
  [CONTENT_STATUSES.UNDER_REVIEW]: [CONTENT_STATUSES.APPROVED, CONTENT_STATUSES.REJECTED, CONTENT_STATUSES.SUBMITTED],
  [CONTENT_STATUSES.APPROVED]: [CONTENT_STATUSES.SCHEDULED, CONTENT_STATUSES.PUBLISHED, CONTENT_STATUSES.ARCHIVED],
  [CONTENT_STATUSES.SCHEDULED]: [CONTENT_STATUSES.PUBLISHED, CONTENT_STATUSES.APPROVED, CONTENT_STATUSES.ARCHIVED],
  [CONTENT_STATUSES.PUBLISHED]: [CONTENT_STATUSES.ARCHIVED, CONTENT_STATUSES.APPROVED],
  [CONTENT_STATUSES.REJECTED]: [CONTENT_STATUSES.DRAFT, CONTENT_STATUSES.SUBMITTED, CONTENT_STATUSES.ARCHIVED],
  [CONTENT_STATUSES.ARCHIVED]: [CONTENT_STATUSES.DRAFT, CONTENT_STATUSES.APPROVED],
};

export function isValidTransition(fromStatus, toStatus) {
  if (!fromStatus || !toStatus) return false;
  if (fromStatus === toStatus) return true;
  const allowed = VALID_TRANSITIONS[fromStatus] || [];
  return allowed.includes(toStatus);
}

export async function transitionContentStatus({
  schoolId,
  contentId,
  toStatus,
  actorUser,
  rejectionReason = null,
  scheduledAt = null,
  overrideDuplicate = false,
  ipAddress = null,
}) {
  const [item] = await sql`
    SELECT id, school_id, type, title, status, author_id, scheduled_at, published_at
    FROM public.content_items
    WHERE id = ${contentId} AND school_id = ${schoolId} AND deleted_at IS NULL
  `;

  if (!item) {
    throw new Error('Content item not found.');
  }

  const currentStatus = item.status;
  const roles = actorUser.roles || [];
  const isAdmin = roles.some((r) => ['admin', 'principal'].includes(r));
  const userId = actorUser.internal_id || actorUser.id;
  const permissions = actorUser.permissions || [];

  if (toStatus === CONTENT_STATUSES.PUBLISHED || toStatus === CONTENT_STATUSES.SCHEDULED) {
    if (!isAdmin && !permissions.includes('content.publish') && !permissions.includes('content.manage')) {
      throw new Error('Only administrators or authorized managers can approve, schedule, or publish content.');
    }
  }

  if (toStatus === CONTENT_STATUSES.APPROVED || toStatus === CONTENT_STATUSES.UNDER_REVIEW) {
    if (!isAdmin && !permissions.includes('content.approve') && !permissions.includes('content.manage')) {
      throw new Error('Only administrators or authorized reviewers can review or approve content.');
    }
  }

  if (toStatus === CONTENT_STATUSES.REJECTED) {
    if (!isAdmin && !permissions.includes('content.approve') && !permissions.includes('content.manage')) {
      throw new Error('Only administrators can reject submitted content.');
    }
    if (!rejectionReason || !rejectionReason.trim()) {
      throw new Error('A rejection reason is required when rejecting content.');
    }
  }

  if (toStatus === CONTENT_STATUSES.SUBMITTED) {
    const isAuthor = item.author_id === userId;
    const canSubmit = isAuthor || isAdmin || permissions.includes('content.submit');
    if (!canSubmit) {
      throw new Error('You are not authorized to submit this content.');
    }
  }

  if (!isValidTransition(currentStatus, toStatus)) {
    if (isAdmin && currentStatus === CONTENT_STATUSES.DRAFT && (toStatus === CONTENT_STATUSES.PUBLISHED || toStatus === CONTENT_STATUSES.SCHEDULED)) {
      // Admin shortcut from draft
    } else {
      throw new Error(`Cannot transition content from ${currentStatus} to ${toStatus}.`);
    }
  }

  let publishedAtVal = item.published_at;
  let scheduledAtVal = scheduledAt ? new Date(scheduledAt) : item.scheduled_at;
  let approvedByVal = null;
  let publishedByVal = null;
  const unpublishing = currentStatus === CONTENT_STATUSES.PUBLISHED && toStatus === CONTENT_STATUSES.APPROVED;

  if (toStatus === CONTENT_STATUSES.APPROVED && !unpublishing) {
    approvedByVal = userId;
  } else if (toStatus === CONTENT_STATUSES.PUBLISHED) {
    publishedAtVal = new Date();
    publishedByVal = userId;
    scheduledAtVal = null;
    if (item.type === 'THOUGHT') {
      await occupyPublishedThoughtSlot({ schoolId, contentId, overrideDuplicate });
    }
  } else if (toStatus === CONTENT_STATUSES.SCHEDULED) {
    if (!scheduledAtVal || new Date(scheduledAtVal) <= new Date()) {
      throw new Error('A valid future date and time is required when scheduling content.');
    }
  } else if (toStatus === CONTENT_STATUSES.ARCHIVED || unpublishing) {
    await sql`
      UPDATE public.content_thoughts
      SET occupies_slot = FALSE, updated_at = NOW()
      WHERE content_id = ${contentId} AND school_id = ${schoolId}
    `;
  }

  const action = unpublishing ? 'UNPUBLISHED' : `STATUS_${toStatus}`;

  const [updated] = await sql`
    UPDATE public.content_items
    SET
      status = ${toStatus},
      rejection_reason = ${toStatus === CONTENT_STATUSES.REJECTED ? rejectionReason.trim() : null},
      approved_by = COALESCE(${approvedByVal}, approved_by),
      published_by = COALESCE(${publishedByVal}, published_by),
      published_at = ${publishedAtVal},
      scheduled_at = ${scheduledAtVal},
      updated_at = NOW()
    WHERE id = ${contentId} AND school_id = ${schoolId}
    RETURNING *
  `;

  await logContentAudit({
    schoolId,
    contentId,
    action,
    performedBy: userId,
    changedFields: {
      fromStatus: currentStatus,
      toStatus,
      rejectionReason: toStatus === CONTENT_STATUSES.REJECTED ? rejectionReason : undefined,
      scheduledAt: scheduledAtVal,
    },
    previousState: { status: currentStatus },
    newState: { status: toStatus },
    ipAddress,
  });

  return updated;
}
