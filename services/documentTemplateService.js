import sql from '../db.js';

export const SUPPORTED_BLOCK_TYPES = [
  'header',
  'student_details',
  'fee_summary',
  'fee_table',
  'payment_instructions',
  'tear_off_slip',
  'custom_text',
  'qr_code',
  'divider',
  'spacer',
  'signature',
];

export const DEFAULT_PAGE_SETTINGS = {
  page_size: 'A4',
  orientation: 'portrait',
  slips_per_page: 1, // 1 (Full A4), 2 (Half A4 dual copy), 4 (Quarter A4)
  margins: {
    top: 8,
    bottom: 8,
    left: 8,
    right: 8,
  },
  show_border: true,
  border_style: 'solid', // 'solid', 'double', 'dashed'
  border_color: '#4B5563',
  font_family: 'Arial, sans-serif',
  primary_color: '#1E3A8A', // Deep classic navy
  accent_color: '#B91C1C', // Urgent red for due amounts
};

/**
 * Professional default template: "Standard Fee Due Slip"
 * Features a complete layout with tearable parent copy and payment instructions.
 */
export function getDefaultTemplateDefinition() {
  return {
    version: 1,
    blocks: [
      {
        id: 'block_header',
        type: 'header',
        enabled: true,
        title: 'FEE DUE NOTICE',
        subtitle: 'ACADEMIC YEAR {{academic_year}}',
        show_logo: true,
        show_school_details: true,
        show_document_number: true,
        show_date: true,
      },
      {
        id: 'block_student_details',
        type: 'student_details',
        enabled: true,
        title: 'Student Information',
        layout: 'grid_2_col',
        fields: [
          { label: 'Student Name', value: '{{student_name}}', bold: true },
          { label: "Father's Name", value: '{{father_name}}' },
          { label: 'Admission No.', value: '{{admission_number}}', bold: true },
          { label: 'Class / Section', value: '{{class_section}}' },
          { label: 'Roll Number', value: '{{roll_number}}' },
          { label: 'Contact Phone', value: '{{student_phone}}' },
        ],
      },
      {
        id: 'block_fee_summary',
        type: 'fee_summary',
        enabled: true,
        title: 'Outstanding Fee Summary',
        show_due_in_words: true,
        fields: [
          { label: 'Total Applicable Fee', value: '{{total_fee}}' },
          { label: 'Concession / Discount', value: '{{concession_amount}}' },
          { label: 'Amount Paid', value: '{{paid_amount}}' },
          { label: 'Outstanding Balance Due', value: '{{due_amount}}', highlight: true },
        ],
      },
      {
        id: 'block_instructions',
        type: 'payment_instructions',
        enabled: true,
        title: 'Important Notice & Payment Instructions',
        due_date_label: 'Please clear the outstanding balance on or before:',
        notice_text:
          'Parents/Guardians are kindly requested to remit the pending fees by the due date. Payments can be made via Cash or UPI at the school accounts counter during office hours (9:00 AM – 4:00 PM). Ignore if already paid.',
        show_upi_qr: true,
      },
      {
        id: 'block_tear_off',
        type: 'tear_off_slip',
        enabled: true,
        title: 'PARENT / GUARDIAN ACKNOWLEDGEMENT COPY',
        instructions: 'Please sign and return this tear-off acknowledgement slip to the class teacher.',
        show_scissors: true,
        fields: [
          { label: 'Student Name', value: '{{student_name}}' },
          { label: "Father's Name", value: '{{father_name}}' },
          { label: 'Class / Sec', value: '{{class_section}}' },
          { label: 'Adm No.', value: '{{admission_number}}' },
          { label: 'Amount Due', value: '{{due_amount}}', bold: true },
          { label: 'Due Date', value: '{{due_date}}' },
        ],
        signatures: [
          { label: 'Parent / Guardian Signature', width: '45%' },
          { label: 'Accounts Officer Signature & Seal', width: '45%' },
        ],
      },
    ],
  };
}

/**
 * Validates a template definition.
 */
export function validateTemplate(data) {
  const errors = [];
  if (!data.name || typeof data.name !== 'string' || !data.name.trim()) {
    errors.push('Template name is required.');
  }

  const def = data.template_definition;
  if (!def || typeof def !== 'object' || !Array.isArray(def.blocks) || def.blocks.length === 0) {
    errors.push('Template must contain at least one document block.');
  } else {
    for (const block of def.blocks) {
      if (!SUPPORTED_BLOCK_TYPES.includes(block.type)) {
        errors.push(`Unsupported block type: "${block.type}".`);
      }
    }
  }

  const settings = data.page_settings;
  if (settings) {
    if (!['A4', 'A5', 'A6'].includes(settings.page_size || 'A4')) {
      errors.push('Invalid page size. Supported: A4, A5, A6.');
    }
    if (![1, 2, 4].includes(Number(settings.slips_per_page || 1))) {
      errors.push('Slips per page must be 1, 2, or 4.');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * List all active templates for a school.
 */
export async function listTemplates(schoolId, { documentType = 'fee_due_slip', includeArchived = false } = {}) {
  const rows = await sql`
    SELECT
      id, school_id, name, document_type, description,
      template_definition, page_settings, is_default, status,
      created_by, updated_by, created_at, updated_at
    FROM document_templates
    WHERE school_id = ${schoolId}
      AND document_type = ${documentType}
      ${includeArchived ? sql`` : sql`AND status = 'active'`}
    ORDER BY is_default DESC, created_at DESC
  `;

  // If no templates exist, auto-seed the default template!
  if (rows.length === 0 && !includeArchived) {
    const seeded = await createDefaultTemplateForSchool(schoolId, documentType);
    return [seeded];
  }

  return rows;
}

/**
 * Creates the default template for a school if none exists.
 */
export async function createDefaultTemplateForSchool(schoolId, documentType = 'fee_due_slip') {
  const def = getDefaultTemplateDefinition();
  const settings = DEFAULT_PAGE_SETTINGS;

  const [created] = await sql`
    INSERT INTO document_templates (
      school_id, name, document_type, description,
      template_definition, page_settings, is_default, status
    ) VALUES (
      ${schoolId},
      'Standard Fee Due Slip',
      ${documentType},
      'Official printable fee due notice with tearable parent acknowledgement receipt.',
      ${sql.json(def)},
      ${sql.json(settings)},
      true,
      'active'
    )
    ON CONFLICT DO NOTHING
    RETURNING *
  `;

  if (created) return created;

  const [existing] = await sql`
    SELECT * FROM document_templates
    WHERE school_id = ${schoolId} AND document_type = ${documentType}
    LIMIT 1
  `;
  return existing;
}

/**
 * Get single template by ID.
 */
export async function getTemplateById(schoolId, templateId) {
  const [template] = await sql`
    SELECT * FROM document_templates
    WHERE id = ${templateId} AND school_id = ${schoolId}
    LIMIT 1
  `;
  return template || null;
}

/**
 * Create a new template.
 */
export async function createTemplate(schoolId, data, userId = null) {
  const validation = validateTemplate(data);
  if (!validation.valid) {
    const error = new Error(validation.errors.join(' '));
    error.status = 400;
    throw error;
  }

  const def = data.template_definition || getDefaultTemplateDefinition();
  const settings = { ...DEFAULT_PAGE_SETTINGS, ...(data.page_settings || {}) };
  const isDefault = Boolean(data.is_default);

  // If setting as default, clear default on other templates for this school
  if (isDefault) {
    await sql`
      UPDATE document_templates
      SET is_default = false
      WHERE school_id = ${schoolId} AND document_type = ${data.document_type || 'fee_due_slip'}
    `;
  }

  const [row] = await sql`
    INSERT INTO document_templates (
      school_id, name, document_type, description,
      template_definition, page_settings, is_default, status,
      created_by, updated_by
    ) VALUES (
      ${schoolId},
      ${data.name.trim()},
      ${data.document_type || 'fee_due_slip'},
      ${data.description || null},
      ${sql.json(def)},
      ${sql.json(settings)},
      ${isDefault},
      'active',
      ${userId},
      ${userId}
    )
    RETURNING *
  `;

  return row;
}

/**
 * Update an existing template.
 */
export async function updateTemplate(schoolId, templateId, data, userId = null) {
  const existing = await getTemplateById(schoolId, templateId);
  if (!existing) {
    const error = new Error('Template not found');
    error.status = 404;
    throw error;
  }

  const name = data.name !== undefined ? data.name.trim() : existing.name;
  const description = data.description !== undefined ? data.description : existing.description;
  const def = data.template_definition !== undefined ? data.template_definition : existing.template_definition;
  const settings = data.page_settings !== undefined ? data.page_settings : existing.page_settings;
  const isDefault = data.is_default !== undefined ? Boolean(data.is_default) : existing.is_default;

  const validation = validateTemplate({ name, template_definition: def, page_settings: settings });
  if (!validation.valid) {
    const error = new Error(validation.errors.join(' '));
    error.status = 400;
    throw error;
  }

  if (isDefault && !existing.is_default) {
    await sql`
      UPDATE document_templates
      SET is_default = false
      WHERE school_id = ${schoolId} AND document_type = ${existing.document_type}
    `;
  }

  const [updated] = await sql`
    UPDATE document_templates
    SET
      name = ${name},
      description = ${description},
      template_definition = ${sql.json(def)},
      page_settings = ${sql.json(settings)},
      is_default = ${isDefault},
      updated_by = ${userId},
      updated_at = NOW()
    WHERE id = ${templateId} AND school_id = ${schoolId}
    RETURNING *
  `;

  return updated;
}

/**
 * Duplicate an existing template.
 */
export async function duplicateTemplate(schoolId, templateId, userId = null) {
  const existing = await getTemplateById(schoolId, templateId);
  if (!existing) {
    const error = new Error('Template not found');
    error.status = 404;
    throw error;
  }

  const [duplicated] = await sql`
    INSERT INTO document_templates (
      school_id, name, document_type, description,
      template_definition, page_settings, is_default, status,
      created_by, updated_by
    ) VALUES (
      ${schoolId},
      ${existing.name + ' (Copy)'},
      ${existing.document_type},
      ${existing.description},
      ${sql.json(existing.template_definition)},
      ${sql.json(existing.page_settings)},
      false,
      'active',
      ${userId},
      ${userId}
    )
    RETURNING *
  `;

  return duplicated;
}

/**
 * Set a template as default.
 */
export async function setDefaultTemplate(schoolId, templateId) {
  const existing = await getTemplateById(schoolId, templateId);
  if (!existing) {
    const error = new Error('Template not found');
    error.status = 404;
    throw error;
  }

  await sql`
    UPDATE document_templates
    SET is_default = false
    WHERE school_id = ${schoolId} AND document_type = ${existing.document_type}
  `;

  const [updated] = await sql`
    UPDATE document_templates
    SET is_default = true, updated_at = NOW()
    WHERE id = ${templateId} AND school_id = ${schoolId}
    RETURNING *
  `;

  return updated;
}

/**
 * Archive a template (soft delete).
 */
export async function archiveTemplate(schoolId, templateId) {
  const [archived] = await sql`
    UPDATE document_templates
    SET status = 'archived', is_default = false, updated_at = NOW()
    WHERE id = ${templateId} AND school_id = ${schoolId}
    RETURNING *
  `;
  if (!archived) {
    const error = new Error('Template not found');
    error.status = 404;
    throw error;
  }
  return archived;
}
