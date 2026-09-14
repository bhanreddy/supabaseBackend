import sql from '../db.js';
import { getStudentsWithDueFees, getStudentDetailedFeeBreakdown } from './feeDueCalculationService.js';

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function convertUnderThousand(n) {
  if (n === 0) return '';
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '');
  return ONES[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' and ' + convertUnderThousand(n % 100) : '');
}

/**
 * Converts INR amounts into words (Indian numbering system: Crores, Lakhs, Thousands).
 */
export function inrAmountToWords(amount) {
  const n = Math.round(Number(amount || 0));
  if (n <= 0) return 'Zero Rupees Only';

  const crore = Math.floor(n / 10000000);
  const lakh = Math.floor((n % 10000000) / 100000);
  const thousand = Math.floor((n % 100000) / 1000);
  const remainder = n % 1000;

  const parts = [];
  if (crore) parts.push(convertUnderThousand(crore) + ' Crore');
  if (lakh) parts.push(convertUnderThousand(lakh) + ' Lakh');
  if (thousand) parts.push(convertUnderThousand(thousand) + ' Thousand');
  if (remainder) parts.push(convertUnderThousand(remainder));

  return parts.join(' ').trim() + ' Rupees Only';
}

export function formatCurrencyInr(amount) {
  return '₹' + Number(amount || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

export function formatDateInr(dateStr) {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return String(dateStr);
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch {
    return String(dateStr);
  }
}

/**
 * Fetch school profile & branding settings.
 */
export async function getSchoolBranding(schoolId) {
  const [school] = await sql`
    SELECT id, name, code, address, logo_url
    FROM schools
    WHERE id = ${schoolId}
    LIMIT 1
  `;

  const settingsRows = await sql`
    SELECT key, value
    FROM school_settings
    WHERE school_id = ${schoolId}
      AND key IN ('school_phone', 'school_email', 'school_website', 'school_affiliation_no', 'school_upi_id', 'principal_name')
  `;

  const settings = {};
  for (const s of settingsRows) {
    settings[s.key] = s.value;
  }

  return {
    school_id: school?.id || schoolId,
    name: school?.name || 'School IMS',
    code: school?.code || '',
    address: school?.address || 'Main Campus',
    logo_url: school?.logo_url || '',
    phone: settings.school_phone || '',
    email: settings.school_email || '',
    website: settings.school_website || '',
    upi_id: settings.school_upi_id || '',
    principal_name: settings.principal_name || 'Principal',
  };
}

/**
 * Provides mock sample data for realistic template designer preview.
 */
export function getSampleStudentData(schoolBranding = {}) {
  const today = new Date();
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 14);

  return {
    // Student
    student_name: 'Rahul Kumar',
    admission_number: 'ADM-1023',
    roll_number: '14',
    class: 'VIII',
    section: 'A',
    class_section: 'VIII - A',
    father_name: 'Suresh Kumar',
    mother_name: 'Sunita Devi',
    student_phone: '+91 98765 43210',
    village: 'Maddur Town',
    route_name: 'Route 3 (North)',

    // School
    school_name: schoolBranding.name || 'ABC MODEL HIGH SCHOOL',
    school_address: schoolBranding.address || 'Station Road, Maddur, Telangana - 509410',
    school_phone: schoolBranding.phone || '+91 80080 12345',
    school_email: schoolBranding.email || 'info@abcmodelschool.edu',
    school_logo: schoolBranding.logo_url || '',
    upi_id: schoolBranding.upi_id || 'school@upi',

    // Financials
    total_fee: '₹28,000',
    total_fee_raw: 28000,
    paid_amount: '₹20,000',
    paid_amount_raw: 20000,
    concession_amount: '₹2,000',
    concession_amount_raw: 2000,
    due_amount: '₹8,000',
    due_amount_raw: 8000,
    due_amount_words: 'Eight Thousand Rupees Only',
    tuition_due: '₹6,000',
    transport_due: '₹2,000',
    fine_due: '₹0',
    late_fee: '₹0',
    penalty: '₹0',
    due_date: formatDateInr(dueDate),
    overdue_days: '0',
    fee_status: 'Pending',
    fee_category: 'Tuition & Transport',
    academic_year: '2026-2027',

    // Document metadata
    document_number: 'FDS-2026-000123',
    generated_date: formatDateInr(today),
    generated_time: today.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),

    // Breakdown
    fee_items: [
      { fee_type: 'Term 1 Tuition Fee', amount_due: '₹14,000', amount_paid: '₹14,000', balance_due: '₹0' },
      { fee_type: 'Term 2 Tuition Fee', amount_due: '₹14,000', amount_paid: '₹6,000', balance_due: '₹8,000' },
    ],
  };
}

/**
 * Resolves live data for a specific student into standardized template variables.
 */
export async function resolveStudentDocumentData(schoolId, studentId, { academicYearId = null, documentNumber = null } = {}) {
  const branding = await getSchoolBranding(schoolId);
  const result = await getStudentsWithDueFees(schoolId, {
    student_ids: [studentId],
    academic_year_id: academicYearId,
    limit: 1,
  });

  const student = result.students[0];
  if (!student) {
    throw new Error('Student not found or has no active records for this school.');
  }

  const breakdown = await getStudentDetailedFeeBreakdown(schoolId, studentId, academicYearId);
  const today = new Date();

  // If no document number was allocated yet, generate or use preview
  const docNo = documentNumber || 'FDS-' + today.getFullYear() + '-SAMPLE';

  return {
    student_id: student.student_id,
    student_name: student.student_name,
    admission_number: student.admission_no,
    roll_number: student.roll_number != null ? String(student.roll_number) : '—',
    class: student.class_name,
    section: student.section_name,
    class_section: `${student.class_name} - ${student.section_name}`,
    father_name: student.father_name || 'Guardian',
    mother_name: student.mother_name || '',
    student_phone: student.contact_number || '',
    village: student.village || 'Not assigned',
    route_name: student.route_name || '—',

    // School
    school_name: branding.name,
    school_address: branding.address,
    school_phone: branding.phone,
    school_email: branding.email,
    school_logo: branding.logo_url,
    upi_id: branding.upi_id,

    // Financials
    total_fee: formatCurrencyInr(student.total_fee),
    total_fee_raw: student.total_fee,
    paid_amount: formatCurrencyInr(student.paid_amount),
    paid_amount_raw: student.paid_amount,
    concession_amount: formatCurrencyInr(student.concession_amount),
    concession_amount_raw: student.concession_amount,
    due_amount: formatCurrencyInr(student.due_amount),
    due_amount_raw: student.due_amount,
    due_amount_words: inrAmountToWords(student.due_amount),
    tuition_due: formatCurrencyInr(student.tuition_due),
    transport_due: formatCurrencyInr(student.transport_due),
    fine_due: formatCurrencyInr(student.fine_due),
    late_fee: '₹0',
    penalty: '₹0',
    due_date: formatDateInr(student.earliest_due_date),
    overdue_days: String(student.overdue_days || 0),
    fee_status: student.status,
    fee_category: 'Tuition & Academic',
    academic_year: student.academic_year || result.academic_year?.code || '2026-2027',

    // Metadata
    document_number: docNo,
    generated_date: formatDateInr(today),
    generated_time: today.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),

    // Items for table block
    fee_items: breakdown.items.map((item) => ({
      fee_type: item.fee_type,
      amount_due: formatCurrencyInr(item.amount_due),
      amount_paid: formatCurrencyInr(item.amount_paid),
      balance_due: formatCurrencyInr(item.balance_due),
      due_date: formatDateInr(item.due_date),
    })),
  };
}

/**
 * Replaces {{variable_name}} tokens in a string using the resolved dictionary.
 */
export function interpolateVariables(templateString, dataMap) {
  if (!templateString || typeof templateString !== 'string') return '';
  return templateString.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    return dataMap[key] !== undefined && dataMap[key] !== null ? String(dataMap[key]) : '';
  });
}
