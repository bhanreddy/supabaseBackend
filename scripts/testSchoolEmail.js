/**
 * Unit checks for school email helpers (no DB required).
 * Usage: node scripts/testSchoolEmail.js
 */

import assert from 'node:assert/strict';
import {
  normalizeEmail,
  createSchoolScopedAuthUser,
  updateSchoolScopedAuthEmail
} from '../utils/schoolEmail.js';

assert.equal(normalizeEmail('  Staff@Samskruthe.COM '), 'staff@samskruthe.com');

let capturedCreatePayload;
const mockSupabaseAdmin = {
  auth: {
    admin: {
      createUser: async (payload) => {
        capturedCreatePayload = payload;
        return {
          data: { user: { id: 'user-1', email: payload.email } },
          error: null
        };
      },
      getUserById: async () => ({
        data: { user: { user_metadata: { person_id: 'p-1' } } }
      }),
      updateUserById: async (_userId, payload) => ({
        data: { user: { id: 'user-1', email: payload.email } },
        error: null
      })
    }
  }
};

await createSchoolScopedAuthUser(mockSupabaseAdmin, {
  schoolId: 13,
  email: 'staff@samskruthe.com',
  password: 'Password123',
  userMetadata: { person_id: 'p-1' }
});

assert.equal(capturedCreatePayload.email, 'staff@samskruthe.com');
assert.notEqual(capturedCreatePayload.email.includes('+school-'), true);
assert.equal(capturedCreatePayload.user_metadata.canonical_email, 'staff@samskruthe.com');
assert.equal(capturedCreatePayload.user_metadata.school_id, '13');

const updateResult = await updateSchoolScopedAuthEmail(mockSupabaseAdmin, 'user-1', {
  schoolId: 13,
  email: 'Staff@Samskruthe.com'
});
assert.equal(updateResult.canonicalEmail, 'staff@samskruthe.com');

console.log('schoolEmail tests passed');
