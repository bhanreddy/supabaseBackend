/**
 * SchoolIMS OMR QR payload — safe metadata only. No names, phones, or addresses.
 */

import { createHash } from 'crypto';

export function encodeOmrQrPayload({
  examId,
  sheetId,
  templateId,
  templateVersion = 1,
  studentId = null,
}) {
  const payload = {
    v: 1,
    eid: String(examId),
    sid: String(sheetId),
    tid: String(templateId),
    tv: Number(templateVersion) || 1,
  };
  if (studentId) payload.st = String(studentId);
  return JSON.stringify(payload);
}

export function decodeOmrQrPayload(raw) {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!text) return null;

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const examId = parsed.eid || parsed.exam_id || parsed.examId;
  const sheetId = parsed.sid || parsed.sheet_id || parsed.sheetId;
  const templateId = parsed.tid || parsed.template_id || parsed.templateId;
  if (!examId || !sheetId) return null;

  return {
    version: Number(parsed.v || parsed.version || 1),
    examId: String(examId),
    sheetId: String(sheetId),
    templateId: templateId ? String(templateId) : null,
    templateVersion: Number(parsed.tv || parsed.template_version || 1),
    studentId: parsed.st || parsed.student_id || null,
  };
}

export function generateSheetId({ schoolId, omrExamId, studentEnrollmentId = null, sequence = null }) {
  const basis = [
    String(schoolId),
    String(omrExamId),
    studentEnrollmentId ? String(studentEnrollmentId) : 'BLANK',
    sequence != null ? String(sequence) : '',
  ].join(':');
  const digest = createHash('sha256').update(basis).digest('hex').slice(0, 12).toUpperCase();
  return `SHT-${digest}`;
}

export function hashImageBuffer(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer)) return null;
  return createHash('sha256').update(buffer).digest('hex');
}

export function validateQrAgainstExam(payload, omrExam) {
  if (!payload) {
    return { ok: true, warning: 'QR_UNREADABLE' };
  }
  if (String(payload.examId) !== String(omrExam.id)) {
    return { ok: false, code: 'EXAM_MISMATCH' };
  }
  if (payload.templateId && String(payload.templateId) !== String(omrExam.template_id)) {
    return { ok: false, code: 'TEMPLATE_MISMATCH' };
  }
  return { ok: true };
}
