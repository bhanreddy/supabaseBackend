import test from 'node:test';
import assert from 'node:assert/strict';
import sql, { withTenantContext } from '../db.js';
import CalendarService from '../services/calendarService.js';

const SCHOOL_A = 13;
const SCHOOL_B = 14;

test('Multi-Tenant Isolation: cross-school fetch isolation', async () => {
  let eventA = null;
  let eventB = null;

  try {
    // 1. Create event in School A
    eventA = await CalendarService.createEvent({
      schoolId: SCHOOL_A,
      data: {
        title: 'School A Annual Sports Day',
        event_type: 'SPORTS',
        start_date: '2026-12-01',
        end_date: '2026-12-01',
        status: 'PUBLISHED',
      },
      targets: [{ target_type: 'ENTIRE_SCHOOL', target_id: 'ALL' }],
    });

    // 2. Create event in School B on the exact same date
    eventB = await CalendarService.createEvent({
      schoolId: SCHOOL_B,
      data: {
        title: 'School B Science Exhibition',
        event_type: 'SCHOOL_EVENT',
        start_date: '2026-12-01',
        end_date: '2026-12-01',
        status: 'PUBLISHED',
      },
      targets: [{ target_type: 'ENTIRE_SCHOOL', target_id: 'ALL' }],
    });

    // 3. Query as admin for School A
    const schoolAEvents = await CalendarService.getEventsForUser({
      schoolId: SCHOOL_A,
      user: { roles: ['admin'] },
      startDate: '2026-12-01',
      endDate: '2026-12-01',
    });

    // Verify School A results contain eventA and DO NOT contain eventB
    const hasEventA = schoolAEvents.some((e) => e.id === eventA.id);
    const hasEventBInA = schoolAEvents.some((e) => e.id === eventB.id);
    assert.ok(hasEventA, 'School A calendar contains Event A');
    assert.equal(hasEventBInA, false, 'School A calendar NEVER contains Event B');

    // 4. Query as admin for School B
    const schoolBEvents = await CalendarService.getEventsForUser({
      schoolId: SCHOOL_B,
      user: { roles: ['admin'] },
      startDate: '2026-12-01',
      endDate: '2026-12-01',
    });

    // Verify School B results contain eventB and DO NOT contain eventA
    const hasEventB = schoolBEvents.some((e) => e.id === eventB.id);
    const hasEventAInB = schoolBEvents.some((e) => e.id === eventA.id);
    assert.ok(hasEventB, 'School B calendar contains Event B');
    assert.equal(hasEventAInB, false, 'School B calendar NEVER contains Event A');

    // 5. getEventById isolation: School B cannot fetch Event A by ID
    const crossFetch = await CalendarService.getEventById({
      schoolId: SCHOOL_B,
      eventId: eventA.id,
    });
    assert.equal(crossFetch, null, 'getEventById returns null when school_id does not match event');
  } finally {
    if (eventA) await sql`DELETE FROM calendar_events WHERE id = ${eventA.id}`;
    if (eventB) await sql`DELETE FROM calendar_events WHERE id = ${eventB.id}`;
  }
});

test('Multi-Tenant Isolation: cross-school update and delete rejection', async () => {
  let eventA = null;

  try {
    eventA = await CalendarService.createEvent({
      schoolId: SCHOOL_A,
      data: {
        title: 'School A Confidential Meeting',
        event_type: 'STAFF_MEETING',
        start_date: '2026-12-10',
        end_date: '2026-12-10',
        status: 'PUBLISHED',
      },
      targets: [{ target_type: 'ROLE', target_id: 'staff' }],
    });

    // 1. Attempt update from School B: MUST fail or throw Event not found
    await assert.rejects(
      async () => {
        await CalendarService.updateEvent({
          schoolId: SCHOOL_B,
          eventId: eventA.id,
          data: { title: 'Compromised Title' },
        });
      },
      { message: /Event not found/ },
      'School B update on School A event rejected'
    );

    // 2. Attempt cancel from School B: MUST fail
    await assert.rejects(
      async () => {
        await CalendarService.cancelEvent({
          schoolId: SCHOOL_B,
          eventId: eventA.id,
          reason: 'Unauthorized cancellation',
        });
      },
      { message: /Event not found/ },
      'School B cancellation of School A event rejected'
    );

    // 3. Attempt delete from School B: MUST fail
    await assert.rejects(
      async () => {
        await CalendarService.deleteEvent({
          schoolId: SCHOOL_B,
          eventId: eventA.id,
        });
      },
      { message: /Event not found/ },
      'School B deletion of School A event rejected'
    );

    // Verify eventA in School A remains intact and untampered
    const intact = await CalendarService.getEventById({
      schoolId: SCHOOL_A,
      eventId: eventA.id,
    });
    assert.equal(intact.title, 'School A Confidential Meeting');
    assert.equal(intact.status, 'PUBLISHED');
  } finally {
    if (eventA) await sql`DELETE FROM calendar_events WHERE id = ${eventA.id}`;
  }
});

test('Multi-Tenant Isolation: source entity sync isolation with colliding IDs', async () => {
  const sharedEntityId = 'shared-exam-paper-101';
  let eventA = null;
  let eventB = null;

  try {
    // School A syncs an exam paper
    eventA = await CalendarService.syncSourceEvent({
      schoolId: SCHOOL_A,
      sourceModule: 'EXAM',
      sourceEntityId: sharedEntityId,
      eventData: {
        title: 'School A Physics Exam',
        start_date: '2026-12-15',
        end_date: '2026-12-15',
      },
    });

    // School B syncs an exam paper with the IDENTICAL sourceEntityId
    eventB = await CalendarService.syncSourceEvent({
      schoolId: SCHOOL_B,
      sourceModule: 'EXAM',
      sourceEntityId: sharedEntityId,
      eventData: {
        title: 'School B Chemistry Exam',
        start_date: '2026-12-20',
        end_date: '2026-12-20',
      },
    });

    assert.notEqual(eventA.id, eventB.id, 'Events for different schools have distinct IDs');
    assert.equal(eventA.school_id, SCHOOL_A);
    assert.equal(eventB.school_id, SCHOOL_B);

    // Updating School A does not affect School B
    const updatedA = await CalendarService.syncSourceEvent({
      schoolId: SCHOOL_A,
      sourceModule: 'EXAM',
      sourceEntityId: sharedEntityId,
      eventData: {
        title: 'School A Physics Exam (Rescheduled)',
        start_date: '2026-12-16',
      },
    });
    assert.equal(updatedA.id, eventA.id);

    const checkB = await CalendarService.getEventById({
      schoolId: SCHOOL_B,
      eventId: eventB.id,
    });
    assert.equal(checkB.title, 'School B Chemistry Exam', 'School B event unaffected by School A sync update');
    assert.equal(checkB.start_date, '2026-12-20');

    // Deleting via null in School A does not affect School B
    await CalendarService.syncSourceEvent(SCHOOL_A, 'EXAM', sharedEntityId, null);

    const checkBStillActive = await CalendarService.getEventById({
      schoolId: SCHOOL_B,
      eventId: eventB.id,
    });
    assert.ok(checkBStillActive, 'School B event remains active after School A sync deletion');
  } finally {
    await sql`DELETE FROM calendar_events WHERE source_module = 'EXAM' AND source_entity_id = ${sharedEntityId}`;
  }
});

test('Multi-Tenant Isolation: bulk import cannot assign events to another school', async () => {
  let imported = [];
  try {
    const result = await CalendarService.bulkImportEvents({
      schoolId: SCHOOL_A,
      rows: [
        {
          title: 'Attempted Cross Tenant Holiday',
          start_date: '2026-12-24',
          school_id: SCHOOL_B,
          event_type: 'HOLIDAY',
        },
      ],
    });
    assert.equal(result.failedCount, 1);
    assert.equal(result.importedCount, 0);
    imported = await sql`
      SELECT id, school_id FROM calendar_events
      WHERE title = 'Attempted Cross Tenant Holiday' AND deleted_at IS NULL
    `;
    assert.equal(imported.length, 0);
  } finally {
    await sql`DELETE FROM calendar_events WHERE title = 'Attempted Cross Tenant Holiday'`;
  }
});

test.after(async () => {
  await new Promise((r) => setTimeout(r, 500));
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(0);
});
