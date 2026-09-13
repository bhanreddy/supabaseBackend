import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidTransition, WORKFLOW_STATUSES } from '../services/admissionWorkflowService.js';
import {
  computeApplicationProgress,
  buildSmartNextAction,
  generateApplicantPassword,
  presentWorkflowTimeline,
  stageCodeForStatus,
} from '../services/admissionHelpers.js';

test('workflow forbids enquiry to student and document pending to confirmed', () => {
  assert.equal(isValidTransition(WORKFLOW_STATUSES.ENQUIRY_CREATED, WORKFLOW_STATUSES.CONVERTED_TO_STUDENT), false);
  assert.equal(isValidTransition(WORKFLOW_STATUSES.DOCUMENT_COLLECTION, WORKFLOW_STATUSES.ADMISSION_CONFIRMED), false);
  assert.equal(isValidTransition(WORKFLOW_STATUSES.APPLICATION_SUBMITTED, WORKFLOW_STATUSES.CONVERTED_TO_STUDENT), false);
  assert.equal(isValidTransition(WORKFLOW_STATUSES.ADMISSION_CONFIRMED, WORKFLOW_STATUSES.CONVERTED_TO_STUDENT), true);
  assert.equal(isValidTransition(WORKFLOW_STATUSES.APPLICATION_STARTED, WORKFLOW_STATUSES.APPLICATION_SUBMITTED), true);
});

test('management override cannot skip conversion gate', () => {
  assert.equal(
    isValidTransition(WORKFLOW_STATUSES.APPLICATION_STARTED, WORKFLOW_STATUSES.CONVERTED_TO_STUDENT, true),
    false
  );
});

test('applicant password is not phone-derived', () => {
  const a = generateApplicantPassword();
  const b = generateApplicantPassword();
  assert.match(a, /^Adm-/);
  assert.notEqual(a, b);
  assert.ok(a.length >= 10);
});

test('progress and next action prioritize applicant work', () => {
  const stages = [
    { code: 'ENQUIRY', name: 'Enquiry', is_active: true },
    { code: 'APPLICATION', name: 'Application', is_active: true },
    { code: 'DOCUMENTS', name: 'Documents', is_active: true },
    { code: 'CONFIRMED', name: 'Confirmed', is_active: true },
  ];
  const pct = computeApplicationProgress({ status: 'APPLICATION_STARTED' }, stages);
  assert.ok(pct > 0 && pct < 100);

  const next = buildSmartNextAction(
    { status: 'APPLICATION_STARTED' },
    { checklist: { checklist: [] }, interviews: [] }
  );
  assert.equal(next.actionKey, 'COMPLETE_FORM');

  const docsNext = buildSmartNextAction(
    { status: 'DOCUMENT_COLLECTION' },
    {
      checklist: {
        checklist: [{ isMandatory: true, displayName: 'Birth Certificate', documentType: 'BIRTH_CERTIFICATE' }],
      },
    }
  );
  assert.equal(docsNext.actionKey, 'UPLOAD_DOCUMENT');

  const converted = buildSmartNextAction({ status: 'CONVERTED_TO_STUDENT' });
  assert.equal(converted.type, 'COMPLETED');
});

test('stage mapping and timeline states', () => {
  assert.equal(stageCodeForStatus('DOCUMENT_VERIFICATION'), 'VERIFICATION');
  const timeline = presentWorkflowTimeline(
    [
      { code: 'APPLICATION', name: 'Application' },
      { code: 'DOCUMENTS', name: 'Documents' },
      { code: 'CONFIRMED', name: 'Confirmed' },
    ],
    { status: 'DOCUMENT_COLLECTION' },
    []
  );
  assert.equal(timeline[0].state, 'done');
  assert.equal(timeline[1].state, 'current');
  assert.equal(timeline[2].state, 'upcoming');
});
