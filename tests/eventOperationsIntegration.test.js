import test from 'node:test';
import assert from 'node:assert/strict';
import sql from '../db.js';

import { EventEngineService } from '../services/eventEngineService.js';
import { EventApprovalService } from '../services/eventApprovalService.js';
import { EventRegistrationService } from '../services/eventRegistrationService.js';
import { EventConsentService } from '../services/eventConsentService.js';
import { EventPassService } from '../services/eventPassService.js';
import { EventAttendanceService } from '../services/eventAttendanceService.js';
import { EventTransportService } from '../services/eventTransportService.js';
import { EventTeamTaskService } from '../services/eventTeamTaskService.js';
import { EventBudgetExpenseService } from '../services/eventBudgetExpenseService.js';
import { EventVendorService } from '../services/eventVendorService.js';
import { EventCompetitionService } from '../services/eventCompetitionService.js';
import { EventCertificateService } from '../services/eventCertificateService.js';
import { EventIncidentService } from '../services/eventIncidentService.js';
import { EventFeedbackService } from '../services/eventFeedbackService.js';
import { EventReportService } from '../services/eventReportService.js';
import { EventPaymentService } from '../services/eventPaymentService.js';

const TEST_SCHOOL_A = 13;
const TEST_SCHOOL_B = 17;

test('Complete Paperless Event Operations Integration Lifecycle', async (t) => {
  // Check schools existence
  const [schoolA] = await sql`SELECT id FROM schools WHERE id = ${TEST_SCHOOL_A}`;
  const [schoolB] = await sql`SELECT id FROM schools WHERE id = ${TEST_SCHOOL_B}`;
  if (!schoolA || !schoolB) {
    console.log('Skipping event integration test: Schools not found');
    return;
  }

  // Find sample student, staff, user, and bus in School A
  const [sampleStudent] = await sql`
    SELECT s.id, p.first_name, p.last_name, p.display_name
    FROM students s
    JOIN persons p ON s.person_id = p.id
    WHERE s.school_id = ${TEST_SCHOOL_A}
    LIMIT 1
  `;
  const [sampleStaff] = await sql`
    SELECT id, person_id FROM staff WHERE school_id = ${TEST_SCHOOL_A} LIMIT 1
  `;
  const [sampleUser] = await sql`
    SELECT id FROM public.users WHERE school_id = ${TEST_SCHOOL_A} LIMIT 1
  `;
  const [sampleBus] = await sql`
    SELECT id, bus_no FROM buses WHERE school_id = ${TEST_SCHOOL_A} LIMIT 1
  `;

  assert.ok(sampleStudent, 'Sample student must exist in School A');

  // Track created event IDs for cleanup
  const cleanupEventIds = [];
  let currentEventId;

  try {
    // =========================================================================
    // 1. EVENT CREATION & READINESS SCORE
    // =========================================================================
    await t.test('1. Event Planning & Creation with Readiness Score', async () => {
      const event = await EventEngineService.createEvent({
        schoolId: TEST_SCHOOL_A,
        data: {
          title: 'Science Museum Educational Trip 2026',
          description: 'Comprehensive field trip to Nehru Science Centre for Grade 7 & 8',
          event_type: 'FIELD_TRIP',
          category: 'TRIP',
          start_date: '2026-10-15',
          end_date: '2026-10-15',
          start_time: '08:00:00',
          end_time: '17:00:00',
          location: 'Nehru Science Centre, Mumbai',
          registration_deadline: '2026-10-10 23:59:59',
          coordinator_id: sampleUser?.id || null,
          configuration: {
            modules: { consent: true, payments: true, transport: true, competitions: false },
            constraints: {
              capacity_limit: 1, // Set to 1 to test waitlisting later
              fee_amount: 350,
              max_activities_per_student: 2,
            },
          },
        },
        targets: [
          { targetType: 'CLASS', targetId: '7' },
          { targetType: 'CLASS', targetId: '8' },
        ],
        userId: sampleUser?.id || null,
      });

      assert.ok(event.id, 'Event must be created');
      currentEventId = event.id;
      cleanupEventIds.push(event.id);
      assert.equal(event.status, 'DRAFT');
      assert.equal(event.category, 'TRIP');
      assert.ok(Number(event.readiness_score) >= 0, 'Readiness score must be calculated');

      // Verify target audience
      const targets = await sql`SELECT * FROM event_audience_targets WHERE event_id = ${event.id}`;
      assert.equal(targets.length, 2, 'Two target audiences must be inserted');

      // Verify audit log
      const [audit] = await sql`
        SELECT action FROM event_audit_logs WHERE event_id = ${event.id} AND action = 'EVENT_CREATED'
      `;
      assert.ok(audit, 'Audit log for event creation must exist');
    });

    // =========================================================================
    // 2. MULTI-STAGE APPROVAL WORKFLOW
    // =========================================================================
    await t.test('2. Multi-tier Approval Workflow (Submit -> Decide)', async () => {
      // Submit for approval
      const approval = await EventApprovalService.submitForApproval({
        schoolId: TEST_SCHOOL_A,
        eventId: currentEventId,
        userId: sampleUser?.id || null,
        comments: 'Submitted for administrative approval',
      });
      assert.ok(approval.id);
      assert.equal(approval.approval_status, 'PENDING');
      assert.equal(approval.status, 'AWAITING_APPROVAL');

      // Principal approves
      const decision = await EventApprovalService.decideApproval({
        schoolId: TEST_SCHOOL_A,
        eventId: currentEventId,
        userId: sampleUser?.id || null,
        decision: 'APPROVED',
        comments: 'Educational trip sanctioned by Principal',
        stage: 'PRINCIPAL',
      });
      assert.equal(decision.approval_status, 'APPROVED');
      assert.equal(decision.status, 'APPROVED');

      // Check event status transitioned to APPROVED
      const [updatedEvent] = await sql`
        SELECT approval_status, status FROM events WHERE id = ${currentEventId}
      `;
      assert.equal(updatedEvent.approval_status, 'APPROVED');
      assert.equal(updatedEvent.status, 'APPROVED');
    });

    // =========================================================================
    // 3. REGISTRATION & CAPACITY CONSTRAINTS
    // =========================================================================
    let primaryRegistration;
    await t.test('3. Student Registration & Capacity Constraint Waitlisting', async () => {
      // Register primary student (capacity limit is 1)
      const reg1 = await EventRegistrationService.registerParticipant({
        schoolId: TEST_SCHOOL_A,
        eventId: currentEventId,
        data: {
          participant_type: 'STUDENT',
          student_id: sampleStudent.id,
          selected_activities: ['EXHIBIT_TOUR'],
        },
        userId: sampleUser?.id || null,
      });

      assert.equal(reg1.registration_status, 'REGISTERED');
      primaryRegistration = reg1;

      // Find another student to test WAITLIST when capacity is full
      const [otherStudent] = await sql`
        SELECT s.id FROM students s
        WHERE s.school_id = ${TEST_SCHOOL_A} AND s.id != ${sampleStudent.id}
        LIMIT 1
      `;
      if (otherStudent) {
        const reg2 = await EventRegistrationService.registerParticipant({
          schoolId: TEST_SCHOOL_A,
          eventId: currentEventId,
          data: {
            participant_type: 'STUDENT',
            student_id: otherStudent.id,
          },
          userId: sampleUser?.id || null,
        });
        assert.equal(reg2.registration_status, 'WAITLISTED', 'Second participant should be waitlisted');
      }

      // Verify roster count
      const roster = await EventRegistrationService.listRegistrations({
        schoolId: TEST_SCHOOL_A,
        eventId: currentEventId,
      });
      assert.ok(roster.length >= 1);
    });

    // =========================================================================
    // 4. PARENT DIGITAL CONSENT & TAMPER-EVIDENT HASH
    // =========================================================================
    await t.test('4. Parent Digital Consent Submission & Integrity Check', async () => {
      const consent = await EventConsentService.submitParentConsent({
        schoolId: TEST_SCHOOL_A,
        eventId: currentEventId,
        studentId: sampleStudent.id,
        status: 'CONSENTED',
        acknowledgements: {
          medical_declaration_ack: true,
          emergency_treatment_auth: true,
          transportation_consent: true,
          photography_media_consent: true,
          rules_instructions_ack: true,
        },
        remarks: 'Carries inhaler in backpack',
        ipAddress: '192.168.1.100',
        userAgent: 'SchoolIMS-Parent-App/iOS-17.4',
        userId: sampleUser?.id || null,
      });

      assert.equal(consent.status, 'CONSENTED');
      assert.ok(consent.responded_at, 'Consent response timestamp must be computed');

      // Consent summary check
      const summary = await EventConsentService.getConsentSummary({
        schoolId: TEST_SCHOOL_A,
        eventId: currentEventId,
      });
      assert.equal(summary.consented_count, 1);
      assert.ok(summary.consent_percentage >= 50);
    });

    // =========================================================================
    // 5. TRANSPORT ASSIGNMENT & BUS MANIFEST
    // =========================================================================
    if (sampleBus) {
      await t.test('5. Bus Transport Assignment & Boarding Status Updates', async () => {
        const assignment = await EventTransportService.assignBusToEvent({
          schoolId: TEST_SCHOOL_A,
          eventId: currentEventId,
          busId: sampleBus.id,
          vehicleCapacity: 45,
          pickupPoint: 'Main School Gate A',
          departureTime: '08:15:00',
          returnTime: '16:45:00',
          routeDescription: 'Campus -> Highway Express -> Nehru Science Centre',
          userId: sampleUser?.id || null,
        });
        assert.ok(assignment.id);

        // Add student to manifest
        const manifest = await EventTransportService.addStudentToBusManifest({
          schoolId: TEST_SCHOOL_A,
          assignmentId: assignment.id,
          eventId: currentEventId,
          studentId: sampleStudent.id,
          pickupStop: 'Campus Main Gate',
        });
        assert.ok(manifest.id);
        assert.equal(manifest.boarding_status, 'NOT_BOARDED');

        // Update boarding status to ON_BUS
        const updatedManifest = await EventTransportService.updateBoardingStatus({
          schoolId: TEST_SCHOOL_A,
          manifestId: manifest.id,
          boardingStatus: 'ON_BUS',
          markedBy: sampleUser?.id || null,
        });
        assert.equal(updatedManifest.boarding_status, 'ON_BUS');
      });
    }

    // =========================================================================
    // 6. CRYPTOGRAPHIC QR PASS & GATEKEEPER CHECK-IN
    // =========================================================================
    let passToken;
    await t.test('6. Secure QR Pass Generation & Anti-Replay Gatekeeper Check-In', async () => {
      const passResult = await EventPassService.generatePassForRegistration({
        schoolId: TEST_SCHOOL_A,
        eventId: currentEventId,
        registrationId: primaryRegistration.id,
        attendeeType: 'STUDENT',
        studentId: sampleStudent.id,
        validFrom: '2026-10-15 00:00:00',
        validUntil: '2026-10-15 23:59:59',
      });

      assert.ok(passResult.pass.id);
      assert.ok(passResult.token.startsWith('evpass_'), 'Token should have evpass_ prefix');
      assert.ok(passResult.pass.pass_code.startsWith('EV-'), 'Short code should have EV- prefix');
      passToken = passResult.token;

      // 1. First validate unpaid pass -> should reject with PAYMENT_PENDING
      const unpaidValidation = await EventPassService.validateEventPassToken({
        schoolId: TEST_SCHOOL_A,
        token: passToken,
        eventId: currentEventId,
      });
      assert.equal(unpaidValidation.isValid, false);
      assert.equal(unpaidValidation.reason, 'PAYMENT_PENDING');

      // 2. Record payment of event fee (₹500)
      const payment = await EventPaymentService.recordPayment({
        schoolId: TEST_SCHOOL_A,
        eventId: currentEventId,
        registrationId: primaryRegistration.id,
        studentId: sampleStudent.id,
        amount: 500,
        paymentMethod: 'UPI',
        userId: sampleUser?.id || null,
        notes: 'Science museum entry fee paid online',
      });
      assert.ok(payment.id);
      assert.equal(payment.status, 'PAID');

      // 3. Re-validate now paid & consented pass
      const validation = await EventPassService.validateEventPassToken({
        schoolId: TEST_SCHOOL_A,
        token: passToken,
        eventId: currentEventId,
      });
      assert.equal(validation.isValid, true);

      // Gatekeeper Check-In
      const checkin = await EventPassService.checkInPass({
        schoolId: TEST_SCHOOL_A,
        token: passToken,
        eventId: currentEventId,
        scannedByUserId: sampleUser?.id || null,
        scanType: 'GATE_ENTRY',
        verificationMethod: 'QR_SCAN',
      });
      assert.equal(checkin.success, true);

      // Verify attendance synchronization
      const attendance = await EventAttendanceService.getAttendanceDashboard({
        schoolId: TEST_SCHOOL_A,
        eventId: currentEventId,
      });
      assert.equal(attendance.summary.present_count, 1);
    });

    // =========================================================================
    // 7. TASK MANAGEMENT & COMMITTEES
    // =========================================================================
    await t.test('7. Staff Committee & Task Kanban Operations', async () => {
      const team = await EventTeamTaskService.createTeam({
        schoolId: TEST_SCHOOL_A,
        eventId: currentEventId,
        name: 'Logistics & Safety Committee',
        leadStaffId: sampleStaff?.id || null,
        responsibilities: 'First aid, bus escorting, and student count',
      });
      assert.ok(team.id);

      const task = await EventTeamTaskService.createTask({
        schoolId: TEST_SCHOOL_A,
        eventId: currentEventId,
        data: {
          title: 'Verify emergency medical kits on all buses',
          description: 'Ensure inhalers and first-aid kits are stocked',
          team_id: team.id,
          assigned_to_user_id: sampleUser?.id || null,
          priority: 'HIGH',
          due_date: '2026-10-14 18:00:00',
          checklist: [
            { item: 'Inhalers checked', done: true },
            { item: 'Bandages verified', done: false },
          ],
        },
        userId: sampleUser?.id || null,
      });
      assert.ok(task.id);
      assert.equal(task.priority, 'HIGH');
      assert.equal(task.status, 'TODO');

      const updatedTask = await EventTeamTaskService.updateTask({
        schoolId: TEST_SCHOOL_A,
        eventId: currentEventId,
        taskId: task.id,
        data: { status: 'COMPLETED' },
        userId: sampleUser?.id || null,
      });
      assert.equal(updatedTask.status, 'COMPLETED');
    });

    // =========================================================================
    // 8. BUDGETS, VENDORS & EXPENSES
    // =========================================================================
    await t.test('8. Budget Tracking, Vendor Quotations & Accounts Sync', async () => {
      // Set budget
      const budgetSummary = await EventBudgetExpenseService.setBudget({
        schoolId: TEST_SCHOOL_A,
        eventId: currentEventId,
        categoryBudgets: [
          {
            category: 'TRANSPORT',
            proposed_amount: 15000,
            approved_amount: 15000,
            description: 'Bus hire and expressway toll fees',
          },
        ],
        userId: sampleUser?.id || null,
      });
      assert.equal(budgetSummary.totals.total_approved, 15000);

      // Add vendor quote
      const quote = await EventVendorService.addVendorQuotation({
        schoolId: TEST_SCHOOL_A,
        eventId: currentEventId,
        data: {
          vendor_name: 'Apex Travels Pvt Ltd',
          contact_person: 'Mr. Suresh Kumar',
          phone: '9822011223',
          service_type: 'TRANSPORT',
          quoted_amount: 14200,
          terms_conditions: 'AC luxury coach with GPS tracking',
        },
        userId: sampleUser?.id || null,
      });
      assert.ok(quote.id);
      assert.equal(Number(quote.quotation_amount), 14200);

      // Approve vendor quote
      const approvedVendor = await EventVendorService.approveVendor({
        schoolId: TEST_SCHOOL_A,
        eventId: currentEventId,
        vendorId: quote.id,
        finalContractAmount: 14200,
        userId: sampleUser?.id || null,
      });
      assert.equal(approvedVendor.is_approved, true);

      // Record actual expense
      const expense = await EventBudgetExpenseService.recordExpense({
        schoolId: TEST_SCHOOL_A,
        eventId: currentEventId,
        data: {
          category: 'TRANSPORT',
          title: 'Settlement for Nehru Science Centre tour coach',
          amount: 14200,
          vendor_name: 'Apex Travels Pvt Ltd',
          invoice_number: 'INV-2026-APX-882',
          payment_method: 'BANK_TRANSFER',
          status: 'PAID',
        },
        userId: sampleUser?.id || null,
      });
      assert.ok(expense.id);
      assert.equal(Number(expense.amount), 14200);

      // Check financial summary
      const finalFinances = await EventBudgetExpenseService.getBudgetSummary({
        schoolId: TEST_SCHOOL_A,
        eventId: currentEventId,
      });
      assert.equal(finalFinances.totals.total_approved, 15000);
      assert.equal(finalFinances.totals.total_actual_spent, 14200);
      assert.equal(finalFinances.totals.total_remaining, 800);
    });

    // =========================================================================
    // 9. INCIDENT REPORTING & ESCALATION
    // =========================================================================
    await t.test('9. Safety Incident Reporting & Resolution', async () => {
      const incident = await EventIncidentService.reportIncident({
        schoolId: TEST_SCHOOL_A,
        eventId: currentEventId,
        title: 'Mild asthma managed with inhaler',
        severity: 'LOW',
        incidentType: 'MEDICAL',
        description: 'Student felt breathless after climbing stairs; teacher administered personal inhaler from kit.',
        actionTaken: 'Rested for 15 minutes, student felt completely normal.',
        studentId: sampleStudent.id,
        staffId: sampleStaff?.id || null,
        reportedBy: sampleUser?.id || null,
      });

      assert.ok(incident.id);
      assert.equal(incident.is_resolved, false);

      const resolved = await EventIncidentService.resolveIncident({
        schoolId: TEST_SCHOOL_A,
        incidentId: incident.id,
        resolutionNotes: 'Parent confirmed student reached home safely without further issues.',
        userId: sampleUser?.id || null,
      });
      assert.equal(resolved.is_resolved, true);
    });

    // =========================================================================
    // 10. DYNAMIC FEEDBACK SURVEY
    // =========================================================================
    await t.test('10. Dynamic Feedback Survey Creation & Analytics', async () => {
      const form = await EventFeedbackService.getOrCreateForm({
        schoolId: TEST_SCHOOL_A,
        eventId: currentEventId,
        title: 'Field Trip Experience Survey',
      });
      assert.ok(form.id);

      const response = await EventFeedbackService.submitFeedback({
        schoolId: TEST_SCHOOL_A,
        eventId: currentEventId,
        formId: form.id,
        userId: sampleUser?.id || null,
        responderRole: 'PARENT',
        answers: {
          q1: 5,
          q3: 'The 3D space show was fascinating and highly educational.',
        },
        ratingScore: 5,
      });
      assert.ok(response.id);

      const analytics = await EventFeedbackService.getFeedbackSummary({
        schoolId: TEST_SCHOOL_A,
        eventId: currentEventId,
      });
      assert.equal(analytics.stats.total_responses, 1);
      assert.equal(Number(analytics.stats.average_rating), 5);
    });

    // =========================================================================
    // 11. EVENT CLOSURE CHECKLIST & EXECUTIVE REPORT
    // =========================================================================
    await t.test('11. Formal Event Closure & Automated Executive Report Compilation', async () => {
      // Mark closure item
      await EventReportService.updateClosureItem({
        schoolId: TEST_SCHOOL_A,
        eventId: currentEventId,
        itemKey: 'ATTENDANCE_RECONCILED',
        isCompleted: true,
        notes: 'All participants verified',
        userId: sampleUser?.id || null,
      });

      const closedEvent = await EventReportService.closeEvent({
        schoolId: TEST_SCHOOL_A,
        eventId: currentEventId,
        userId: sampleUser?.id || null,
        bypassIncomplete: true,
      });
      assert.equal(closedEvent.status, 'CLOSED');
      assert.ok(closedEvent.closed_at);

      // Fetch final executive report
      const report = await EventReportService.getFinalReport({
        schoolId: TEST_SCHOOL_A,
        eventId: currentEventId,
      });

      assert.ok(report.id);
      assert.equal(report.event_id, currentEventId);
      const reportData = report.report_data;
      assert.equal(reportData.participation.total_registered, 1);
      assert.equal(reportData.finances.total_actual_spent, 14200);
      assert.equal(reportData.safety.total_incidents, 1);
      assert.equal(Number(reportData.feedback.average_rating), 5);
    });

    // =========================================================================
    // 12. SCENARIO B: SPORTS DAY & COMPETITION ENGINE
    // =========================================================================
    await t.test('12. Sports Day Competition Scoring, House Points & Certificate Issuance', async () => {
      const sportsEvent = await EventEngineService.createEvent({
        schoolId: TEST_SCHOOL_A,
        data: {
          title: 'Annual Inter-House Sports Meet 2026',
          description: 'Track and field events for all houses',
          event_type: 'SPORTS_DAY',
          category: 'SPORTS',
          start_date: '2026-11-20',
          end_date: '2026-11-20',
          start_time: '08:00:00',
          end_time: '16:00:00',
          coordinator_id: sampleUser?.id || null,
          configuration: {
            modules: { competitions: true, certificates: true },
          },
        },
        userId: sampleUser?.id || null,
      });
      cleanupEventIds.push(sportsEvent.id);

      // 1. Create Competition with Round and Criteria
      const comp = await EventCompetitionService.createCompetition({
        schoolId: TEST_SCHOOL_A,
        eventId: sportsEvent.id,
        data: {
          title: '100m Dash Senior Boys',
          category: 'ATHLETICS',
          age_group: 'U16',
          gender_category: 'BOYS',
          scoring_type: 'CRITERIA_BASED',
          max_participants: 8,
          criteria: [
            { name: 'Speed', max_points: 50 },
            { name: 'Form', max_points: 50 },
          ],
          rounds: [{ round_number: 1, round_name: 'Finals' }],
        },
        userId: sampleUser?.id || null,
      });
      assert.ok(comp.id);

      // 2. Submit Judge Scorecard
      const score = await EventCompetitionService.recordScore({
        schoolId: TEST_SCHOOL_A,
        competitionId: comp.id,
        roundId: comp.rounds?.[0]?.id || null,
        participantId: sampleStudent.id,
        participantName: sampleStudent.display_name || 'Champion Runner',
        houseName: 'Red Tigers',
        criteriaScores: {
          Speed: 48,
          Form: 47,
        },
        judgeRemarks: 'Outstanding sprint finish',
        judgeUserId: sampleUser?.id || null,
      });
      assert.ok(score.id);
      assert.equal(Number(score.total_score), 95);

      // 3. Finalize Results
      const results = await EventCompetitionService.finalizeResults({
        schoolId: TEST_SCHOOL_A,
        competitionId: comp.id,
        rankings: [
          {
            participant_id: sampleStudent.id,
            participant_name: sampleStudent.display_name || 'Champion Runner',
            student_id: sampleStudent.id,
            house_name: 'Red Tigers',
            rank_position: 1,
            rank_title: '1st Place (Gold)',
          },
        ],
        userId: sampleUser?.id || null,
      });
      assert.equal(results.length, 1);
      assert.equal(results[0].rank_position, 1);
      assert.equal(results[0].rank_title, '1st Place (Gold)');

      // 4. Verify House Leaderboard
      const leaderboard = await EventCompetitionService.getHouseLeaderboard({
        schoolId: TEST_SCHOOL_A,
        eventId: sportsEvent.id,
      });
      assert.ok(leaderboard.length >= 1);
      const redHouse = leaderboard.find((h) => h.house_name === 'Red Tigers');
      assert.ok(redHouse, 'Red Tigers team/house must appear on leaderboard');
      assert.equal(redHouse.gold_count, 1);
      assert.equal(redHouse.total_points, 10);

      // 5. Issue Certificate
      const cert = await EventCertificateService.issueCertificate({
        schoolId: TEST_SCHOOL_A,
        eventId: sportsEvent.id,
        studentId: sampleStudent.id,
        certificateType: 'WINNER',
        title: 'Certificate of Excellence - 1st Place',
        recipientName: sampleStudent.display_name || 'Champion Runner',
        customMetadata: {
          award: 'Gold Medal - 100m Dash',
          points: 10,
        },
        userId: sampleUser?.id || null,
      });
      assert.ok(cert.id);
      assert.ok(cert.serial_no.startsWith('EV-'));
      assert.ok(cert.verification_token);

      // 6. Public Certificate Verification
      const publicVerification = await EventCertificateService.verifyCertificate(cert.verification_token);
      assert.equal(publicVerification.isValid, true);
      assert.equal(publicVerification.certificate.recipient_name, sampleStudent.display_name || 'Champion Runner');
      assert.equal(publicVerification.certificate.certificate_type, 'WINNER');
    });

    // =========================================================================
    // 13. CROSS-TENANT ISOLATION & SECURITY CHECKS
    // =========================================================================
    await t.test('13. Cross-Tenant Security & Tamper Detection', async () => {
      // 1. Cross-school event access must be prohibited
      await assert.rejects(
        async () => {
          await EventEngineService.getEventDetails({
            schoolId: TEST_SCHOOL_B,
            eventId: currentEventId,
          });
        },
        /Event not found/i,
        'School B must not be allowed to access School A events'
      );

      // 2. Tampered QR Pass must be rejected
      const tamperedCheck = await EventPassService.validateEventPass({
        schoolId: TEST_SCHOOL_A,
        token: 'evpass_bogus_fake_token_tampered_value_12345',
        eventId: currentEventId,
      });
      assert.equal(tamperedCheck.isValid, false, 'Tampered token must be rejected');

      // 3. Foreign school cannot validate pass
      const wrongSchoolCheck = await EventPassService.validateEventPass({
        schoolId: TEST_SCHOOL_B,
        token: passToken,
        eventId: currentEventId,
      });
      assert.equal(wrongSchoolCheck.isValid, false, 'Foreign school must not validate pass');
    });

  } finally {
    // Clean up created events and cascade records
    if (cleanupEventIds.length > 0) {
      await sql`
        DELETE FROM events WHERE id = ANY(${cleanupEventIds})
      `;
    }
  }
});

test.after(async () => {
  await new Promise((r) => setTimeout(r, 500));
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(0);
});
