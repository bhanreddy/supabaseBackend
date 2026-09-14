/**
 * User-facing OMR errors. Technical diagnostics stay in logs.
 */

export class OmrUserError extends Error {
  constructor(message, status = 400, code = 'OMR_ERROR', details = null) {
    super(message);
    this.name = 'OmrUserError';
    this.status = status;
    this.statusCode = status;
    this.code = code;
    this.details = details;
    this.expose = true;
  }
}

export const OMR_USER_MESSAGES = {
  MARKER_MISSING: 'Unable to read the sheet. Please align the page so all four corner squares are visible and scan again.',
  POOR_QUALITY: 'Unable to read the sheet. Please hold the device steady and improve lighting.',
  WRONG_EXAM: 'This sheet belongs to a different exam. Select the correct exam or scan a matching sheet.',
  WRONG_TEMPLATE: 'This sheet uses a different OMR template than the selected exam.',
  WRONG_SCHOOL: 'This sheet cannot be processed for the current school.',
  DUPLICATE_SHEET: 'This OMR sheet has already been scanned.',
  UNIDENTIFIED_STUDENT: 'Student could not be identified. Check the roll number bubbles or assign the student manually.',
  NO_ANSWER_KEY: 'Cannot evaluate scans until an answer key is published for this exam.',
  INVALID_STUDENT: 'This student is not enrolled in the selected exam class.',
  FINALIZE_BLOCKED: 'Results cannot be finalized while sheets still need review.',
  INVALID_SHEET: 'This sheet could not be identified. Align the page and scan again.',
  PROCESSING_FAILURE: 'Unable to read the sheet. Please align the page and scan again.',
};

export function logOmrDiagnostic(req, event, extra = {}) {
  const logger = req?.log;
  const payload = {
    event,
    schoolId: req?.schoolId,
    userId: req?.user?.internal_id,
    ...extra,
  };
  if (logger?.warn) logger.warn(payload, `[omr] ${event}`);
  else console.warn(`[omr] ${event}`, payload);
}
