import sql from '../../db.js';

export const DEFAULT_CELEBRATION_SETTINGS = {
  is_enabled: true,
  student_birthday_enabled: true,
  staff_birthday_enabled: true,
  birthday_music_enabled: true,
  student_template: 'Happy Birthday, {{first_name}}! 🎉\nWishing you joy, success, and a wonderful year ahead.',
  staff_template: 'Celebrating {{full_name}}! 🎂\nHave a fantastic birthday from everyone at {{school_name}}!',
  student_visibility: 'class', // 'self_only' | 'class' | 'school'
  staff_visibility: 'staff',   // 'staff' | 'school'
  show_student_photo: true,
  show_staff_photo: true,
  show_class: true,
  show_section: true,
  show_staff_designation: true,
};

/**
 * Retrieves celebration settings for a school, filling missing fields with defaults.
 * @param {number} schoolId
 * @returns {Promise<typeof DEFAULT_CELEBRATION_SETTINGS & { school_id: number }>}
 */
export async function getCelebrationSettings(schoolId) {
  try {
    const [row] = await sql`
      SELECT
        school_id,
        is_enabled,
        student_birthday_enabled,
        staff_birthday_enabled,
        birthday_music_enabled,
        student_template,
        staff_template,
        student_visibility,
        staff_visibility,
        show_student_photo,
        show_staff_photo,
        show_class,
        show_section,
        show_staff_designation,
        created_at,
        updated_at
      FROM school_celebration_settings
      WHERE school_id = ${schoolId}
      LIMIT 1
    `;

    if (!row) {
      return {
        school_id: schoolId,
        ...DEFAULT_CELEBRATION_SETTINGS,
      };
    }

    return {
      school_id: row.school_id,
      is_enabled: Boolean(row.is_enabled),
      student_birthday_enabled: Boolean(row.student_birthday_enabled),
      staff_birthday_enabled: Boolean(row.staff_birthday_enabled),
      birthday_music_enabled: Boolean(row.birthday_music_enabled),
      student_template: row.student_template || DEFAULT_CELEBRATION_SETTINGS.student_template,
      staff_template: row.staff_template || DEFAULT_CELEBRATION_SETTINGS.staff_template,
      student_visibility: row.student_visibility || DEFAULT_CELEBRATION_SETTINGS.student_visibility,
      staff_visibility: row.staff_visibility || DEFAULT_CELEBRATION_SETTINGS.staff_visibility,
      show_student_photo: Boolean(row.show_student_photo),
      show_staff_photo: Boolean(row.show_staff_photo),
      show_class: Boolean(row.show_class),
      show_section: Boolean(row.show_section),
      show_staff_designation: Boolean(row.show_staff_designation),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  } catch (error) {
    // If table doesn't exist yet or DB issue, fail open with safe defaults
    return {
      school_id: schoolId,
      ...DEFAULT_CELEBRATION_SETTINGS,
    };
  }
}

/**
 * Updates celebration settings for a school.
 * @param {number} schoolId
 * @param {Partial<typeof DEFAULT_CELEBRATION_SETTINGS>} patch
 * @returns {Promise<object>}
 */
export async function updateCelebrationSettings(schoolId, patch = {}) {
  const current = await getCelebrationSettings(schoolId);

  const isEnabled = typeof patch.is_enabled === 'boolean' ? patch.is_enabled : current.is_enabled;
  const studentBirthdayEnabled = typeof patch.student_birthday_enabled === 'boolean' ? patch.student_birthday_enabled : current.student_birthday_enabled;
  const staffBirthdayEnabled = typeof patch.staff_birthday_enabled === 'boolean' ? patch.staff_birthday_enabled : current.staff_birthday_enabled;
  const birthdayMusicEnabled = typeof patch.birthday_music_enabled === 'boolean' ? patch.birthday_music_enabled : current.birthday_music_enabled;
  const studentTemplate = typeof patch.student_template === 'string' && patch.student_template.trim() ? patch.student_template.trim() : current.student_template;
  const staffTemplate = typeof patch.staff_template === 'string' && patch.staff_template.trim() ? patch.staff_template.trim() : current.staff_template;

  const validStudentVisibilities = ['self_only', 'class', 'school'];
  const validStaffVisibilities = ['staff', 'school'];

  const studentVisibility = validStudentVisibilities.includes(patch.student_visibility)
    ? patch.student_visibility
    : current.student_visibility;
  const staffVisibility = validStaffVisibilities.includes(patch.staff_visibility)
    ? patch.staff_visibility
    : current.staff_visibility;

  const showStudentPhoto = typeof patch.show_student_photo === 'boolean' ? patch.show_student_photo : current.show_student_photo;
  const showStaffPhoto = typeof patch.show_staff_photo === 'boolean' ? patch.show_staff_photo : current.show_staff_photo;
  const showClass = typeof patch.show_class === 'boolean' ? patch.show_class : current.show_class;
  const showSection = typeof patch.show_section === 'boolean' ? patch.show_section : current.show_section;
  const showStaffDesignation = typeof patch.show_staff_designation === 'boolean' ? patch.show_staff_designation : current.show_staff_designation;

  const [row] = await sql`
    INSERT INTO school_celebration_settings (
      school_id,
      is_enabled,
      student_birthday_enabled,
      staff_birthday_enabled,
      birthday_music_enabled,
      student_template,
      staff_template,
      student_visibility,
      staff_visibility,
      show_student_photo,
      show_staff_photo,
      show_class,
      show_section,
      show_staff_designation,
      updated_at
    )
    VALUES (
      ${schoolId},
      ${isEnabled},
      ${studentBirthdayEnabled},
      ${staffBirthdayEnabled},
      ${birthdayMusicEnabled},
      ${studentTemplate},
      ${staffTemplate},
      ${studentVisibility},
      ${staffVisibility},
      ${showStudentPhoto},
      ${showStaffPhoto},
      ${showClass},
      ${showSection},
      ${showStaffDesignation},
      NOW()
    )
    ON CONFLICT (school_id) DO UPDATE SET
      is_enabled = EXCLUDED.is_enabled,
      student_birthday_enabled = EXCLUDED.student_birthday_enabled,
      staff_birthday_enabled = EXCLUDED.staff_birthday_enabled,
      birthday_music_enabled = EXCLUDED.birthday_music_enabled,
      student_template = EXCLUDED.student_template,
      staff_template = EXCLUDED.staff_template,
      student_visibility = EXCLUDED.student_visibility,
      staff_visibility = EXCLUDED.staff_visibility,
      show_student_photo = EXCLUDED.show_student_photo,
      show_staff_photo = EXCLUDED.show_staff_photo,
      show_class = EXCLUDED.show_class,
      show_section = EXCLUDED.show_section,
      show_staff_designation = EXCLUDED.show_staff_designation,
      updated_at = NOW()
    RETURNING *
  `;

  return row;
}
