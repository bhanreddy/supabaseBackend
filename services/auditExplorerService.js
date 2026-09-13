import sql from '../db.js';

const SENSITIVE_KEY_REGEX = /(password|token|secret|api_key|private_key|credential|pin|cvv|authorization|cookie|session)/i;
const AADHAAR_REGEX = /\b(\d{4})[ -]?(\d{4})[ -]?(\d{4})\b/g;

/**
 * Deeply mask any sensitive credentials, tokens, passwords, and Aadhaar numbers.
 */
export function maskSensitiveData(data) {
  if (data == null) return data;

  if (typeof data === 'string') {
    // Mask potential Aadhaar numbers in strings
    return data.replace(AADHAAR_REGEX, 'XXXX-XXXX-$3');
  }

  if (Array.isArray(data)) {
    return data.map(maskSensitiveData);
  }

  if (typeof data === 'object') {
    const cleaned = {};
    for (const [k, v] of Object.entries(data)) {
      if (SENSITIVE_KEY_REGEX.test(k)) {
        cleaned[k] = '[REDACTED]';
      } else if (typeof v === 'string' && k.toLowerCase().includes('aadhaar')) {
        cleaned[k] = v.replace(AADHAAR_REGEX, 'XXXX-XXXX-$3');
      } else {
        cleaned[k] = maskSensitiveData(v);
      }
    }
    return cleaned;
  }

  return data;
}

export const maskSensitiveAuditData = maskSensitiveData;

/**
 * Query unified audit logs for a tenant.
 */
export async function queryAuditLogs(schoolId, {
  fromDate = null,
  toDate = null,
  actorId = null,
  entity = null,
  action = null,
  limit = 50,
  offset = 0,
} = {}) {
  const boundedLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const boundedOffset = Math.min(Math.max(Number(offset) || 0, 0), 10_000);
  const rows = await sql`
    WITH combined AS (
      SELECT al.id::text, al.created_at AS timestamp, al.action, al.entity,
        al.entity_id::text, al.user_id AS actor_id, COALESCE(p.display_name, 'System') AS actor_name,
        COALESCE((SELECT string_agg(DISTINCT r.code, ', ' ORDER BY r.code)
          FROM user_roles ur JOIN roles r ON r.id=ur.role_id AND r.school_id=${schoolId}
          WHERE ur.user_id=al.user_id AND ur.school_id=${schoolId} AND ur.deleted_at IS NULL), 'system') AS actor_role,
        'general'::text AS source,
        CASE WHEN al.details ? 'before' THEN al.details->'before' ELSE NULL END AS old_data,
        CASE WHEN al.details ? 'after' THEN al.details->'after' ELSE al.details END AS new_data
      FROM audit_logs al
      LEFT JOIN users u ON al.user_id=u.id AND u.school_id=${schoolId}
      LEFT JOIN persons p ON u.person_id=p.id AND p.school_id=${schoolId}
      WHERE al.school_id=${schoolId}
        ${fromDate ? sql`AND al.created_at >= ${fromDate}::timestamptz` : sql``}
        ${toDate ? sql`AND al.created_at <= ${toDate}::timestamptz` : sql``}
        ${actorId ? sql`AND al.user_id = ${actorId}::uuid` : sql``}
        ${entity ? sql`AND al.entity = ${entity}` : sql``}
        ${action ? sql`AND al.action ILIKE ${'%' + action + '%'}` : sql``}
      UNION ALL
      SELECT fal.id::text, fal.performed_at, fal.action_type, fal.table_name,
        fal.record_id::text, fal.performed_by, COALESCE(p.display_name, 'System'),
        COALESCE((SELECT string_agg(DISTINCT r.code, ', ' ORDER BY r.code)
          FROM user_roles ur JOIN roles r ON r.id=ur.role_id AND r.school_id=${schoolId}
          WHERE ur.user_id=fal.performed_by AND ur.school_id=${schoolId} AND ur.deleted_at IS NULL), 'system'),
        'financial'::text, fal.old_data, fal.new_data
      FROM financial_audit_logs fal
      LEFT JOIN users u ON fal.performed_by=u.id AND u.school_id=${schoolId}
      LEFT JOIN persons p ON u.person_id=p.id AND p.school_id=${schoolId}
      WHERE fal.school_id=${schoolId}
        ${fromDate ? sql`AND fal.performed_at >= ${fromDate}::timestamptz` : sql``}
        ${toDate ? sql`AND fal.performed_at <= ${toDate}::timestamptz` : sql``}
        ${actorId ? sql`AND fal.performed_by = ${actorId}::uuid` : sql``}
        ${entity ? sql`AND fal.table_name = ${entity}` : sql``}
        ${action ? sql`AND fal.action_type ILIKE ${'%' + action + '%'}` : sql``}
    )
    SELECT *, count(*) OVER()::int AS total_count
    FROM combined ORDER BY timestamp DESC, id DESC
    LIMIT ${boundedLimit} OFFSET ${boundedOffset}
  `;
  const total = rows[0]?.total_count || 0;
  return {
    rows: rows.map(({ total_count: _total, ...row }) => ({
      ...row,
      old_data: maskSensitiveData(row.old_data),
      new_data: maskSensitiveData(row.new_data),
    })),
    total,
  };
}
