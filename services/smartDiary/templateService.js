import sql from '../../db.js';
import { renderTemplateContent } from './composeContent.js';

export function applyTemplateVariables(template, values = {}) {
  const content = renderTemplateContent(template?.content, values);
  return {
    id: template?.id || null,
    name: template?.name || '',
    content,
    category: template?.category || 'general',
    scope: template?.scope || 'TEACHER',
  };
}

export async function listTemplates({ schoolId, userInternalId }) {
  const rows = await sql`
    SELECT
      id, school_id, created_by, scope, name, category, content, variables,
      is_favourite, sort_order, usage_count, created_at, updated_at
    FROM diary_templates
    WHERE scope = 'SYSTEM'
       OR (scope = 'SCHOOL' AND school_id = ${schoolId})
       OR (scope = 'TEACHER' AND school_id = ${schoolId} AND created_by = ${userInternalId})
    ORDER BY
      CASE scope WHEN 'TEACHER' THEN 0 WHEN 'SCHOOL' THEN 1 ELSE 2 END,
      is_favourite DESC,
      usage_count DESC,
      sort_order ASC,
      name ASC
  `;

  const mine = [];
  const school = [];
  const system = [];
  for (const row of rows) {
    if (row.scope === 'TEACHER') mine.push(row);
    else if (row.scope === 'SCHOOL') school.push(row);
    else system.push(row);
  }
  return {
    mine,
    school,
    system,
    favourites: [...mine, ...school, ...system].filter((row) => row.is_favourite).slice(0, 8),
  };
}

export async function createTemplate({
  schoolId,
  userInternalId,
  roles = [],
  permissions = [],
  name,
  content,
  category = 'general',
  variables = [],
  scope = 'TEACHER',
  isFavourite = false,
}) {
  const resolvedScope = resolveWriteScope(scope, roles, permissions);
  if (!resolvedScope) {
    const error = new Error('Not allowed to create this template');
    error.status = 403;
    throw error;
  }
  const [row] = await sql`
    INSERT INTO diary_templates (
      school_id, created_by, scope, name, category, content, variables, is_favourite
    ) VALUES (
      ${resolvedScope === 'SYSTEM' ? null : schoolId},
      ${userInternalId},
      ${resolvedScope},
      ${String(name).trim().slice(0, 120)},
      ${String(category || 'general').slice(0, 40)},
      ${String(content).trim()},
      ${JSON.stringify(Array.isArray(variables) ? variables : [])},
      ${Boolean(isFavourite)}
    )
    RETURNING *
  `;
  return row;
}

export async function updateTemplate({
  schoolId,
  userInternalId,
  roles = [],
  permissions = [],
  id,
  patch,
}) {
  const [existing] = await sql`
    SELECT * FROM diary_templates
    WHERE id = ${id}
      AND (
        (scope = 'TEACHER' AND school_id = ${schoolId} AND created_by = ${userInternalId})
        OR (scope = 'SCHOOL' AND school_id = ${schoolId})
        OR scope = 'SYSTEM'
      )
  `;
  if (!existing) return null;
  if (!canMutate(existing, { userInternalId, roles, permissions })) {
    const error = new Error('Not allowed to edit this template');
    error.status = 403;
    throw error;
  }

  const name = patch.name != null ? String(patch.name).trim().slice(0, 120) : existing.name;
  const content = patch.content != null ? String(patch.content).trim() : existing.content;
  const category = patch.category != null ? String(patch.category).slice(0, 40) : existing.category;
  const variables = patch.variables != null ? JSON.stringify(patch.variables) : JSON.stringify(existing.variables || []);
  const isFavourite = patch.is_favourite != null ? Boolean(patch.is_favourite) : existing.is_favourite;
  const sortOrder = patch.sort_order != null ? Number(patch.sort_order) : existing.sort_order;

  const [row] = await sql`
    UPDATE diary_templates SET
      name = ${name},
      content = ${content},
      category = ${category},
      variables = ${variables},
      is_favourite = ${isFavourite},
      sort_order = ${sortOrder},
      updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `;
  return row;
}

export async function deleteTemplate({ schoolId, userInternalId, roles = [], permissions = [], id }) {
  const [existing] = await sql`
    SELECT * FROM diary_templates WHERE id = ${id}
  `;
  if (!existing) return false;
  if (existing.scope === 'SYSTEM') return false;
  if (existing.school_id !== schoolId) return false;
  if (!canMutate(existing, { userInternalId, roles, permissions })) {
    const error = new Error('Not allowed to delete this template');
    error.status = 403;
    throw error;
  }
  await sql`DELETE FROM diary_templates WHERE id = ${id} AND school_id = ${schoolId}`;
  return true;
}

export async function bumpTemplateUsage(id, schoolId) {
  if (!id) return;
  await sql`
    UPDATE diary_templates
    SET usage_count = usage_count + 1, updated_at = now()
    WHERE id = ${id}
      AND (school_id = ${schoolId} OR scope = 'SYSTEM')
  `;
}

function resolveWriteScope(scope, roles, permissions) {
  const requested = String(scope || 'TEACHER').toUpperCase();
  if (requested === 'TEACHER') return 'TEACHER';
  const canManage = roles.includes('admin') || roles.includes('principal') || permissions.includes('diary.manage');
  if (requested === 'SCHOOL' && canManage) return 'SCHOOL';
  return null;
}

function canMutate(template, { userInternalId, roles, permissions }) {
  if (template.scope === 'SYSTEM') return false;
  if (template.scope === 'TEACHER') return template.created_by === userInternalId;
  return roles.includes('admin') || roles.includes('principal') || permissions.includes('diary.manage');
}
