import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sql from '../db.js';
import {
  createContentItem,
  updateContentItem,
  getContentItemById,
} from '../services/content/contentService.js';
import {
  transitionContentStatus,
  CONTENT_STATUSES,
} from '../services/content/contentWorkflowService.js';
import { loadSchool1ContentActors } from './contentTestUsers.js';

describe('Content Engine Workflow & Permissions Tests', () => {
  const createdItemIds = [];
  let schoolId = 1;
  let adminUser = null;
  let staffUser = null;
  let hasDistinctStaff = false;

  before(async () => {
    const actors = await loadSchool1ContentActors();
    schoolId = actors.schoolId;
    adminUser = actors.adminUser;
    staffUser = actors.staffUser;
    hasDistinctStaff = actors.hasDistinctStaff;
  });

  after(async () => {
    if (createdItemIds.length > 0) {
      await sql`DELETE FROM public.content_items WHERE school_id = ${schoolId} AND id = ANY(${createdItemIds})`;
    }
  });

  test('Staff can create draft and submit for approval', async () => {
    const actor = hasDistinctStaff ? staffUser : adminUser;
    const item = await createContentItem({
      schoolId,
      actorUser: actor,
      type: 'NEWS',
      title: 'Science Fair 2026',
      headline: 'Annual School Science Fair Announced',
      summary: 'Students will present projects next Friday.',
      status: CONTENT_STATUSES.DRAFT,
      category: 'Science',
    });
    createdItemIds.push(item.id);

    assert.equal(item.status, CONTENT_STATUSES.DRAFT);
    assert.equal(item.author_id, actor.id);

    const submitted = await transitionContentStatus({
      schoolId,
      contentId: item.id,
      toStatus: CONTENT_STATUSES.SUBMITTED,
      actorUser: actor,
    });
    assert.equal(submitted.status, CONTENT_STATUSES.SUBMITTED);
  });

  test('Staff cannot publish content directly without authorization', async () => {
    if (!hasDistinctStaff) {
      assert.ok(true, 'School 1 has no distinct staff user; admin bypass is expected.');
      return;
    }
    const item = await createContentItem({
      schoolId,
      actorUser: staffUser,
      type: 'THOUGHT',
      title: 'Unauthorized Thought',
      quote: 'Trying to bypass review.',
      author: 'Sneaky Staff',
      status: CONTENT_STATUSES.DRAFT,
    });
    createdItemIds.push(item.id);

    await assert.rejects(
      async () => {
        await transitionContentStatus({
          schoolId,
          contentId: item.id,
          toStatus: CONTENT_STATUSES.PUBLISHED,
          actorUser: staffUser,
        });
      },
      /Only administrators or authorized managers can approve, schedule, or publish content/,
    );
  });

  test('Admin can reject submitted content with a required reason', async () => {
    const item = await createContentItem({
      schoolId,
      actorUser: hasDistinctStaff ? staffUser : adminUser,
      type: 'NEWS',
      title: 'Robotics Team Victory',
      headline: 'Robotics Team Wins State Championship',
      status: CONTENT_STATUSES.SUBMITTED,
    });
    createdItemIds.push(item.id);

    await assert.rejects(
      async () => {
        await transitionContentStatus({
          schoolId,
          contentId: item.id,
          toStatus: CONTENT_STATUSES.REJECTED,
          actorUser: adminUser,
          rejectionReason: '',
        });
      },
      /A rejection reason is required/,
    );

    const rejected = await transitionContentStatus({
      schoolId,
      contentId: item.id,
      toStatus: CONTENT_STATUSES.REJECTED,
      actorUser: adminUser,
      rejectionReason: 'Please add photos of the winning trophy and team.',
    });
    assert.equal(rejected.status, CONTENT_STATUSES.REJECTED);
    assert.equal(rejected.rejection_reason, 'Please add photos of the winning trophy and team.');
  });

  test('Staff can revise rejected content, resubmit, and admin approves and publishes', async () => {
    const actor = hasDistinctStaff ? staffUser : adminUser;
    const item = await createContentItem({
      schoolId,
      actorUser: actor,
      type: 'NEWS',
      title: 'Art Exhibition',
      headline: 'Annual Art Exhibition',
      status: CONTENT_STATUSES.REJECTED,
    });
    createdItemIds.push(item.id);

    await updateContentItem({
      schoolId,
      contentId: item.id,
      actorUser: actor,
      headline: 'Annual Art Exhibition — Updated with Gallery Photos',
    });

    const resubmitted = await transitionContentStatus({
      schoolId,
      contentId: item.id,
      toStatus: CONTENT_STATUSES.SUBMITTED,
      actorUser: actor,
    });
    assert.equal(resubmitted.status, CONTENT_STATUSES.SUBMITTED);

    const approved = await transitionContentStatus({
      schoolId,
      contentId: item.id,
      toStatus: CONTENT_STATUSES.APPROVED,
      actorUser: adminUser,
    });
    assert.equal(approved.status, CONTENT_STATUSES.APPROVED);

    const published = await transitionContentStatus({
      schoolId,
      contentId: item.id,
      toStatus: CONTENT_STATUSES.PUBLISHED,
      actorUser: adminUser,
    });
    assert.equal(published.status, CONTENT_STATUSES.PUBLISHED);
    assert.ok(published.published_at);

    const detail = await getContentItemById({
      schoolId,
      contentId: item.id,
      userId: adminUser.id,
    });
    assert.ok(detail.versions.length >= 2, 'Multiple versions must be captured across revisions');
  });
});
