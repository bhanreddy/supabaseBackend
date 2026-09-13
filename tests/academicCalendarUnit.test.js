import test from 'node:test';
import assert from 'node:assert/strict';
import sql from '../db.js';
import { formatYMD, getWeekdayName, resolveSchoolDay } from '../services/workingDayResolver.js';
import { CalendarService, expandRecurrenceOccurrences } from '../services/calendarService.js';
import { canonicalizeEventType, canonicalizePriority } from '../services/calendarEventTypes.js';

const TEST_SCHOOL_ID = 13;

test('canonicalizeEventType maps legacy UI aliases to canonical types', () => {
  assert.equal(canonicalizeEventType('HOMEWORK_DUE'), 'HOMEWORK');
  assert.equal(canonicalizeEventType('MEETING'), 'PTM');
  assert.equal(canonicalizeEventType('ACTIVITY'), 'SCHOOL_EVENT');
  assert.equal(canonicalizePriority('MEDIUM'), 'NORMAL');
});

test('formatYMD and getWeekdayName correctly format dates and weekdays without timezone drift', () => {
  assert.equal(formatYMD('2026-09-15T10:00:00Z'), '2026-09-15');
  assert.equal(formatYMD(new Date('2026-09-15T12:00:00Z')), '2026-09-15');
  assert.equal(formatYMD('2026-10-02'), '2026-10-02');
  assert.equal(formatYMD(null), null);

  assert.equal(getWeekdayName('2026-09-13'), 'sunday');
  assert.equal(getWeekdayName('2026-09-14'), 'monday');
  assert.equal(getWeekdayName('2026-09-19'), 'saturday');
});

test('expandRecurrenceOccurrences correctly expands weekly recurrence with exceptions', () => {
  const masterEvent = {
    id: 'evt-rec-weekly-01',
    title: 'Weekly Math Club',
    start_date: '2026-10-01',
    end_date: '2026-10-01',
    start_datetime: '2026-10-01T15:00:00Z',
    end_datetime: '2026-10-01T16:00:00Z',
    recurrence_rule: {
      frequency: 'WEEKLY',
      interval: 1,
      days_of_week: ['monday', 'wednesday'],
      until: '2026-10-31',
      exceptions: ['2026-10-14'], // Skip Wednesday Oct 14
    },
  };

  const occurrences = expandRecurrenceOccurrences(masterEvent, '2026-10-01', '2026-10-20');

  // October 2026:
  // Mon Oct 5, Wed Oct 7, Mon Oct 12, (Wed Oct 14 skipped), Mon Oct 19
  const occDates = occurrences.map((o) => o.start_date);
  assert.ok(occDates.includes('2026-10-05'), 'Mon Oct 5 included');
  assert.ok(occDates.includes('2026-10-07'), 'Wed Oct 7 included');
  assert.ok(occDates.includes('2026-10-12'), 'Mon Oct 12 included');
  assert.ok(!occDates.includes('2026-10-14'), 'Wed Oct 14 skipped via exceptions');
  assert.ok(occDates.includes('2026-10-19'), 'Mon Oct 19 included');

  // Verify fields on generated occurrence
  const sample = occurrences.find((o) => o.start_date === '2026-10-05');
  assert.equal(sample.master_event_id, masterEvent.id);
  assert.equal(sample.is_recurring_instance, true);
  assert.equal(sample.start_datetime, '2026-10-05T15:00:00.000Z');
});

test('expandRecurrenceOccurrences correctly expands second Saturday recurrence rule', () => {
  const masterEvent = {
    id: 'evt-second-sat-01',
    title: 'Monthly PTA Meeting',
    start_date: '2026-09-01',
    end_date: '2026-09-01',
    recurrence_rule: {
      frequency: 'MONTHLY',
      by_set_pos: 2,
      days_of_week: ['saturday'],
      until: '2026-12-31',
    },
  };

  // Sep 2026 second Saturday is Sep 12 (first sat: Sep 5, second sat: Sep 12)
  // Oct 2026 second Saturday is Oct 10 (first sat: Oct 3, second sat: Oct 10)
  const occurrences = expandRecurrenceOccurrences(masterEvent, '2026-09-01', '2026-10-31');
  const dates = occurrences.map((o) => o.start_date);

  assert.ok(dates.includes('2026-09-12'), 'Second Saturday of September included');
  assert.ok(dates.includes('2026-10-10'), 'Second Saturday of October included');
  assert.ok(!dates.includes('2026-09-05'), 'First Saturday of September excluded');
  assert.ok(!dates.includes('2026-10-03'), 'First Saturday of October excluded');
});

test('resolveSchoolDay evaluates regular weekdays and Sundays accurately', async () => {
  // Wednesday 2026-11-18 (standard weekday)
  const wednesday = await resolveSchoolDay(TEST_SCHOOL_ID, '2026-11-18');
  assert.equal(wednesday.date, '2026-11-18');
  assert.equal(wednesday.dayOfWeek, 'wednesday');
  assert.equal(wednesday.isWorkingDay, true);
  assert.equal(wednesday.isHoliday, false);
  assert.equal(wednesday.attendanceAllowed, true);

  // Sunday 2026-11-22 (Sunday weekly off)
  const sunday = await resolveSchoolDay(TEST_SCHOOL_ID, '2026-11-22');
  assert.equal(sunday.date, '2026-11-22');
  assert.equal(sunday.dayOfWeek, 'sunday');
  assert.equal(sunday.isWorkingDay, false);
  assert.equal(sunday.isHoliday, false);
  assert.equal(sunday.attendanceAllowed, false);
});

test('resolveSchoolDay respects holiday override disabling attendance', async () => {
  await sql.begin(async (tx) => {
    // Insert a test public holiday
    const [holiday] = await tx`
      INSERT INTO calendar_events (
        school_id, title, event_type, holiday_type, start_date, end_date,
        start_datetime, end_datetime, status, attendance_enabled
      ) VALUES (
        ${TEST_SCHOOL_ID}, 'Test Diwali Holiday', 'HOLIDAY', 'PUBLIC_HOLIDAY',
        '2026-11-09', '2026-11-09', '2026-11-09T00:00:00Z', '2026-11-09T23:59:59Z',
        'PUBLISHED', false
      ) RETURNING *
    `;

    // Test inside transaction with tx client
    const day = await resolveSchoolDay(TEST_SCHOOL_ID, '2026-11-09', tx);
    assert.equal(day.isHoliday, true);
    assert.equal(day.attendanceAllowed, false);
    assert.equal(day.isWorkingDay, false);
    assert.equal(day.holidayId, holiday.id);
    assert.ok(day.reason.includes('Diwali'));

    // Rollback so no permanent test data is written
    throw new Error('ROLLBACK_TEST_TX');
  }).catch((e) => {
    if (e.message !== 'ROLLBACK_TEST_TX') throw e;
  });
});

test('resolveSchoolDay respects Special Working Day overriding Sunday and copying timetable', async () => {
  await sql.begin(async (tx) => {
    // Sunday Nov 15 marked as Special Working Day with Monday timetable
    const [special] = await tx`
      INSERT INTO calendar_events (
        school_id, title, event_type, start_date, end_date,
        start_datetime, end_datetime, status, copy_timetable_from_day, attendance_enabled
      ) VALUES (
        ${TEST_SCHOOL_ID}, 'Sunday Compensatory Day', 'SPECIAL_WORKING_DAY',
        '2026-11-15', '2026-11-15', '2026-11-15T00:00:00Z', '2026-11-15T23:59:59Z',
        'PUBLISHED', 'monday', true
      ) RETURNING *
    `;

    const day = await resolveSchoolDay(TEST_SCHOOL_ID, '2026-11-15', tx);
    assert.equal(day.isWorkingDay, true);
    assert.equal(day.isSpecialWorkingDay, true);
    assert.equal(day.specialWorkingDayId, special.id);
    assert.equal(day.attendanceAllowed, true);
    assert.equal(day.timetableOverride, 'monday');
    assert.equal(day.timetableDay, 'monday');

    throw new Error('ROLLBACK_TEST_TX');
  }).catch((e) => {
    if (e.message !== 'ROLLBACK_TEST_TX') throw e;
  });
});

test('checkConflicts identifies location collisions and holiday overlaps', async () => {
  await sql.begin(async (tx) => {
    // 1. Insert published holiday on Dec 25
    await tx`
      INSERT INTO calendar_events (
        school_id, title, event_type, start_date, end_date,
        start_datetime, end_datetime, status, attendance_enabled
      ) VALUES (
        ${TEST_SCHOOL_ID}, 'Christmas Holiday', 'HOLIDAY',
        '2026-12-25', '2026-12-25', '2026-12-25T00:00:00Z', '2026-12-25T23:59:59Z',
        'PUBLISHED', false
      )
    `;

    // 2. Insert booked location in Main Auditorium on Dec 20
    await tx`
      INSERT INTO calendar_events (
        school_id, title, event_type, start_date, end_date,
        start_datetime, end_datetime, location, status
      ) VALUES (
        ${TEST_SCHOOL_ID}, 'Rehearsal', 'SCHOOL_EVENT',
        '2026-12-20', '2026-12-20', '2026-12-20T10:00:00Z', '2026-12-20T12:00:00Z',
        'Main Auditorium', 'PUBLISHED'
      )
    `;

    // Test A: Exam scheduled on Christmas holiday should flag conflict
    const holidayClash = await CalendarService.checkConflicts({
      schoolId: TEST_SCHOOL_ID,
      eventData: {
        event_type: 'EXAM',
        start_date: '2026-12-25',
        end_date: '2026-12-25',
      },
      dbClient: tx,
    });
    assert.equal(holidayClash.hasConflict, true);
    assert.ok(holidayClash.conflicts.some((c) => c.type === 'HOLIDAY_OVERLAP'));

    // Test B: Another event in Main Auditorium at 11:00 AM on Dec 20 should flag collision
    const locClash = await CalendarService.checkConflicts({
      schoolId: TEST_SCHOOL_ID,
      eventData: {
        event_type: 'SCHOOL_EVENT',
        start_date: '2026-12-20',
        end_date: '2026-12-20',
        start_datetime: '2026-12-20T11:00:00Z',
        end_datetime: '2026-12-20T13:00:00Z',
        location: 'Main Auditorium',
      },
      dbClient: tx,
    });
    assert.equal(locClash.hasConflict, true);
    assert.ok(locClash.conflicts.some((c) => c.type === 'LOCATION_DOUBLE_BOOKING'));

    throw new Error('ROLLBACK_TEST_TX');
  }).catch((e) => {
    if (e.message !== 'ROLLBACK_TEST_TX') throw e;
  });
});

test('generateIcsForEvent and generateIcsFeed generate valid RFC 5545 format', () => {
  const event = {
    id: '123e4567-e89b-12d3-a456-426614174000',
    title: 'Annual Sports Meet',
    description: 'Track and field events for all classes',
    location: 'School Ground',
    start_date: '2026-11-20',
    end_date: '2026-11-20',
    is_all_day: true,
    status: 'PUBLISHED',
  };

  const ics = CalendarService.generateIcsForEvent(event);
  assert.ok(ics.includes('BEGIN:VCALENDAR'), 'Contains BEGIN:VCALENDAR');
  assert.ok(ics.includes('BEGIN:VEVENT'), 'Contains BEGIN:VEVENT');
  assert.ok(ics.includes('SUMMARY:Annual Sports Meet'), 'Contains escaped summary');
  assert.ok(ics.includes('LOCATION:School Ground'), 'Contains location');
  assert.ok(ics.includes('DTSTART;VALUE=DATE:20261120'), 'Contains all-day start date');
  assert.ok(ics.includes('END:VCALENDAR'), 'Contains END:VCALENDAR');

  const feed = CalendarService.generateIcsFeed([event]);
  assert.ok(feed.includes('X-WR-CALNAME:SchoolIMS Academic Calendar'), 'Contains calendar name header');
  assert.ok(feed.includes('END:VCALENDAR'), 'Contains closing tag');
});

test.after(async () => {
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(0);
});
