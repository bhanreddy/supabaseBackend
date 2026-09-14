import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const archiver = require('archiver');
import XLSX from 'xlsx';
import { interpolateVariables } from './documentDataResolver.js';

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  })[c] || c);
}

function safeFilename(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'document';
}

/**
 * Renders a single slip HTML given template definition, page settings, and student data dictionary.
 */
export function renderSingleSlipHtml(templateDef, studentData, pageSettings = {}, slipIndex = 0) {
  const blocks = templateDef?.blocks || [];
  const primaryColor = pageSettings.primary_color || '#1E3A8A';
  const accentColor = pageSettings.accent_color || '#B91C1C';
  const slipsPerPage = Number(pageSettings.slips_per_page || 1);

  const blockHtmls = [];

  for (const block of blocks) {
    if (block.enabled === false) continue;

    switch (block.type) {
      case 'header': {
        const logo = studentData.school_logo
          ? `<img class="fds-logo" src="${escapeHtml(studentData.school_logo)}" alt="Logo" />`
          : `<div class="fds-logo-fallback">${escapeHtml((studentData.school_name || 'S').slice(0, 2).toUpperCase())}</div>`;

        blockHtmls.push(`
          <div class="fds-header">
            <div class="fds-header-left">
              ${block.show_logo !== false ? logo : ''}
              <div class="fds-school-meta">
                <h1 class="fds-school-name">${escapeHtml(studentData.school_name)}</h1>
                ${block.show_school_details !== false ? `
                  <p class="fds-school-addr">${escapeHtml(studentData.school_address || '')}</p>
                  ${studentData.school_phone || studentData.school_email ? `
                    <p class="fds-school-contact">Ph: ${escapeHtml(studentData.school_phone || '—')} | Email: ${escapeHtml(studentData.school_email || '—')}</p>
                  ` : ''}
                ` : ''}
              </div>
            </div>
            <div class="fds-header-right">
              <div class="fds-notice-badge">${escapeHtml(block.title || 'FEE DUE NOTICE')}</div>
              <div class="fds-notice-meta">
                ${block.show_document_number !== false ? `<div>Doc No: <strong>${escapeHtml(studentData.document_number)}</strong></div>` : ''}
                ${block.show_date !== false ? `<div>Date: <strong>${escapeHtml(studentData.generated_date)}</strong></div>` : ''}
                <div>Academic Year: <strong>${escapeHtml(studentData.academic_year)}</strong></div>
              </div>
            </div>
          </div>
        `);
        break;
      }

      case 'student_details': {
        const fields = block.fields || [];
        const fieldHtmls = fields.map((f) => {
          const val = interpolateVariables(f.value, studentData);
          return `
            <div class="fds-detail-item ${f.bold ? 'fds-bold' : ''}">
              <span class="fds-detail-label">${escapeHtml(f.label)}:</span>
              <span class="fds-detail-val">${escapeHtml(val || '—')}</span>
            </div>
          `;
        }).join('');

        blockHtmls.push(`
          <div class="fds-student-box">
            <div class="fds-grid-2col">
              ${fieldHtmls}
            </div>
          </div>
        `);
        break;
      }

      case 'fee_summary': {
        const fields = block.fields || [];
        const rows = fields.map((f) => {
          const val = interpolateVariables(f.value, studentData);
          const isHighlight = Boolean(f.highlight);
          return `
            <tr class="${isHighlight ? 'fds-due-highlight' : ''}">
              <td class="fds-summary-label">${escapeHtml(f.label)}</td>
              <td class="fds-summary-val">${escapeHtml(val)}</td>
            </tr>
          `;
        }).join('');

        blockHtmls.push(`
          <div class="fds-summary-box">
            <table class="fds-summary-table">
              <tbody>
                ${rows}
              </tbody>
            </table>
            ${block.show_due_in_words !== false && studentData.due_amount_words ? `
              <div class="fds-words-line">
                <span class="fds-words-label">Amount in Words:</span>
                <span class="fds-words-val">${escapeHtml(studentData.due_amount_words)}</span>
              </div>
            ` : ''}
          </div>
        `);
        break;
      }

      case 'fee_table': {
        const items = studentData.fee_items || [];
        if (items.length > 0) {
          const itemRows = items.map((item, idx) => `
            <tr>
              <td>${idx + 1}</td>
              <td>${escapeHtml(item.fee_type)}</td>
              <td class="text-right">${escapeHtml(item.amount_due)}</td>
              <td class="text-right">${escapeHtml(item.amount_paid)}</td>
              <td class="text-right font-bold">${escapeHtml(item.balance_due)}</td>
            </tr>
          `).join('');

          blockHtmls.push(`
            <div class="fds-fee-table-wrap">
              <table class="fds-table">
                <thead>
                  <tr>
                    <th style="width: 8%;">#</th>
                    <th>Fee Description</th>
                    <th style="width: 22%;" class="text-right">Applicable</th>
                    <th style="width: 22%;" class="text-right">Paid</th>
                    <th style="width: 22%;" class="text-right">Pending Due</th>
                  </tr>
                </thead>
                <tbody>
                  ${itemRows}
                </tbody>
              </table>
            </div>
          `);
        }
        break;
      }

      case 'payment_instructions': {
        blockHtmls.push(`
          <div class="fds-notice-box">
            <div class="fds-notice-heading">Important Notice & Payment Instructions</div>
            <div class="fds-due-target-banner">
              ${escapeHtml(block.due_date_label || 'Please clear the outstanding balance on or before:')}
              <strong>${escapeHtml(studentData.due_date)}</strong>
            </div>
            <p class="fds-notice-p">${escapeHtml(block.notice_text || '')}</p>
          </div>
        `);
        break;
      }

      case 'tear_off_slip': {
        const fields = block.fields || [];
        const slipFields = fields.map((f) => {
          const val = interpolateVariables(f.value, studentData);
          return `
            <div class="fds-slip-item ${f.bold ? 'fds-bold' : ''}">
              <span class="fds-slip-label">${escapeHtml(f.label)}:</span>
              <span class="fds-slip-val">${escapeHtml(val || '—')}</span>
            </div>
          `;
        }).join('');

        const sigs = (block.signatures || [
          { label: 'Parent / Guardian Signature', width: '45%' },
          { label: 'Accounts Officer / Seal', width: '45%' },
        ]).map((sig) => `
          <div class="fds-sig-block" style="width: ${sig.width || '45%'};">
            <div class="fds-sig-line"></div>
            <div class="fds-sig-label">${escapeHtml(sig.label)}</div>
          </div>
        `).join('');

        blockHtmls.push(`
          <div class="fds-tear-section">
            <div class="fds-cut-line">
              <span class="fds-scissor-icon">✂</span>
              <span class="fds-cut-text">TEAR ALONG DOTTED LINE — DETACH & SUBMIT WITH PAYMENT</span>
              <span class="fds-cut-dash"></span>
            </div>
            <div class="fds-tear-content">
              <div class="fds-tear-header">
                <div class="fds-tear-title">${escapeHtml(block.title || 'PARENT / GUARDIAN ACKNOWLEDGEMENT SLIP')}</div>
                <div class="fds-tear-meta">${escapeHtml(studentData.school_name)} | Doc: ${escapeHtml(studentData.document_number)}</div>
              </div>
              <div class="fds-tear-grid">
                ${slipFields}
              </div>
              <div class="fds-signatures-row">
                ${sigs}
              </div>
            </div>
          </div>
        `);
        break;
      }

      case 'custom_text': {
        const text = interpolateVariables(block.content || '', studentData);
        blockHtmls.push(`
          <div class="fds-custom-text" style="font-size: ${block.font_size || '3.2mm'}; text-align: ${block.align || 'left'};">
            ${escapeHtml(text)}
          </div>
        `);
        break;
      }

      case 'divider': {
        blockHtmls.push(`<div class="fds-divider" style="border-top: ${block.thickness || '0.3mm'} ${block.style || 'solid'} #cbd5e1; margin: 3mm 0;"></div>`);
        break;
      }

      case 'spacer': {
        blockHtmls.push(`<div class="fds-spacer" style="height: ${block.height || '4mm'};"></div>`);
        break;
      }

      default:
        break;
    }
  }

  const slipClasses = [
    'fds-slip',
    slipsPerPage === 2 ? 'fds-half-slip' : slipsPerPage === 4 ? 'fds-quarter-slip' : 'fds-full-slip',
  ].join(' ');

  return `
    <article class="${slipClasses}" data-student-id="${escapeHtml(studentData.student_id)}">
      ${blockHtmls.join('\n')}
    </article>
  `;
}

/**
 * Returns comprehensive print stylesheet with millimeter precision, typography, and tear line styling.
 */
export function getDocumentEngineStyles(pageSettings = {}) {
  const primaryColor = pageSettings.primary_color || '#1E3A8A';
  const accentColor = pageSettings.accent_color || '#B91C1C';
  const fontFamily = pageSettings.font_family || 'Arial, "Noto Sans", sans-serif';
  const slipsPerPage = Number(pageSettings.slips_per_page || 1);

  return `
    @page {
      size: A4 portrait;
      margin: 0;
    }
    * {
      box-sizing: border-box;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    html, body {
      margin: 0;
      padding: 0;
      font-family: ${fontFamily};
      background: #eef2f6;
      color: #111827;
      line-height: 1.35;
      font-size: 3.2mm;
    }
    .fds-page {
      width: 210mm;
      height: 297mm;
      padding: 8mm 9mm;
      margin: 0 auto;
      background: #ffffff;
      page-break-after: always;
      break-after: page;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      justify-content: flex-start;
      position: relative;
    }
    .fds-page:last-child {
      page-break-after: auto;
      break-after: auto;
    }

    /* Layout Variations */
    .fds-page.layout-1-slip {
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .fds-page.layout-2-slips {
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 5mm;
    }
    .fds-page.layout-4-slips {
      display: grid;
      grid-template-columns: 1fr 1fr;
      grid-template-rows: 1fr 1fr;
      gap: 5mm;
    }

    .fds-slip {
      border: 0.35mm solid #cbd5e1;
      border-radius: 2mm;
      padding: 4.5mm 5.5mm;
      background: #ffffff;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      break-inside: avoid;
      page-break-inside: avoid;
      overflow: hidden;
    }
    .fds-full-slip {
      height: 100%;
    }
    .fds-half-slip {
      height: 137mm;
      padding: 3.5mm 4.5mm;
      font-size: 2.8mm;
    }
    .fds-quarter-slip {
      height: 137mm;
      padding: 2.5mm 3.5mm;
      font-size: 2.5mm;
    }

    /* Header */
    .fds-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 0.45mm solid ${primaryColor};
      padding-bottom: 2.5mm;
      margin-bottom: 3mm;
    }
    .fds-header-left {
      display: flex;
      align-items: center;
      gap: 3.5mm;
      flex: 1;
    }
    .fds-logo {
      width: 14mm;
      height: 14mm;
      object-fit: contain;
    }
    .fds-logo-fallback {
      width: 13mm;
      height: 13mm;
      border-radius: 50%;
      background: ${primaryColor};
      color: #ffffff;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 800;
      font-size: 4.5mm;
    }
    .fds-school-name {
      margin: 0;
      font-size: 4.6mm;
      font-weight: 800;
      color: ${primaryColor};
      text-transform: uppercase;
      letter-spacing: 0.2mm;
      line-height: 1.15;
    }
    .fds-school-addr {
      margin: 0.8mm 0 0 0;
      font-size: 2.8mm;
      color: #4b5563;
    }
    .fds-school-contact {
      margin: 0.4mm 0 0 0;
      font-size: 2.6mm;
      color: #6b7280;
    }
    .fds-header-right {
      text-align: right;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 1mm;
    }
    .fds-notice-badge {
      background: ${accentColor};
      color: #ffffff;
      padding: 1mm 3.5mm;
      border-radius: 1.5mm;
      font-size: 3.2mm;
      font-weight: 800;
      letter-spacing: 0.4mm;
      text-transform: uppercase;
    }
    .fds-notice-meta {
      font-size: 2.7mm;
      color: #374151;
      line-height: 1.3;
    }

    /* Student Information Box */
    .fds-student-box {
      background: #f8fafc;
      border: 0.3mm solid #e2e8f0;
      border-radius: 1.5mm;
      padding: 2.5mm 3.5mm;
      margin-bottom: 3mm;
    }
    .fds-grid-2col {
      display: grid;
      grid-template-columns: 1fr 1fr;
      row-gap: 1.4mm;
      column-gap: 4mm;
    }
    .fds-detail-item {
      display: flex;
      gap: 1.5mm;
      font-size: 3mm;
    }
    .fds-detail-label {
      color: #4b5563;
      font-weight: 500;
      white-space: nowrap;
    }
    .fds-detail-val {
      color: #111827;
      font-weight: 600;
    }
    .fds-bold .fds-detail-val {
      font-weight: 800;
      color: #0f172a;
    }

    /* Fee Summary Box */
    .fds-summary-box {
      border: 0.35mm solid #cbd5e1;
      border-radius: 1.5mm;
      overflow: hidden;
      margin-bottom: 3mm;
    }
    .fds-summary-table {
      width: 100%;
      border-collapse: collapse;
    }
    .fds-summary-table td {
      padding: 1.6mm 3mm;
      font-size: 3.1mm;
      border-bottom: 0.25mm solid #f1f5f9;
    }
    .fds-summary-label {
      color: #374151;
      font-weight: 600;
    }
    .fds-summary-val {
      text-align: right;
      font-weight: 700;
      color: #111827;
      font-variant-numeric: tabular-nums;
    }
    .fds-due-highlight {
      background: #fef2f2 !important;
    }
    .fds-due-highlight .fds-summary-label {
      color: ${accentColor};
      font-size: 3.4mm;
      font-weight: 800;
    }
    .fds-due-highlight .fds-summary-val {
      color: ${accentColor};
      font-size: 4mm;
      font-weight: 800;
    }
    .fds-words-line {
      background: #fdf2f8;
      border-top: 0.25mm dashed #f472b6;
      padding: 1.5mm 3mm;
      font-size: 2.7mm;
      display: flex;
      gap: 1.5mm;
    }
    .fds-words-label {
      font-weight: 600;
      color: #9d174d;
    }
    .fds-words-val {
      font-weight: 700;
      color: #831843;
      font-style: italic;
    }

    /* Fee Table */
    .fds-fee-table-wrap {
      margin-bottom: 3mm;
    }
    .fds-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 2.8mm;
    }
    .fds-table th {
      background: #f1f5f9;
      color: #334155;
      font-weight: 700;
      padding: 1.5mm 2.5mm;
      border: 0.25mm solid #cbd5e1;
      text-align: left;
    }
    .fds-table td {
      padding: 1.4mm 2.5mm;
      border: 0.25mm solid #e2e8f0;
    }
    .text-right { text-align: right; }
    .font-bold { font-weight: 700; }

    /* Notice Box */
    .fds-notice-box {
      background: #fffbeb;
      border: 0.3mm solid #fde68a;
      border-radius: 1.5mm;
      padding: 2.2mm 3.2mm;
      margin-bottom: 3.5mm;
    }
    .fds-notice-heading {
      font-size: 2.8mm;
      font-weight: 700;
      color: #92400e;
      text-transform: uppercase;
      letter-spacing: 0.2mm;
      margin-bottom: 0.8mm;
    }
    .fds-due-target-banner {
      font-size: 3mm;
      color: #78350f;
      margin-bottom: 1mm;
    }
    .fds-due-target-banner strong {
      color: ${accentColor};
      font-size: 3.3mm;
      margin-left: 1mm;
      text-decoration: underline;
    }
    .fds-notice-p {
      margin: 0;
      font-size: 2.6mm;
      color: #92400e;
      line-height: 1.35;
    }

    /* Tear-Off Slip Section */
    .fds-tear-section {
      margin-top: auto;
      border-top: 0.35mm dashed #4b5563;
      padding-top: 2.5mm;
      position: relative;
    }
    .fds-cut-line {
      display: flex;
      align-items: center;
      gap: 2mm;
      margin-bottom: 2mm;
      color: #4b5563;
      font-size: 2.4mm;
      font-weight: 700;
      letter-spacing: 0.2mm;
    }
    .fds-scissor-icon {
      font-size: 3.8mm;
      color: #1f2937;
    }
    .fds-cut-text {
      white-space: nowrap;
    }
    .fds-cut-dash {
      flex: 1;
      border-top: 0.35mm dashed #9ca3af;
      height: 0;
    }
    .fds-tear-content {
      background: #fafafa;
      border: 0.3mm solid #e5e7eb;
      border-radius: 1.5mm;
      padding: 2.5mm 3.5mm;
    }
    .fds-tear-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 0.25mm solid #d1d5db;
      padding-bottom: 1.2mm;
      margin-bottom: 2mm;
    }
    .fds-tear-title {
      font-size: 2.8mm;
      font-weight: 800;
      color: #111827;
      letter-spacing: 0.2mm;
    }
    .fds-tear-meta {
      font-size: 2.4mm;
      color: #4b5563;
    }
    .fds-tear-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      row-gap: 1.2mm;
      column-gap: 3mm;
      font-size: 2.7mm;
      margin-bottom: 3.5mm;
    }
    .fds-slip-item {
      display: flex;
      gap: 1mm;
    }
    .fds-slip-label {
      color: #4b5563;
    }
    .fds-slip-val {
      color: #111827;
      font-weight: 600;
    }
    .fds-signatures-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      padding-top: 1mm;
    }
    .fds-sig-block {
      text-align: center;
    }
    .fds-sig-line {
      border-bottom: 0.3mm solid #374151;
      height: 6mm;
      margin-bottom: 1mm;
    }
    .fds-sig-label {
      font-size: 2.4mm;
      font-weight: 600;
      color: #374151;
    }

    @media print {
      body {
        background: transparent !important;
      }
      .fds-page {
        margin: 0 !important;
        padding: 8mm 9mm !important;
        box-shadow: none !important;
        border: none !important;
      }
    }
  `;
}

/**
 * Compiles a complete multi-student document HTML string.
 */
export function buildDocumentHtml({ template, studentsData, pageSettings = {} }) {
  const mergedSettings = { ...pageSettings, ...(template?.page_settings || {}) };
  const slipsPerPage = Number(mergedSettings.slips_per_page || 1);
  const styles = getDocumentEngineStyles(mergedSettings);

  const pages = [];

  for (let i = 0; i < studentsData.length; i += slipsPerPage) {
    const chunk = studentsData.slice(i, i + slipsPerPage);
    const slipsHtml = chunk
      .map((student, idx) => renderSingleSlipHtml(template?.template_definition, student, mergedSettings, i + idx))
      .join('\n');

    pages.push(`
      <section class="fds-page layout-${slipsPerPage}-slip${slipsPerPage > 1 ? 's' : ''}">
        ${slipsHtml}
      </section>
    `);
  }

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>${escapeHtml(template?.name || 'Fee Due Slips')}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <style>
    ${styles}
  </style>
</head>
<body>
  ${pages.join('\n')}
</body>
</html>`;
}

/**
 * Builds a ZIP archive of individual personalized slips organized by class & section.
 */
export async function buildZipArchive({ template, studentsData, pageSettings = {} }) {
  const archive = archiver('zip', { zlib: { level: 9 } });

  for (const student of studentsData) {
    const singleHtml = buildDocumentHtml({
      template,
      studentsData: [student],
      pageSettings: { ...pageSettings, slips_per_page: 1 },
    });

    const classFolder = `Class-${safeFilename(student.class || 'Unassigned')}-${safeFilename(student.section || 'General')}`;
    const filename = `${safeFilename(student.student_name)}-${safeFilename(student.admission_number || 'ADM')}.html`;
    const entryPath = `Fee-Due-Slips/${classFolder}/${filename}`;

    archive.append(singleHtml, { name: entryPath });
  }

  await archive.finalize();
  return archive;
}

/**
 * Builds a structured, formatted Excel workbook using SheetJS.
 */
export function buildDueStudentsWorkbook({ schoolName, academicYear, students, filters = {} }) {
  const generatedAt = new Date().toLocaleString('en-IN');
  const totals = students.reduce(
    (acc, s) => ({
      total_fee: acc.total_fee + Number(s.total_fee || 0),
      concession: acc.concession + Number(s.concession_amount || 0),
      paid: acc.paid + Number(s.paid_amount || 0),
      due: acc.due + Number(s.due_amount || 0),
      transport_due: acc.transport_due + Number(s.transport_due || 0),
    }),
    { total_fee: 0, concession: 0, paid: 0, due: 0, transport_due: 0 }
  );

  const filtersText = [
    filters.class_name ? `Class: ${filters.class_name}` : null,
    filters.section_name ? `Section: ${filters.section_name}` : null,
    filters.fee_status ? `Status: ${filters.fee_status}` : null,
  ].filter(Boolean).join(' | ') || 'All Pending Fees';

  const sheetRows = [
    [`${schoolName || 'School'} — Fee Due Slips Roster`],
    ['Academic Year', academicYear || 'Current'],
    ['Filters', filtersText],
    ['Generated', generatedAt],
    [],
    [
      'Students Count',
      students.length,
      'Total Applicable Fee',
      totals.total_fee,
      'Total Concessions',
      totals.concession,
      'Total Paid Fee',
      totals.paid,
      'Total Outstanding Due',
      totals.due,
    ],
    [],
    [
      'S.No.',
      'Admission No.',
      'Student Name',
      "Father's Name",
      'Mobile Number',
      'Class',
      'Section',
      'Roll No.',
      'Village / Stop',
      'Total Fee',
      'Concession',
      'Paid Fee',
      'Outstanding Due',
      'Transport Due',
      'Due Date',
      'Overdue Days',
      'Status',
    ],
    ...students.map((s, idx) => [
      idx + 1,
      s.admission_number || s.admission_no || '',
      s.student_name || '',
      s.father_name || '',
      s.student_phone || s.contact_number || '',
      s.class || s.class_name || '',
      s.section || s.section_name || '',
      s.roll_number ?? '',
      s.village || '',
      Number(s.total_fee || 0),
      Number(s.concession_amount || 0),
      Number(s.paid_amount || 0),
      Number(s.due_amount || 0),
      Number(s.transport_due || 0),
      s.due_date || s.earliest_due_date || '',
      Number(s.overdue_days || 0),
      s.status || s.fee_status || '',
    ]),
    [],
    [
      'TOTAL',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      totals.total_fee,
      totals.concession,
      totals.paid,
      totals.due,
      totals.transport_due,
      '',
      '',
      '',
    ],
  ];

  const worksheet = XLSX.utils.aoa_to_sheet(sheetRows);
  worksheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 16 } }];
  worksheet['!cols'] = [
    { wch: 8 }, { wch: 16 }, { wch: 28 }, { wch: 26 }, { wch: 18 },
    { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 20 }, { wch: 16 },
    { wch: 16 }, { wch: 16 }, { wch: 18 }, { wch: 16 }, { wch: 16 },
    { wch: 14 }, { wch: 14 },
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Fee Due List');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

/**
 * Builds RFC-4180 compliant CSV export of due students.
 */
export function buildDueStudentsCsv(students) {
  const headers = [
    'S.No',
    'Admission No',
    'Student Name',
    'Father Name',
    'Phone',
    'Class',
    'Section',
    'Roll No',
    'Village',
    'Total Fee',
    'Concession',
    'Paid Amount',
    'Due Amount',
    'Due Date',
    'Overdue Days',
    'Status',
  ];

  const csvRows = [headers.join(',')];

  students.forEach((s, idx) => {
    const row = [
      idx + 1,
      `"${String(s.admission_number || s.admission_no || '').replace(/"/g, '""')}"`,
      `"${String(s.student_name || '').replace(/"/g, '""')}"`,
      `"${String(s.father_name || '').replace(/"/g, '""')}"`,
      `"${String(s.student_phone || s.contact_number || '').replace(/"/g, '""')}"`,
      `"${String(s.class || s.class_name || '').replace(/"/g, '""')}"`,
      `"${String(s.section || s.section_name || '').replace(/"/g, '""')}"`,
      `"${String(s.roll_number || '').replace(/"/g, '""')}"`,
      `"${String(s.village || '').replace(/"/g, '""')}"`,
      Number(s.total_fee || 0),
      Number(s.concession_amount || 0),
      Number(s.paid_amount || 0),
      Number(s.due_amount || 0),
      `"${String(s.due_date || s.earliest_due_date || '').replace(/"/g, '""')}"`,
      Number(s.overdue_days || 0),
      `"${String(s.status || '').replace(/"/g, '""')}"`,
    ];
    csvRows.push(row.join(','));
  });

  return csvRows.join('\r\n');
}

/**
 * Builds editable Word DOCX file (Word XML/HTML format recognized natively by MS Word & LibreOffice).
 */
export function buildDocxHtml({ template, studentsData, pageSettings = {} }) {
  const htmlContent = buildDocumentHtml({ template, studentsData, pageSettings });
  return `
    <html xmlns:o='urn:schemas-microsoft-com:office:office'
          xmlns:w='urn:schemas-microsoft-com:office:word'
          xmlns='http://www.w3.org/TR/REC-html40'>
    <head>
      <!--[if gte mso 9]>
      <xml>
        <w:WordDocument>
          <w:View>Print</w:View>
          <w:Zoom>100</w:Zoom>
          <w:DoNotOptimizeForBrowser/>
        </w:WordDocument>
      </xml>
      <![endif]-->
      <meta charset="utf-8">
      <title>${escapeHtml(template?.name || 'Fee Due Slips')}</title>
    </head>
    <body>
      ${htmlContent}
    </body>
    </html>
  `;
}
