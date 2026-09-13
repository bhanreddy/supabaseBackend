import test from 'node:test';
import assert from 'node:assert/strict';
import sql from '../db.js';
import CalendarService from '../services/calendarService.js';
import { resolveSchoolDay } from '../services/workingDayResolver.js';

const TEST_SCHOOL_ID = 13;

test('Event CRUD lifecycle: Draft -> Publish -> Update -> Cancel -> Soft Delete with Audit & Reminders', async () => {
  const createdIds = [];

  try {
    // 1. Create a draft event
    const event = await CalendarService.createEvent({
      schoolId: TEST_SCHOOL_ID,
      data: {
        title: 'Science Fair 2026',
        description: 'Annual campus exhibition',
        event_type: 'SCHOOL_EVENT',
        start_date: '2026-11-25',
        end_date: '2026-11-25',
        start_time: '10:00:00',
        end_time: '15:00:00',
        status: 'DRAFT',
        reminder_schedules: ['1d', '1h'],
      },
      targets: [{ target_type: 'ENTIRE_SCHOOL', target_id: 'ALL' }],
    });
    createdIds.push(event.id);

    assert.equal(event.title, 'Science Fair 2026');
    assert.equal(event.status, 'DRAFT');

    // Verify history recorded CREATED
    const [createHistory] = await sql`
      SELECT change_type FROM calendar_event_history WHERE event_id = ${event.id}
    `;
    assert.equal(createHistory.change_type, 'CREATED');

    // 2. Publish event
    const published = await CalendarService.publishEvent({
      schoolId: TEST_SCHOOL_ID,
      eventId: event.id,
    });
    assert.equal(published.status, 'PUBLISHED');
    assert.ok(published.published_at);

    // Verify reminders scheduled
    const reminders = await sql`
      SELECT id, status, remind_at FROM calendar_event_reminders
      WHERE event_id = ${event.id}
    `;
    assert.ok(reminders.length > 0, 'Reminder rows created on publish');
    assert.ok(reminders.every((r) => r.status === 'PENDING'), 'Reminders are pending');

    // 3. Update event title and location
    const updated = await CalendarService.updateEvent({
      schoolId: TEST_SCHOOL_ID,
      eventId: event.id,
      data: {
        title: 'Science & Robotics Fair 2026',
        location: 'Science Block Lab 1',
      },
    });
    assert.equal(updated.title, 'Science & Robotics Fair 2026');
    assert.equal(updated.location, 'Science Block Lab 1');

    // 4. Cancel event
    const cancelled = await CalendarService.cancelEvent({
      schoolId: TEST_SCHOOL_ID,
      eventId: event.id,
      reason: 'Postponed due to heavy rain forecast',
    });
    assert.equal(cancelled.status, 'CANCELLED');
    assert.equal(cancelled.cancellation_reason, 'Postponed due to heavy rain forecast');

    // Verify pending reminders were cancelled
    const cancelledReminders = await sql`
      SELECT status FROM calendar_event_reminders WHERE event_id = ${event.id}
    `;
    assert.ok(cancelledReminders.every((r) => r.status === 'CANCELLED'), 'Reminders set to cancelled');

    // 5. Soft delete event
    await CalendarService.deleteEvent({
      schoolId: TEST_SCHOOL_ID,
      eventId: event.id,
    });
    const [deleted] = await sql`
      SELECT deleted_at FROM calendar_events WHERE id = ${event.id}
    `;
    assert.ok(deleted.deleted_at, 'Event deleted_at timestamp is populated');
  } finally {
    // Hard cleanup test IDs
    for (const id of createdIds) {
      await sql`DELETE FROM calendar_events WHERE id = ${id}`;
    }
  }
});

test('Exam module sync: scheduling paper creates calendar event, rescheduling updates it, deleting removes it', async () => {
  const fakeSubjectId = 'exam-subj-test-999';

  try {
    // 1. Add paper exam timetable
    const synced = await CalendarService.syncSourceEvent({
      schoolId: TEST_SCHOOL_ID,
      sourceModule: 'EXAM',
      sourceEntityId: fakeSubjectId,
      eventData: {
        title: 'Class 10: Science Paper Exam',
        event_type: 'EXAM',
        start_date: '2026-10-15',
        end_date: '2026-10-15',
        start_time: '09:30:00',
        end_time: '12:30:00',
        priority: 'HIGH',
        attendance_enabled: false,
        timetable_enabled: false,
      },
      targets: [{ target_type: 'CLASS', target_id: 'class-10-uuid' }],
    });

    assert.ok(synced.id);
    assert.equal(synced.source_module, 'EXAM');
    assert.equal(synced.source_entity_id, fakeSubjectId);
    assert.equal(synced.start_date, '2026-10-15');

    // 2. Reschedule paper to Oct 18 — verify same event row updated without duplicate
    const rescheduled = await CalendarService.syncSourceEvent({
      schoolId: TEST_SCHOOL_ID,
      sourceModule: 'EXAM',
      sourceEntityId: fakeSubjectId,
      eventData: {
        title: 'Class 10: Science Paper Exam (Rescheduled)',
        start_date: '2026-10-18',
        end_date: '2026-10-18',
        start_time: '10:00:00',
        end_time: '13:00:00',
      },
    });

    assert.equal(rescheduled.id, synced.id, 'Rescheduled exam updates existing event ID');
    assert.equal(rescheduled.start_date, '2026-10-18');
    assert.equal(rescheduled.title, 'Class 10: Science Paper Exam (Rescheduled)');

    // Verify only 1 event exists for this source entity
    const count = await sql`
      SELECT count(*) as total FROM calendar_events
      WHERE school_id = ${TEST_SCHOOL_ID} AND source_module = 'EXAM' AND source_entity_id = ${fakeSubjectId}
        AND deleted_at IS NULL
    `;
    assert.equal(Number(count[0].total), 1, 'No duplicate exam events created');

    // 3. Clear paper exam: passing null removes the calendar event
    await CalendarService.syncSourceEvent(TEST_SCHOOL_ID, 'EXAM', fakeSubjectId, null);

    const checkDeleted = await sql`
      SELECT status, deleted_at FROM calendar_events
      WHERE id = ${synced.id}
    `;
    assert.equal(checkDeleted[0].status, 'CANCELLED', 'Published source event is cancelled when sync passed null');
  } finally {
    await sql`DELETE FROM calendar_events WHERE source_module = 'EXAM' AND source_entity_id = ${fakeSubjectId}`;
  }
});

test('Fees module sync: supports positional call signature and null removal', async () => {
  const fakeFeeStructureId = 'fee-struct-test-888';

  try {
    // 1. Fees module creates a fee due date via positional call
    const feeEvent = await CalendarService.syncSourceEvent(
      TEST_SCHOOL_ID,
      'FEES',
      fakeFeeStructureId,
      {
        title: 'Fee Due: Term 2 Tuition Fee (₹15,000)',
        description: 'Fee payment due. Please clear dues to avoid late fees.',
        event_type: 'FEE_DUE',
        start_date: '2026-11-10',
        end_date: '2026-11-10',
        priority: 'HIGH',
        status: 'PUBLISHED',
        target_type: 'ENTIRE_SCHOOL',
        target_ids: ['ALL'],
      }
    );

    assert.ok(feeEvent.id);
    assert.equal(feeEvent.source_module, 'FEES');
    assert.equal(feeEvent.event_type, 'FEE_DUE');
    assert.equal(feeEvent.start_date, '2026-11-10');

    // 2. Fees module deletes fee structure: passes null
    await CalendarService.syncSourceEvent(TEST_SCHOOL_ID, 'FEES', fakeFeeStructureId, null);

    const [deleted] = await sql`
      SELECT status FROM calendar_events WHERE id = ${feeEvent.id}
    `;
    assert.equal(deleted.status, 'CANCELLED', 'Fee event is cancelled when null is passed');
  } finally {
    await sql`DELETE FROM calendar_events WHERE source_module = 'FEES' AND source_entity_id = ${fakeFeeStructureId}`;
  }
});

test('Homework/Diary module sync: supports positional call signature and null removal', async () => {
  const fakeDiaryId = 'diary-entry-test-777';

  try {
    // 1. Diary entry with homework due date
    const hwEvent = await CalendarService.syncSourceEvent(
      TEST_SCHOOL_ID,
      'HOMEWORK',
      fakeDiaryId,
      {
        title: 'Homework: Science - Solar System Model',
        description: 'Submit 3D solar system model by Friday.',
        event_type: 'HOMEWORK',
        start_date: '2026-11-13',
        end_date: '2026-11-13',
        priority: 'NORMAL',
        target_type: 'SECTION',
        target_ids: ['sec-7a-uuid'],
      }
    );

    assert.ok(hwEvent.id);
    assert.equal(hwEvent.source_module, 'HOMEWORK');
    assert.equal(hwEvent.start_date, '2026-11-13');

    // 2. Homework deleted: passes null
    await CalendarService.syncSourceEvent(TEST_SCHOOL_ID, 'HOMEWORK', fakeDiaryId, null);

    const [deleted] = await sql`
      SELECT status FROM calendar_events WHERE id = ${hwEvent.id}
    `;
    assert.equal(deleted.status, 'CANCELLED', 'Homework event is cancelled when null is passed');
  } finally {
    await sql`DELETE FROM calendar_events WHERE source_module = 'HOMEWORK' AND source_entity_id = ${fakeDiaryId}`;
  }
});

test('Recurring event modification: THIS_EVENT creates override child and adds exception to master', async () => {
  let masterId = null;
  const createdIds = [];

  try {
    // 1. Create weekly recurring meeting every Friday from 2026-11-01 to 2026-11-30
    const master = await CalendarService.createEvent({
      schoolId: TEST_SCHOOL_ID,
      data: {
        title: 'Weekly Staff Briefing',
        event_type: 'STAFF_MEETING',
        start_date: '2026-11-06', // First Friday of Nov 2026
        end_date: '2026-11-06',
        start_time: '16:00:00',
        end_time: '17:00:00',
        recurrence_rule: {
          frequency: 'WEEKLY',
          days_of_week: ['friday'],
          until: '2026-11-30',
        },
        status: 'PUBLISHED',
      },
      targets: [{ target_type: 'ROLE', target_id: 'staff' }],
    });
    masterId = master.id;
    createdIds.push(masterId);

    // 2. Modify Friday Nov 20 meeting only (THIS_EVENT scope: moved to 15:00 with special topic)
    const override = await CalendarService.updateRecurringEvent({
      schoolId: TEST_SCHOOL_ID,
      eventId: master.id,
      scope: 'THIS_EVENT',
      occurrenceDate: '2026-11-20',
      data: {
        title: 'Special Staff Briefing: Accreditation Prep',
        start_time: '15:00:00',
        end_time: '16:30:00',
      },
    });
    createdIds.push(override.id);

    assert.equal(override.title, 'Special Staff Briefing: Accreditation Prep');
    assert.equal(override.start_date, '2026-11-20');
    assert.equal(override.recurrence_parent_id, master.id);

    // 3. Verify master event's recurrence_rule.exceptions contains '2026-11-20'
    const [updatedMasterRow] = await sql`
      SELECT recurrence_rule FROM calendar_events WHERE id = ${master.id}
    `;
    const masterRule = typeof updatedMasterRow.recurrence_rule === 'string'
      ? JSON.parse(updatedMasterRow.recurrence_rule)
      : updatedMasterRow.recurrence_rule;
    assert.ok(masterRule.exceptions.includes('2026-11-20'));

    // 4. Query events for Nov 2026 as admin user:
    // Should contain:
    // - Friday Nov 6 (master occurrence)
    // - Friday Nov 13 (master occurrence)
    // - Friday Nov 20 (the special override child)
    // - Friday Nov 27 (master occurrence)
    const adminUser = { roles: ['admin'] };
    const monthEvents = await CalendarService.getEventsForUser({
      schoolId: TEST_SCHOOL_ID,
      user: adminUser,
      startDate: '2026-11-01',
      endDate: '2026-11-30',
    });

    const nov20Event = monthEvents.find((e) => e.start_date === '2026-11-20');
    assert.ok(nov20Event, 'Event exists on Nov 20');
    assert.equal(nov20Event.title, 'Special Staff Briefing: Accreditation Prep', 'Shows overridden title on Nov 20');

    const nov6Event = monthEvents.find((e) => e.start_date === '2026-11-06');
    assert.ok(nov6Event, 'Regular recurrence on Nov 6 retained');
    assert.equal(nov6Event.title, 'Weekly Staff Briefing');
  } finally {
    for (const id of createdIds) {
      await sql`DELETE FROM calendar_events WHERE id = ${id}`;
    }
  }
});

test.after(async () => {
  await new Promise((r) => setTimeout(r, 500));
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(0);
});
