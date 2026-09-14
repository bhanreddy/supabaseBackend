import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sql from '../db.js';
import {
  createContentItem,
  getContentItemById,
  listContentItems,
  deleteContentItem,
} from '../services/content/contentService.js';
import { CONTENT_STATUSES } from '../services/content/contentWorkflowService.js';
import { CONTENT_TEST_SCHOOL_ID, loadSchool1ContentActors } from './contentTestUsers.js';

describe('Content Engine Tenant Isolation Tests', () => {
  const schoolId = CONTENT_TEST_SCHOOL_ID;
  const foreignSchoolId = 99999;
  let testUser = null;
  let itemId = null;

  before(async () => {
    const actors = await loadSchool1ContentActors();
    testUser = actors.adminUser;

    const item = await createContentItem({
      schoolId,
      actorUser: testUser,
      type: 'THOUGHT',
      title: 'Alpha Wisdom',
      quote: 'Knowledge is power.',
      author: 'Francis Bacon',
      category: 'Philosophy',
      status: CONTENT_STATUSES.PUBLISHED,
      slotDate: '2099-01-01',
      overrideDuplicate: true,
    });
    itemId = item.id;
  });

  after(async () => {
    if (itemId) {
      await sql`DELETE FROM public.content_items WHERE school_id = ${schoolId} AND id = ${itemId}`;
    }
  });

  test('School 1 owner can read School 1 content item', async () => {
    const item = await getContentItemById({
      schoolId,
      contentId: itemId,
      userId: testUser.id,
    });
    assert.ok(item);
    assert.equal(item.id, itemId);
    assert.equal(item.school_id, schoolId);
    assert.equal(item.title, 'Alpha Wisdom');
  });

  test('A foreign school_id cannot read School 1 content', async () => {
    const item = await getContentItemById({
      schoolId: foreignSchoolId,
      contentId: itemId,
      userId: testUser.id,
    });
    assert.equal(item, null, 'Cross-tenant lookup must return null');
  });

  test('Listing with a foreign school_id does not include School 1 items', async () => {
    const res = await listContentItems({
      schoolId: foreignSchoolId,
      limit: 20,
    });
    const found = res.items.some((i) => i.id === itemId);
    assert.equal(found, false, 'School 1 items must never appear under another school_id');
  });

  test('A foreign school_id cannot delete School 1 content', async () => {
    await assert.rejects(
      async () => {
        await deleteContentItem({
          schoolId: foreignSchoolId,
          contentId: itemId,
          actorUser: { ...testUser, schoolId: foreignSchoolId },
        });
      },
      /Content item not found or already deleted/,
    );
  });
});
