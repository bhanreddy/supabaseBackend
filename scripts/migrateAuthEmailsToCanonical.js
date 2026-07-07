/**
 * Migrate Supabase Auth emails from +school-{id}-* aliasing back to canonical addresses.
 *
 * Usage:
 *   node scripts/migrateAuthEmailsToCanonical.js           # apply changes
 *   node scripts/migrateAuthEmailsToCanonical.js --dry-run   # preview only
 */

import 'dotenv/config';
import sql, { supabaseAdmin } from '../db.js';
import { normalizeEmail } from '../utils/schoolEmail.js';

const dryRun = process.argv.includes('--dry-run');

function stripSchoolScopedEmailTag(email) {
  const normalized = String(email || '').trim().toLowerCase();
  const atIndex = normalized.lastIndexOf('@');
  if (atIndex <= 0 || atIndex === normalized.length - 1) {
    return normalized;
  }

  const localPart = normalized.slice(0, atIndex);
  const domain = normalized.slice(atIndex + 1);

  const schoolTagIndex = localPart.indexOf('+school-');
  if (schoolTagIndex !== -1) {
    return `${localPart.slice(0, schoolTagIndex)}@${domain}`;
  }

  const compactTagMatch = localPart.match(/^(.+)\+s\d+-/);
  if (compactTagMatch) {
    return `${compactTagMatch[1]}@${domain}`;
  }

  return normalized;
}

function resolveCanonicalEmail(user) {
  const metadataEmail = user.user_metadata?.canonical_email;
  if (metadataEmail) {
    return normalizeEmail(metadataEmail);
  }

  if (user.email?.includes('+school-') || /\+s\d+-/.test(user.email || '')) {
    return normalizeEmail(stripSchoolScopedEmailTag(user.email));
  }

  return normalizeEmail(user.email);
}

function hasSchoolScopedEmailTag(email) {
  return /\+school-|@schoolims\.auth\.local$/i.test(String(email || ''));
}

async function auditPersonContacts() {
  const corrupted = await sql`
    SELECT id, school_id, person_id, contact_value
    FROM person_contacts
    WHERE contact_type = 'email'
      AND deleted_at IS NULL
      AND (
        contact_value LIKE '%+school-%'
        OR contact_value ~ '\\+s[0-9]+-'
      )
  `;

  if (corrupted.length === 0) {
    console.log('person_contacts audit: no corrupted email rows found');
    return { fixed: 0, skipped: 0 };
  }

  console.log(`person_contacts audit: found ${corrupted.length} corrupted row(s)`);

  let fixed = 0;
  for (const row of corrupted) {
    const canonicalEmail = stripSchoolScopedEmailTag(row.contact_value);
    console.log(`  person_contacts ${row.id}: ${row.contact_value} -> ${canonicalEmail}`);

    if (!dryRun) {
      await sql`
        UPDATE person_contacts
        SET contact_value = ${canonicalEmail}, updated_at = now()
        WHERE id = ${row.id}
      `;
    }
    fixed += 1;
  }

  return { fixed, skipped: 0 };
}

async function listAllAuthUsers() {
  const users = [];
  let page = 1;
  const perPage = 1000;

  while (true) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage });
    if (error) {
      throw error;
    }

    users.push(...(data.users || []));

    if (!data.users || data.users.length < perPage) {
      break;
    }
    page += 1;
  }

  return users;
}

async function migrateAuthUsers() {
  const users = await listAllAuthUsers();
  const candidates = users.filter((user) => hasSchoolScopedEmailTag(user.email));

  console.log(`auth.users audit: ${candidates.length} user(s) with school-scoped email tags`);

  const assignedCanonical = new Map();
  let updated = 0;
  let skipped = 0;
  let conflicts = 0;

  for (const user of candidates) {
    const canonicalEmail = resolveCanonicalEmail(user);

    if (!canonicalEmail || canonicalEmail === normalizeEmail(user.email)) {
      console.log(`  skip ${user.id}: already canonical (${user.email})`);
      skipped += 1;
      continue;
    }

    const existingOwner = assignedCanonical.get(canonicalEmail);
    if (existingOwner && existingOwner !== user.id) {
      console.warn(
        `  conflict ${user.id}: ${user.email} -> ${canonicalEmail} already assigned to ${existingOwner}`
      );
      conflicts += 1;
      continue;
    }

    console.log(`  ${dryRun ? '[dry-run] ' : ''}update ${user.id}: ${user.email} -> ${canonicalEmail}`);

    if (!dryRun) {
      const { error } = await supabaseAdmin.auth.admin.updateUserById(user.id, {
        email: canonicalEmail,
        user_metadata: {
          ...(user.user_metadata || {}),
          canonical_email: canonicalEmail
        }
      });

      if (error) {
        console.error(`  failed ${user.id}: ${error.message}`);
        conflicts += 1;
        continue;
      }
    }

    assignedCanonical.set(canonicalEmail, user.id);
    updated += 1;
  }

  return { updated, skipped, conflicts, totalCandidates: candidates.length };
}

async function main() {
  if (!supabaseAdmin) {
    console.error('Supabase admin client is not configured');
    process.exit(1);
  }

  console.log(dryRun ? 'Running in dry-run mode (no writes)' : 'Applying migration');

  const personContactsResult = await auditPersonContacts();
  const authResult = await migrateAuthUsers();

  console.log('\nSummary');
  console.log(`  person_contacts fixed: ${personContactsResult.fixed}`);
  console.log(`  auth.users candidates: ${authResult.totalCandidates}`);
  console.log(`  auth.users updated: ${authResult.updated}`);
  console.log(`  auth.users skipped: ${authResult.skipped}`);
  console.log(`  auth.users conflicts/failures: ${authResult.conflicts}`);

  if (authResult.conflicts > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await sql.end({ timeout: 5 });
  });
