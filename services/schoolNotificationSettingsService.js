import sql from '../db.js';

const SETTINGS_PREFIX = 'notification_enabled_';

/**
 * School-level notification controls. Event keys stay granular internally,
 * while related events share one understandable admin switch (for example,
 * both present and absent alerts are controlled by Attendance).
 */
export const SCHOOL_NOTIFICATION_CATEGORIES = Object.freeze([
  { id: 'attendance', label: 'Attendance', description: 'Present, absent, and arrival alerts', icon: 'calendar-outline' },
  { id: 'fees', label: 'Fees & payments', description: 'Fee reminders, receipts, adjustments, and arrears', icon: 'wallet-outline' },
  { id: 'diary', label: 'Diary & homework', description: 'Daily diary and homework updates', icon: 'book-outline' },
  { id: 'results', label: 'Exam results', description: 'Published examination results', icon: 'trophy-outline' },
  { id: 'learning', label: 'Study material', description: 'LMS and learning-content updates', icon: 'school-outline' },
  { id: 'timetable', label: 'Timetable', description: 'Class timetable changes', icon: 'time-outline' },
  { id: 'notices', label: 'School notices', description: 'Administrative notices and announcements', icon: 'megaphone-outline' },
  { id: 'complaints', label: 'Complaints', description: 'New complaints and responses', icon: 'chatbox-ellipses-outline' },
  { id: 'leave', label: 'Leave requests', description: 'Leave submissions, approvals, and rejections', icon: 'airplane-outline' },
  { id: 'expenses', label: 'Expenses', description: 'Expense submissions and decisions', icon: 'receipt-outline' },
  { id: 'payroll', label: 'Payroll', description: 'Salary and payroll updates', icon: 'cash-outline' },
  { id: 'access', label: 'Access requests', description: 'Access approval and rejection updates', icon: 'key-outline' },
  { id: 'transport', label: 'School transport', description: 'Bus trips, stops, delays, and bus attendance', icon: 'bus-outline' },
  { id: 'messages', label: 'Messages', description: 'Direct messages between school and families', icon: 'mail-outline' },
]);

const CATEGORY_IDS = new Set(SCHOOL_NOTIFICATION_CATEGORIES.map((category) => category.id));

export function notificationCategoryForEvent(eventType = '') {
  if (eventType.startsWith('ATTENDANCE_')) return 'attendance';
  if (eventType.startsWith('FEE_') || eventType === 'ARREARS_REMINDER') return 'fees';
  if (eventType.startsWith('DIARY_')) return 'diary';
  if (eventType.startsWith('RESULT_')) return 'results';
  if (eventType.startsWith('LMS_')) return 'learning';
  if (eventType.startsWith('TIMETABLE_')) return 'timetable';
  if (eventType.startsWith('NOTICE_')) return 'notices';
  if (eventType.startsWith('COMPLAINT_')) return 'complaints';
  if (eventType.startsWith('LEAVE_')) return 'leave';
  if (eventType.startsWith('EXPENSE_')) return 'expenses';
  if (eventType.startsWith('PAYROLL_')) return 'payroll';
  if (eventType.startsWith('ACCESS_')) return 'access';
  if (
    eventType.startsWith('BUS_') ||
    eventType.startsWith('TRANSPORT_') ||
    eventType.startsWith('STUDENT_BUS_')
  ) return 'transport';
  if (eventType.startsWith('MESSAGE_')) return 'messages';
  return null;
}

export function notificationSettingKey(categoryId) {
  if (!CATEGORY_IDS.has(categoryId)) throw new Error(`Unknown notification category: ${categoryId}`);
  return `${SETTINGS_PREFIX}${categoryId}`;
}

function parseEnabled(value) {
  return !['false', '0', 'off', 'disabled'].includes(String(value ?? 'true').trim().toLowerCase());
}

export async function getSchoolNotificationSettings(schoolId, db = sql) {
  const keys = SCHOOL_NOTIFICATION_CATEGORIES.map((category) => notificationSettingKey(category.id));
  const rows = await db`
    SELECT key, value
    FROM school_settings
    WHERE school_id = ${schoolId}
      AND key = ANY(${keys})
  `;
  const values = new Map(rows.map((row) => [row.key, row.value]));

  return SCHOOL_NOTIFICATION_CATEGORIES.map((category) => ({
    ...category,
    enabled: parseEnabled(values.get(notificationSettingKey(category.id))),
  }));
}

export async function setSchoolNotificationSetting(schoolId, categoryId, enabled, db = sql) {
  const key = notificationSettingKey(categoryId);
  await db`
    INSERT INTO school_settings (school_id, key, value, updated_at)
    VALUES (${schoolId}, ${key}, ${enabled ? 'true' : 'false'}, now())
    ON CONFLICT (school_id, key)
    DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `;
  return getSchoolNotificationSettings(schoolId, db);
}

/**
 * Filter intended recipients against their own school's master category switch.
 * Defaults are deliberately ON so this feature is backward-compatible.
 */
export async function filterEnabledNotificationRecipients(userIds, eventType, db = sql) {
  const ids = [...new Set((userIds || []).filter(Boolean).map(String))];
  const categoryId = notificationCategoryForEvent(eventType);
  if (ids.length === 0 || !categoryId) {
    return { enabledUserIds: ids, disabledUserIds: [], categoryId };
  }

  const key = notificationSettingKey(categoryId);
  const rows = await db`
    SELECT u.id, setting.value
    FROM users u
    LEFT JOIN school_settings setting
      ON setting.school_id = u.school_id
     AND setting.key = ${key}
    WHERE u.id = ANY(${ids})
      AND u.deleted_at IS NULL
  `;
  const enabledSet = new Set(rows.filter((row) => parseEnabled(row.value)).map((row) => String(row.id)));
  const enabledUserIds = ids.filter((id) => enabledSet.has(id));
  const disabledUserIds = ids.filter((id) => !enabledSet.has(id));
  return { enabledUserIds, disabledUserIds, categoryId };
}
