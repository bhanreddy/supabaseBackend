import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sql from '../db.js';
import { createContentItem } from '../services/content/contentService.js';
import { transitionContentStatus, CONTENT_STATUSES } from '../services/content/contentWorkflowService.js';
import { processScheduledPublishing } from '../services/content/contentSchedulerService.js';
import { getDailyFeedForUser } from '../services/content/contentService.js';
import { setContentTargets, resolveEligibleRecipientsForContent } from '../services/content/contentTargetService.js';
import { loadSchool1ContentActors } from './contentTestUsers.js';

describe('Content Engine scheduling and targeting', () => {
  const createdItemIds = [];
  let schoolId = 1;
  let adminUser = null;
  let studentUser = null;
  let hasDistinctStudent = false;

  before(async () => {
    const actors = await loadSchool1ContentActors();
    schoolId = actors.schoolId;
    adminUser = actors.adminUser;
    studentUser = actors.studentUser;
    hasDistinctStudent = actors.hasDistinctStudent;
  });

  after(async () => {
    if (createdItemIds.length > 0) {
      await sql`DELETE FROM public.content_items WHERE school_id = ${schoolId} AND id = ANY(${createdItemIds})`;
    }
  });

  test('Scheduled news does not appear in the daily feed before publish time', async () => {
    const future = new Date(Date.now() + 6 * 60 * 60 * 1000);
    const item = await createContentItem({
      schoolId,
      actorUser: adminUser,
      type: 'NEWS',
      title: 'Queued exclusive',
      headline: 'Queued exclusive',
      summary: 'Should stay hidden until published.',
      status: CONTENT_STATUSES.SCHEDULED,
      scheduledAt: future.toISOString(),
      targets: [{ target_type: 'SCHOOL', target_id: 'all' }],
    });
    createdItemIds.push(item.id);

    await sql`
      UPDATE public.content_items
      SET status = 'SCHEDULED', scheduled_at = ${future.toISOString()}
      WHERE school_id = ${schoolId} AND id = ${item.id}
    `;

    const feed = await getDailyFeedForUser({ user: studentUser, schoolId });
    assert.equal(feed.news.some((n) => n.id === item.id), false);
  });

  test('Overdue scheduled items publish server-side without a client being open', async () => {
    const item = await createContentItem({
      schoolId,
      actorUser: adminUser,
      type: 'NEWS',
      title: 'Overdue scheduled story',
      headline: 'Overdue scheduled story',
      summary: 'Should publish via scheduler.',
      status: CONTENT_STATUSES.DRAFT,
      targets: [{ target_type: 'SCHOOL', target_id: 'all' }],
    });
    createdItemIds.push(item.id);

    const past = new Date(Date.now() - 60 * 1000);
    await sql`
      UPDATE public.content_items
      SET status = 'SCHEDULED', scheduled_at = ${past.toISOString()}
      WHERE school_id = ${schoolId} AND id = ${item.id}
    `;

    const result = await processScheduledPublishing(schoolId);
    assert.ok(result.publishedCount >= 1);

    const [row] = await sql`SELECT status FROM public.content_items WHERE school_id = ${schoolId} AND id = ${item.id}`;
    assert.equal(row.status, 'PUBLISHED');

    const feed = await getDailyFeedForUser({ user: studentUser, schoolId });
    assert.equal(feed.news.some((n) => n.id === item.id), true);
  });

  test('Role targeting excludes users who are not in the audience', async () => {
    if (!hasDistinctStudent) {
      assert.ok(true, 'School 1 has no distinct student user to exclude from staff targeting.');
      return;
    }
    const item = await createContentItem({
      schoolId,
      actorUser: adminUser,
      type: 'NEWS',
      title: 'Staff-only briefing',
      headline: 'Staff-only briefing',
      status: CONTENT_STATUSES.PUBLISHED,
      targets: [{ target_type: 'ROLE', target_id: 'staff' }],
    });
    createdItemIds.push(item.id);

    await setContentTargets({
      schoolId,
      contentId: item.id,
      targets: [{ target_type: 'ROLE', target_id: 'staff' }],
    });

    const recipients = await resolveEligibleRecipientsForContent({
      schoolId,
      contentId: item.id,
    });
    assert.equal(recipients.includes(studentUser.id), false);
  });

  test('Duplicate thought slot is blocked unless override_duplicate is set', async () => {
    const [slotColumn] = await sql`
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'content_thoughts'
        AND column_name = 'occupies_slot'
    `;
    if (!slotColumn) {
      assert.ok(true, 'Hardening migration not applied yet; slot uniqueness is skipped.');
      return;
    }

    const slotDate = '2098-12-25';
    const first = await createContentItem({
      schoolId,
      actorUser: adminUser,
      type: 'THOUGHT',
      title: 'First slot occupant',
      quote: 'Occupy the slot.',
      author: 'Editor',
      slotDate,
      status: CONTENT_STATUSES.PUBLISHED,
      overrideDuplicate: true,
    });
    createdItemIds.push(first.id);

    const second = await createContentItem({
      schoolId,
      actorUser: adminUser,
      type: 'THOUGHT',
      title: 'Second slot occupant',
      quote: 'Should not steal the slot.',
      author: 'Editor',
      slotDate,
      status: CONTENT_STATUSES.APPROVED,
    });
    createdItemIds.push(second.id);

    await assert.rejects(
      () => transitionContentStatus({
        schoolId,
        contentId: second.id,
        toStatus: CONTENT_STATUSES.PUBLISHED,
        actorUser: adminUser,
        overrideDuplicate: false,
      }),
      /already occupies/,
    );

    const published = await transitionContentStatus({
      schoolId,
      contentId: second.id,
      toStatus: CONTENT_STATUSES.PUBLISHED,
      actorUser: adminUser,
      overrideDuplicate: true,
    });
    assert.equal(published.status, 'PUBLISHED');
  });
});
