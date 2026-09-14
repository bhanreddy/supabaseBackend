import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sql from '../db.js';
import {
  createContentItem,
  getDailyFeedForUser,
} from '../services/content/contentService.js';
import {
  toggleContentBookmark,
  listUserBookmarks,
  recordContentEvent,
} from '../services/content/contentAnalyticsService.js';
import { CONTENT_STATUSES } from '../services/content/contentWorkflowService.js';
import { loadSchool1ContentActors } from './contentTestUsers.js';

describe('Content Engine Daily Feed & Engagement Tests', () => {
  let schoolId = 1;
  let adminUser = null;
  let studentUser = null;
  let thoughtId = null;
  let newsId = null;
  const createdItemIds = [];

  before(async () => {
    const actors = await loadSchool1ContentActors();
    schoolId = actors.schoolId;
    adminUser = actors.adminUser;
    studentUser = actors.studentUser;

    const thoughtItem = await createContentItem({
      schoolId,
      actorUser: adminUser,
      type: 'THOUGHT',
      title: 'Perseverance',
      quote: 'The secret of getting ahead is getting started.',
      author: 'Mark Twain',
      authorDescription: 'American Author',
      category: 'Perseverance',
      status: CONTENT_STATUSES.PUBLISHED,
      overrideDuplicate: true,
      targets: [{ target_type: 'SCHOOL', target_id: 'all' }],
    });
    thoughtId = thoughtItem.id;
    createdItemIds.push(thoughtId);

    const newsItem = await createContentItem({
      schoolId,
      actorUser: adminUser,
      type: 'NEWS',
      title: 'Chandrayaan Next Phase',
      headline: 'ISRO Announces Next Phase of Lunar Exploration',
      summary: 'New rover mission set to analyze polar minerals.',
      sourceName: 'ISRO Updates',
      sourceUrl: 'https://isro.gov.in',
      category: 'Space',
      isFeatured: true,
      readingTime: 3,
      status: CONTENT_STATUSES.PUBLISHED,
      targets: [{ target_type: 'SCHOOL', target_id: 'all' }],
    });
    newsId = newsItem.id;
    createdItemIds.push(newsId);

    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const scheduledItem = await createContentItem({
      schoolId,
      actorUser: adminUser,
      type: 'NEWS',
      title: 'Future Story',
      headline: 'Not Released Yet',
      status: CONTENT_STATUSES.SCHEDULED,
      scheduledAt: futureDate.toISOString(),
      targets: [{ target_type: 'SCHOOL', target_id: 'all' }],
    });
    createdItemIds.push(scheduledItem.id);
  });

  after(async () => {
    if (createdItemIds.length > 0) {
      await sql`DELETE FROM public.content_items WHERE school_id = ${schoolId} AND id = ANY(${createdItemIds})`;
    }
  });

  test('Daily feed returns published thought and news for today', async () => {
    const feed = await getDailyFeedForUser({ user: studentUser, schoolId });
    assert.ok(feed);
    assert.ok(feed.thought, 'Feed must include today thought');
    assert.equal(feed.thought.id, thoughtId);
    assert.equal(feed.thought.quote, 'The secret of getting ahead is getting started.');
    assert.equal(feed.thought.author, 'Mark Twain');

    assert.ok(feed.news.length > 0, 'Feed must include published news');
    const hasChandrayaan = feed.news.some((n) => n.id === newsId);
    assert.equal(hasChandrayaan, true);

    const hasFuture = feed.news.some((n) => n.title === 'Future Story');
    assert.equal(hasFuture, false, 'Scheduled future stories must not leak into feed');
  });

  test('User can bookmark news and retrieve from saved bookmarks', async () => {
    const r1 = await toggleContentBookmark({
      schoolId,
      contentId: newsId,
      userId: studentUser.id,
    });
    assert.equal(r1.bookmarked, true);

    const bookmarks = await listUserBookmarks({
      schoolId,
      userId: studentUser.id,
    });
    assert.ok(bookmarks.length >= 1);
    assert.equal(bookmarks[0].id, newsId);

    const r2 = await toggleContentBookmark({
      schoolId,
      contentId: newsId,
      userId: studentUser.id,
    });
    assert.equal(r2.bookmarked, false);

    const bookmarksAfter = await listUserBookmarks({
      schoolId,
      userId: studentUser.id,
    });
    const found = bookmarksAfter.some((b) => b.id === newsId);
    assert.equal(found, false);
  });

  test('Recording engagement events updates analytics counts', async () => {
    await recordContentEvent({
      schoolId,
      contentId: newsId,
      userId: studentUser.id,
      eventType: 'LIKE',
    });

    await recordContentEvent({
      schoolId,
      contentId: newsId,
      userId: studentUser.id,
      eventType: 'VIEW',
      durationSeconds: 45,
    });

    const feed = await getDailyFeedForUser({ user: studentUser, schoolId });
    const item = feed.news.find((n) => n.id === newsId);
    assert.ok(item);
    assert.equal(item.is_liked, true);
    assert.ok(item.view_count >= 1);
  });
});
