const SCHOOL_EMAIL_CONSTRAINTS = new Set([
  'person_contacts_school_email_unique',
  'users_school_email_unique',
  'parents_school_email_unique',
  'staff_school_email_unique'
]);

export class SchoolEmailConflictError extends Error {
  constructor(message = 'Email already registered in this school') {
    super(message);
    this.name = 'SchoolEmailConflictError';
    this.statusCode = 409;
    this.code = 'SCHOOL_EMAIL_CONFLICT';
    this.constraint = 'person_contacts_school_email_unique';
  }
}

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function isSchoolEmailConflict(error) {
  const constraintName = error?.constraint || error?.constraint_name;
  return (
    error instanceof SchoolEmailConflictError ||
    (error?.code === '23505' && SCHOOL_EMAIL_CONSTRAINTS.has(constraintName))
  );
}

function isAuthEmailExistsError(error) {
  return (
    error?.code === 'email_exists' ||
    /already (been )?registered|already exists/i.test(error?.message || '')
  );
}

export function sendSchoolEmailConflict(res, error) {
  if (!isSchoolEmailConflict(error)) return false;

  console.warn('School-scoped email uniqueness violation', {
    constraint: error.constraint || error.constraint_name || error.code || 'SCHOOL_EMAIL_CONFLICT'
  });

  res.status(409).json({ error: 'Email already registered in this school' });
  return true;
}

export async function assertSchoolEmailAvailable(sql, schoolId, email, excludePersonId = null) {
  const normalized = normalizeEmail(email);
  if (!normalized) return normalized;

  const rows = excludePersonId
    ? await sql`
        SELECT id
        FROM person_contacts
        WHERE school_id = ${schoolId}
          AND contact_type = 'email'
          AND lower(contact_value) = ${normalized}
          AND person_id <> ${excludePersonId}
          AND deleted_at IS NULL
        LIMIT 1
      `
    : await sql`
        SELECT id
        FROM person_contacts
        WHERE school_id = ${schoolId}
          AND contact_type = 'email'
          AND lower(contact_value) = ${normalized}
          AND deleted_at IS NULL
        LIMIT 1
      `;

  if (rows.length > 0) {
    throw new SchoolEmailConflictError();
  }

  return normalized;
}

export async function createSchoolScopedAuthUser(supabaseAdmin, {
  schoolId,
  email,
  password,
  userMetadata = {}
}) {
  const canonicalEmail = normalizeEmail(email);

  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email: canonicalEmail,
    password,
    email_confirm: true,
    user_metadata: {
      ...userMetadata,
      canonical_email: canonicalEmail,
      school_id: String(schoolId)
    }
  });

  if (error) {
    if (isAuthEmailExistsError(error)) {
      throw new SchoolEmailConflictError();
    }
    throw error;
  }

  return { data, canonicalEmail };
}

export async function updateSchoolScopedAuthEmail(supabaseAdmin, userId, { schoolId, email }) {
  const canonicalEmail = normalizeEmail(email);
  const { data: currentUser } = await supabaseAdmin.auth.admin.getUserById(userId);

  const { data, error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
    email: canonicalEmail,
    user_metadata: {
      ...(currentUser?.user?.user_metadata || {}),
      canonical_email: canonicalEmail,
      school_id: String(schoolId)
    }
  });

  if (error) {
    if (isAuthEmailExistsError(error)) {
      throw new SchoolEmailConflictError();
    }
    throw error;
  }

  return { data, canonicalEmail };
}
