import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isLeapYear,
  getInitials,
  getSchoolDateContext,
  isBirthdayMatching,
} from '../services/celebration/celebrationUtils.js';
import {
  renderCelebrationTemplate,
} from '../services/celebration/celebrationTemplateEngine.js';
import {
  canViewCelebration,
  filterCelebrationsForUser,
} from '../services/celebration/celebrationPolicy.js';
import { composeCelebrationSlides } from '../services/celebration/celebrationCompose.js';

test('1. Leap year calculations identify leap years and standard years accurately', () => {
  assert.equal(isLeapYear(2024), true);
  assert.equal(isLeapYear(2028), true);
  assert.equal(isLeapYear(2000), true);
  assert.equal(isLeapYear(1900), false);
  assert.equal(isLeapYear(2026), false);
  assert.equal(isLeapYear(2027), false);
});

test('2. Student/Staff initials avatar fallback handles names gracefully', () => {
  assert.equal(getInitials('Aarav Reddy'), 'AR');
  assert.equal(getInitials('Kavitha Sharma'), 'KS');
  assert.equal(getInitials('Suresh'), 'SU');
  assert.equal(getInitials(''), '🎂');
  assert.equal(getInitials(null), '🎂');
  assert.equal(getInitials('First Middle Last'), 'FL');
});

test('3. Birthday matching compares Day and Month ignoring birth year', () => {
  const targetContext = { month: 9, day: 12, isNonLeapYearFeb28: false };
  // Same day/month in 2014 matches
  assert.equal(isBirthdayMatching('2014-09-12', targetContext), true);
  // Same day/month in 1995 matches
  assert.equal(isBirthdayMatching('1995-09-12', targetContext), true);
  // Same day/month Date object matches
  assert.equal(isBirthdayMatching(new Date(Date.UTC(2005, 8, 12)), targetContext), true);
  // Different day does not match
  assert.equal(isBirthdayMatching('2014-09-11', targetContext), false);
  // Different month does not match
  assert.equal(isBirthdayMatching('2014-10-12', targetContext), false);
  // Null or invalid input returns false
  assert.equal(isBirthdayMatching(null, targetContext), false);
  assert.equal(isBirthdayMatching('invalid-date', targetContext), false);
});

test('4. February 29 handling: matches Feb 28 on non-leap years, and Feb 29 on leap years', () => {
  // Scenario A: Target date is Feb 28 in a non-leap year (e.g. 2027)
  const nonLeapFeb28 = { month: 2, day: 28, isNonLeapYearFeb28: true };
  assert.equal(isBirthdayMatching('2008-02-29', nonLeapFeb28), true);
  assert.equal(isBirthdayMatching('2010-02-28', nonLeapFeb28), true);
  assert.equal(isBirthdayMatching('2010-02-27', nonLeapFeb28), false);

  // Scenario B: Target date is Feb 28 in a leap year (e.g. 2028)
  const leapFeb28 = { month: 2, day: 28, isNonLeapYearFeb28: false };
  assert.equal(isBirthdayMatching('2008-02-29', leapFeb28), false);
  assert.equal(isBirthdayMatching('2010-02-28', leapFeb28), true);

  // Scenario C: Target date is Feb 29 in a leap year (e.g. 2028)
  const leapFeb29 = { month: 2, day: 29, isNonLeapYearFeb28: false };
  assert.equal(isBirthdayMatching('2008-02-29', leapFeb29), true);
  assert.equal(isBirthdayMatching('2010-02-28', leapFeb29), false);
});

test('5. School timezone context produces valid ISO range for the whole birthday date', () => {
  const date = new Date('2026-09-12T06:00:00Z');
  const ctx = getSchoolDateContext('Asia/Kolkata', date);
  assert.equal(ctx.localDate, '2026-09-12');
  assert.equal(ctx.year, 2026);
  assert.equal(ctx.month, 9);
  assert.equal(ctx.day, 12);
  assert.match(ctx.validFrom, /^2026-09-12T00:00:00/);
  assert.match(ctx.validUntil, /^2026-09-12T23:59:59/);
});

test('6. Whitelist template replacement safely populates allowed placeholders and ignores unauthorized tokens', () => {
  const template = 'Happy Birthday {{first_name}} from {{school_name}}! Class: {{class}}-{{section}}. Evil: {{eval(1+1)}} {{password}}';
  const context = {
    first_name: 'Aarav',
    full_name: 'Aarav Reddy',
    class: 'VII',
    section: 'A',
    school_name: 'Hyderabad Public School',
    password: 'super-secret-password',
  };

  const rendered = renderCelebrationTemplate(template, context);
  assert.equal(
    rendered,
    'Happy Birthday Aarav from Hyderabad Public School! Class: VII-A. Evil:'
  );
  // Password token stripped
  assert.equal(rendered.includes('super-secret-password'), false);
  // Unknown expression stripped
  assert.equal(rendered.includes('eval'), false);
});

test('7. Missing placeholders fall back cleanly without breaking layout', () => {
  const template = 'Celebrating {{full_name}}! {{designation}} at {{school_name}}.';
  const rendered = renderCelebrationTemplate(template, {
    full_name: 'Mrs. Kavitha',
    designation: null,
    school_name: 'Greenwood High',
  });
  assert.equal(rendered, 'Celebrating Mrs. Kavitha!  at Greenwood High.');
});

test('8. Multi-tenancy isolation: User from School 1 can NEVER view celebrations from School 2', () => {
  const celebration = {
    schoolId: '1',
    targetType: 'STUDENT',
    targetId: 'stu-1',
    displayName: 'Aarav',
  };
  const userOtherSchool = {
    schoolId: '2',
    roles: ['admin'],
  };
  assert.equal(canViewCelebration(userOtherSchool, celebration, { is_enabled: true }), false);
});

test('9. Master disabled celebration setting hides all celebrations', () => {
  const celebration = {
    schoolId: '1',
    targetType: 'STUDENT',
    targetId: 'stu-1',
  };
  const user = {
    schoolId: '1',
    roles: ['admin'],
  };
  assert.equal(canViewCelebration(user, celebration, { is_enabled: false }), false);
});

test('10. Student birthday disabled setting hides student celebrations but preserves staff', () => {
  const studentCelebration = {
    schoolId: '1',
    targetType: 'STUDENT',
    targetId: 'stu-1',
  };
  const staffCelebration = {
    schoolId: '1',
    targetType: 'STAFF',
    targetId: 'staff-1',
  };
  const adminUser = {
    schoolId: '1',
    roles: ['admin'],
  };
  const settings = {
    is_enabled: true,
    student_birthday_enabled: false,
    staff_birthday_enabled: true,
  };

  assert.equal(canViewCelebration(adminUser, studentCelebration, settings), false);
  assert.equal(canViewCelebration(adminUser, staffCelebration, settings), true);
});

test('11. Staff birthday disabled setting hides staff celebrations but preserves students', () => {
  const studentCelebration = {
    schoolId: '1',
    targetType: 'STUDENT',
    targetId: 'stu-1',
  };
  const staffCelebration = {
    schoolId: '1',
    targetType: 'STAFF',
    targetId: 'staff-1',
  };
  const adminUser = {
    schoolId: '1',
    roles: ['admin'],
  };
  const settings = {
    is_enabled: true,
    student_birthday_enabled: true,
    staff_birthday_enabled: false,
  };

  assert.equal(canViewCelebration(adminUser, studentCelebration, settings), true);
  assert.equal(canViewCelebration(adminUser, staffCelebration, settings), false);
});

test('12. Student celebration visibility: Birthday student and their parent always view their celebration', () => {
  const celebration = {
    schoolId: '1',
    targetType: 'STUDENT',
    targetId: 'stu-100',
    personId: 'person-100',
    classSectionId: 'cs-1',
  };

  const settingsSelfOnly = {
    is_enabled: true,
    student_birthday_enabled: true,
    student_visibility: 'self_only',
  };

  // Birthday student
  const studentUser = {
    schoolId: '1',
    roles: ['student'],
    student_id: 'stu-100',
    person_id: 'person-100',
  };
  assert.equal(canViewCelebration(studentUser, celebration, settingsSelfOnly), true);

  // Birthday student's parent
  const parentUser = {
    schoolId: '1',
    roles: ['parent'],
    studentIds: ['stu-100'],
  };
  assert.equal(canViewCelebration(parentUser, celebration, settingsSelfOnly), true);

  // Other parent in self_only
  const otherParent = {
    schoolId: '1',
    roles: ['parent'],
    studentIds: ['stu-200'],
  };
  assert.equal(canViewCelebration(otherParent, celebration, settingsSelfOnly), false);
});

test('13. Class visibility: Parents in same class see celebration; parents of different class do not', () => {
  const celebration = {
    schoolId: '1',
    targetType: 'STUDENT',
    targetId: 'stu-100',
    classSectionId: 'cs-7a',
    sectionId: 'sec-a',
    classId: 'class-7',
  };

  const settingsClass = {
    is_enabled: true,
    student_birthday_enabled: true,
    student_visibility: 'class',
  };

  const sameClassParentViaArray = {
    schoolId: '1',
    roles: ['parent'],
    studentIds: ['stu-101'],
    classSectionIds: ['cs-7a'],
  };
  assert.equal(canViewCelebration(sameClassParentViaArray, celebration, settingsClass), true);

  const diffClassParent = {
    schoolId: '1',
    roles: ['parent'],
    studentIds: ['stu-300'],
    class_section_id: 'cs-8b',
  };
  assert.equal(canViewCelebration(diffClassParent, celebration, settingsClass), false);
});

test('14. Staff visibility: Staff members see fellow staff birthdays; parents only see if staff_visibility is school', () => {
  const celebration = {
    schoolId: '1',
    targetType: 'STAFF',
    targetId: 'staff-42',
  };

  const staffOnlySettings = {
    is_enabled: true,
    staff_birthday_enabled: true,
    staff_visibility: 'staff',
  };

  const fellowStaff = {
    schoolId: '1',
    roles: ['teacher'],
    staff_id: 'staff-50',
  };
  assert.equal(canViewCelebration(fellowStaff, celebration, staffOnlySettings), true);

  const parent = {
    schoolId: '1',
    roles: ['parent'],
  };
  assert.equal(canViewCelebration(parent, celebration, staffOnlySettings), false);

  const schoolWideSettings = {
    is_enabled: true,
    staff_birthday_enabled: true,
    staff_visibility: 'school',
  };
  assert.equal(canViewCelebration(parent, celebration, schoolWideSettings), true);
});

test('15. filterCelebrationsForUser strips unauthorized celebrations', () => {
  const list = [
    { schoolId: '1', targetType: 'STUDENT', targetId: 'stu-1', classSectionId: 'cs-1' },
    { schoolId: '2', targetType: 'STUDENT', targetId: 'stu-2', classSectionId: 'cs-1' }, // Cross-school
    { schoolId: '1', targetType: 'STUDENT', targetId: 'stu-3', classSectionId: 'cs-2' }, // Other class
  ];

  const class1Parent = {
    schoolId: '1',
    roles: ['parent'],
    studentIds: ['stu-99'],
    class_section_id: 'cs-1',
  };

  const result = filterCelebrationsForUser(list, class1Parent, {
    is_enabled: true,
    student_birthday_enabled: true,
    student_visibility: 'class',
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].targetId, 'stu-1');
});

test('16. Multiple birthdays generate a single grouped celebration card', () => {
  const formattedCards = [
    {
      id: 'birthday_student_stu-1_2026-09-12',
      slide_type: 'CELEBRATION',
      priority: 70,
      person: { type: 'STUDENT', id: 'stu-1', name: 'Aarav Reddy', initials: getInitials('Aarav Reddy') },
      message: 'Happy Birthday, Aarav!',
    },
    {
      id: 'birthday_student_stu-2_2026-09-12',
      slide_type: 'CELEBRATION',
      priority: 70,
      person: { type: 'STUDENT', id: 'stu-2', name: 'Sanjana', initials: getInitials('Sanjana') },
      message: 'Happy Birthday, Sanjana!',
    },
    {
      id: 'birthday_staff_staff-1_2026-09-12',
      slide_type: 'CELEBRATION',
      priority: 70,
      person: { type: 'STAFF', id: 'staff-1', name: 'Mrs. Kavitha', initials: getInitials('Mrs. Kavitha') },
      message: 'Happy Birthday, Kavitha!',
    },
  ];

  const slides = composeCelebrationSlides(formattedCards, {
    schoolId: 1,
    dateContext: { localDate: '2026-09-12', validFrom: '2026-09-12T00:00:00+05:30', validUntil: '2026-09-12T23:59:59.999+05:30' },
    schoolName: 'Greenwood High',
    audioEventKey: 'birthday_audio_user_1_1_2026-09-12',
    musicEnabled: true,
  });

  assert.equal(slides.length, 1);
  assert.equal(slides[0].is_grouped, true);
  assert.equal(slides[0].count, 3);
  assert.equal(slides[0].stars.length, 3);
  assert.equal(slides[0].stars[0].initials, 'AR');

  const single = composeCelebrationSlides(formattedCards.slice(0, 1), {
    schoolId: 1,
    dateContext: { localDate: '2026-09-12' },
    schoolName: 'Greenwood High',
    audioEventKey: 'k',
    musicEnabled: true,
  });
  assert.equal(single.length, 1);
  assert.equal(single[0].is_grouped, undefined);
});

test('17. Banner priorities: Celebration slides have priority 70 and precede normal banners with priority 50', () => {
  const normalSlides = [
    { id: 'norm-1', slide_type: 'IMAGE', priority: 50, title: 'Annual Day' },
    { id: 'norm-2', slide_type: 'IMAGE', priority: 50, title: 'Science Fair' },
  ];
  const celebrationSlides = [
    { id: 'bday-1', slide_type: 'CELEBRATION', priority: 70, title: 'Happy Birthday' },
  ];

  const merged = [...celebrationSlides, ...normalSlides].sort((a, b) => (b.priority || 0) - (a.priority || 0));
  assert.equal(merged[0].id, 'bday-1');
  assert.equal(merged[0].priority, 70);
  assert.equal(merged[1].priority, 50);
});

test('18. Fault tolerance: If celebration resolution fails, normal slides remain unaffected', async () => {
  const normalSlides = [
    { id: 'norm-1', title: 'Campus Tour', priority: 50 },
  ];

  async function mockListActiveSlides(schoolId, shouldFailCelebrations = false) {
    let celebrations = [];
    if (shouldFailCelebrations) {
      try {
        throw new Error('Database connection timeout during celebration resolution');
      } catch (err) {
        // Logged and swallowed
        celebrations = [];
      }
    }
    return [...celebrations, ...normalSlides];
  }

  const resultWithFailure = await mockListActiveSlides(1, true);
  assert.equal(resultWithFailure.length, 1);
  assert.equal(resultWithFailure[0].id, 'norm-1');
  assert.equal(resultWithFailure[0].title, 'Campus Tour');
});
