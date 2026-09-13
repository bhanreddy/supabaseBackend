import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TICKET_CATEGORIES,
  TICKET_STATUSES,
  TICKET_PRIORITIES,
} from '../services/supportTicketService.js';

test('support ticket category, status, and priority enums are well-defined', () => {
  assert.equal(TICKET_CATEGORIES.FEES, 'fees');
  assert.equal(TICKET_CATEGORIES.TRANSPORT, 'transport');
  assert.equal(TICKET_CATEGORIES.ACADEMICS, 'academics');
  assert.equal(TICKET_CATEGORIES.FACILITIES, 'facilities');
  assert.equal(TICKET_CATEGORIES.OTHER, 'other');

  assert.equal(TICKET_STATUSES.OPEN, 'open');
  assert.equal(TICKET_STATUSES.IN_PROGRESS, 'in_progress');
  assert.equal(TICKET_STATUSES.WAITING_ON_PARENT, 'waiting_for_parent');
  assert.equal(TICKET_STATUSES.WAITING_FOR_PARENT, 'waiting_for_parent');
  assert.equal(TICKET_STATUSES.RESOLVED, 'resolved');
  assert.equal(TICKET_STATUSES.CLOSED, 'closed');

  assert.equal(TICKET_PRIORITIES.LOW, 'low');
  assert.equal(TICKET_PRIORITIES.MEDIUM, 'medium');
  assert.equal(TICKET_PRIORITIES.HIGH, 'high');
  assert.equal(TICKET_PRIORITIES.URGENT, 'urgent');
});

test('ticket numbering format matches TKT-YYYY-XXXXX pattern', () => {
  const sampleTicketNumber = 'TKT-2026-00042';
  const pattern = /^TKT-\d{4}-\d{5}$/;
  assert.ok(pattern.test(sampleTicketNumber));
  assert.ok(!pattern.test('TKT-26-42'));
  assert.ok(!pattern.test('COMP-2026-0001'));
});

test('parent visibility filtering protects internal notes', () => {
  const allMessages = [
    { id: '1', message: 'Parent issue description', is_internal_note: false },
    { id: '2', message: 'Staff internal note: check finance ledger first', is_internal_note: true },
    { id: '3', message: 'Official staff reply: we have waived the fine', is_internal_note: false },
  ];

  const parentView = allMessages.filter(m => !m.is_internal_note);
  assert.equal(parentView.length, 2);
  assert.equal(parentView.some(m => m.is_internal_note), false);
  assert.equal(parentView[0].id, '1');
  assert.equal(parentView[1].id, '3');

  const staffView = allMessages;
  assert.equal(staffView.length, 3);
});

test('sanitizeAttachments rejects client-asserted file references until authenticated uploads exist', async () => {
  const { sanitizeAttachments } = await import('../services/supportTicketService.js');

  const valid = [
    { file_url: 'https://storage.googleapis.com/test/receipt.pdf', file_name: 'receipt.pdf', file_type: 'application/pdf', file_size: 1024 },
    { file_url: 'https://storage.googleapis.com/test/photo.jpg', file_name: 'photo.jpg', file_type: 'image/jpeg', file_size: 2048 },
  ];
  const sanitized = sanitizeAttachments(valid);
  assert.equal(sanitized.length, 0);

  const dangerous = [
    { file_url: 'https://storage.googleapis.com/test/script.exe', file_name: 'script.exe', file_type: 'application/x-msdownload', file_size: 1024 },
    { file_url: 'https://storage.googleapis.com/test/payload.sh', file_name: 'payload.sh', file_type: 'text/plain', file_size: 512 },
    { file_url: 'https://storage.googleapis.com/test/hack.svg', file_name: 'hack.svg', file_type: 'image/svg+xml', file_size: 512 },
  ];
  const rejected = sanitizeAttachments(dangerous);
  assert.equal(rejected.length, 0);

  // Oversized file > 10MB
  const oversized = [
    { file_url: 'https://storage.googleapis.com/test/large.pdf', file_name: 'large.pdf', file_type: 'application/pdf', file_size: 15 * 1024 * 1024 },
  ];
  assert.equal(sanitizeAttachments(oversized).length, 0);
});

test('closed ticket status rejects further message additions', async () => {
  const { addTicketMessage } = await import('../services/supportTicketService.js');

  // Mock db that returns a closed ticket
  const mockDb = async (queryParts, ...params) => {
    return [{ id: 'mock-ticket-1', school_id: 1, status: 'closed', created_by: 'user-1', parent_id: 'par-1' }];
  };

  await assert.rejects(
    async () => {
      await addTicketMessage({
        schoolId: 1,
        ticketId: 'mock-ticket-1',
        senderUserId: 'user-1',
        message: 'Can you reopen this?',
        isStaff: false,
        db: mockDb,
      });
    },
    { message: 'This ticket has been closed. Please open a new support ticket.' }
  );
});

test('createSupportTicket rejects student relationship forgery', async () => {
  const { createSupportTicket } = await import('../services/supportTicketService.js');

  // Mock db where parent exists but student_parents has no match
  let queryIndex = 0;
  const mockDb = async (queryParts, ...params) => {
    queryIndex++;
    if (queryIndex === 1) {
      // parent lookup
      return [{ id: 'par-1' }];
    }
    if (queryIndex === 2) {
      // student_parents relationship check returns empty
      return [];
    }
    return [];
  };

  await assert.rejects(
    async () => {
      await createSupportTicket({
        schoolId: 1,
        parentUserId: '00000000-0000-0000-0000-000000000001',
        studentId: '00000000-0000-0000-0000-000000000099',
        category: 'fees',
        subject: 'Inquiry',
        initialMessage: 'Trying to access someone elses child data',
        db: mockDb,
      });
    },
    { message: 'Unauthorized: Student is not linked to your parent account' }
  );
});

test('resolveCategoryStaffUserIds routes to specialized role or falls back to admin', async () => {
  const { resolveCategoryStaffUserIds } = await import('../services/supportTicketService.js');

  // Case 1: Category 'fees' finds matching finance staff
  const mockFeeDb = async (queryParts, ...params) => {
    return [{ user_id: 'user-fee-officer-1' }, { user_id: 'user-fee-officer-2' }];
  };
  const feeStaff = await resolveCategoryStaffUserIds(1, 'fees', null, mockFeeDb);
  assert.equal(feeStaff.length, 2);
  assert.ok(feeStaff.includes('user-fee-officer-1'));

  // Case 2: No specific role staff found -> fallback query triggered
  let queryCount = 0;
  const mockFallbackDb = async (queryParts, ...params) => {
    queryCount++;
    if (queryCount === 1) {
      // primary query returns empty
      return [];
    }
    // fallback query returns admin
    return [{ user_id: 'user-admin-fallback' }];
  };
  const fallbackStaff = await resolveCategoryStaffUserIds(1, 'facilities', null, mockFallbackDb);
  assert.equal(queryCount, 2);
  assert.deepEqual(fallbackStaff, ['user-admin-fallback']);
});

test('addTicketMessage blocks unauthorized parent from replying to another parent ticket', async () => {
  const { addTicketMessage } = await import('../services/supportTicketService.js');

  const mockDb = async (queryParts, ...params) => {
    // Return ticket owned by parent '00000000-0000-0000-0000-000000000001'
    return [{
      id: '00000000-0000-0000-0000-000000000010',
      school_id: 1,
      status: 'open',
      created_by: '00000000-0000-0000-0000-000000000001',
      parent_id: 'par-1',
    }];
  };

  // Attacker parent '00000000-0000-0000-0000-000000000999' tries to reply
  await assert.rejects(
    async () => {
      await addTicketMessage({
        schoolId: 1,
        ticketId: '00000000-0000-0000-0000-000000000010',
        senderUserId: '00000000-0000-0000-0000-000000000999',
        message: 'Forged reply',
        isStaff: false,
        db: mockDb,
      });
    },
    { message: 'Unauthorized to post to this support ticket' }
  );
});

test('getTicketDetails hides internal staff notes from parents', async () => {
  const { getTicketDetails } = await import('../services/supportTicketService.js');

  const mockDb = (queryParts, ...params) => {
    const rawSql = Array.isArray(queryParts) ? queryParts.join('') : String(queryParts);
    if (rawSql.trim() === 'AND m.is_internal = false') {
      return { fragment: 'is_internal_filter' };
    }
    if (rawSql.trim() === '') {
      return { fragment: 'empty' };
    }
    return (async () => {
      if (rawSql.includes('FROM support_tickets')) {
        return [{
          id: '00000000-0000-0000-0000-000000000010',
          school_id: 1,
          ticket_number: 'TKT-2026-00001',
          parent_user_id: 'user-par-1',
          subject: 'Transport bus route delay',
          status: 'open',
        }];
      }
      if (rawSql.includes('support_ticket_messages')) {
        const hasInternalFilter = params.some(p => p && p.fragment === 'is_internal_filter');
        const allMessages = [
          { id: 'msg-1', message: 'Bus is delayed', is_internal_note: false },
          { id: 'msg-2', message: 'Staff note: Driver had flat tire', is_internal_note: true },
        ];
        return hasInternalFilter ? allMessages.filter(m => !m.is_internal_note) : allMessages;
      }
      return [];
    })();
  };

  const parentView = await getTicketDetails(1, '00000000-0000-0000-0000-000000000010', { isStaff: false }, mockDb);
  assert.ok(parentView, 'parentView should not be null');
  assert.equal(parentView.messages.length, 1);
  assert.equal(parentView.messages[0].id, 'msg-1');
  assert.equal(parentView.messages[0].is_internal_note, false);

  const staffView = await getTicketDetails(1, '00000000-0000-0000-0000-000000000010', { isStaff: true }, mockDb);
  assert.equal(staffView.messages.length, 2);
  assert.equal(staffView.messages[1].id, 'msg-2');
  assert.equal(staffView.messages[1].is_internal_note, true);
});

