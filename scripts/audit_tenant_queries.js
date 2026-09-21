import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_AUDIT_FILES = [
  'services/feePaymentService.js',
  'services/feePaymentDeletionService.js',
  'services/feeDueCalculationService.js',
  'services/feeModeService.js',
  'services/feeRecoveryService.js',
  'services/feeRecoveryScope.js',
  'services/defaulterCarryForward.js',
  'services/fineLateFeeEngine.js',
  'services/actionCenterService.js',
  'services/automationActionService.js',
  'services/transportFeeService.js',
  'routes/feesRoutes.js',
  'routes/invoicesRoutes.js',
  'routes/refundRoutes.js',
  'routes/defaulterRoutes.js',
  'routes/analyticsRoutes.js',
  'routes/adminAnalyticsRoutes.js',
  'routes/studentDashboardRoutes.js',
  'routes/studentsRoutes.js',
  'routes/adminRoutes.js',
];

const TENANT_TABLES = [
  'fee_transactions',
  'student_fees',
  'receipt_items',
  'receipts',
  'fee_structures',
  'transport_fee_payments',
  'transport_fee_assignments',
  'fines',
  'refunds',
  'invoices',
];

function lineAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

export function auditSource(source, file = '<source>') {
  const findings = [];
  const tagPattern = /\b(?:sql|tx|db)\s*`([\s\S]*?)`/g;
  let match;
  while ((match = tagPattern.exec(source))) {
    const query = match[1];
    const normalized = query.toLowerCase();
    const referenced = TENANT_TABLES.filter((table) => new RegExp(`\\b${table}\\b`).test(normalized));
    if (referenced.length === 0) continue;
    if (/tenant-audit:\s*allow\b/i.test(query)) continue;
    if (/\bschool_id\b/i.test(query)) continue;

    findings.push({
      file,
      line: lineAt(source, match.index),
      tables: referenced,
      preview: query.replace(/\s+/g, ' ').trim().slice(0, 160),
    });
  }
  return findings;
}

export function auditFiles(files = DEFAULT_AUDIT_FILES) {
  return files.flatMap((file) => {
    const absolute = path.resolve(ROOT, file);
    if (!absolute.startsWith(`${ROOT}${path.sep}`) || !fs.existsSync(absolute)) {
      return [{ file, line: 1, tables: [], preview: 'Audit target is missing' }];
    }
    return auditSource(fs.readFileSync(absolute, 'utf8'), file);
  });
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const requestedFiles = process.argv.slice(2);
  const findings = auditFiles(requestedFiles.length ? requestedFiles : DEFAULT_AUDIT_FILES);
  if (findings.length > 0) {
    console.error('Tenant query audit failed. Add an explicit school_id predicate or a reviewed SQL comment: -- tenant-audit: allow <reason>');
    for (const finding of findings) {
      console.error(`${finding.file}:${finding.line} [${finding.tables.join(', ') || 'missing-file'}] ${finding.preview}`);
    }
    process.exitCode = 1;
  } else {
    console.log(`Tenant query audit passed for ${requestedFiles.length || DEFAULT_AUDIT_FILES.length} high-risk files.`);
  }
}
