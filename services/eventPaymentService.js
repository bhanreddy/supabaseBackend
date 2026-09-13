import sql from '../db.js';
import { EventEngineService } from './eventEngineService.js';

export const EventPaymentService = {
  /**
   * Record payment for an event registration
   */
  async recordPayment({
    schoolId,
    eventId,
    registrationId = null,
    studentId = null,
    payerUserId = null,
    amount,
    paymentMethod = 'CASH',
    receiptNo = null,
    gatewayReference = null,
    notes = null,
    userId = null,
  }) {
    if (!amount || amount < 0) {
      const err = new Error('Valid amount is required');
      err.statusCode = 400;
      throw err;
    }

    const generatedReceipt = receiptNo || `EV-RCP-${Date.now().toString().slice(-6)}`;

    return await sql.begin(async (tx) => {
      const [payment] = await tx`
        INSERT INTO event_payments (
          school_id, event_id, registration_id, student_id, payer_user_id,
          amount, payment_method, status, receipt_no, gateway_reference,
          paid_at, notes
        ) VALUES (
          ${schoolId}, ${eventId}, ${registrationId}, ${studentId}, ${payerUserId || userId},
          ${amount}, ${paymentMethod}, 'PAID', ${generatedReceipt}, ${gatewayReference},
          now(), ${notes}
        )
        RETURNING *
      `;

      await EventEngineService.logAudit({
        schoolId,
        eventId,
        actorUserId: userId,
        action: 'EVENT_PAYMENT_COLLECTED',
        entityType: 'EVENT_PAYMENT',
        entityId: payment.id,
        newState: { amount, paymentMethod, status: 'PAID', receiptNo: generatedReceipt },
        details: `Collected ₹${amount} via ${paymentMethod}`,
      }, tx);

      return payment;
    });
  },

  /**
   * List all event payments with student & payer details
   */
  async listPayments({ schoolId, eventId, status = null }) {
    return await sql`
      SELECT 
        pay.*,
        stud_p.display_name as student_name,
        stud.admission_no,
        cls.name as class_name,
        sec.name as section_name,
        payer_p.display_name as payer_name
      FROM event_payments pay
      LEFT JOIN students stud ON pay.student_id = stud.id
      LEFT JOIN persons stud_p ON stud.person_id = stud_p.id
      LEFT JOIN student_enrollments se ON se.student_id = stud.id AND se.school_id = ${schoolId} AND se.status = 'active' AND se.deleted_at IS NULL
      LEFT JOIN class_sections cs ON cs.id = se.class_section_id
      LEFT JOIN classes cls ON cls.id = cs.class_id
      LEFT JOIN sections sec ON sec.id = cs.section_id
      LEFT JOIN users payer_u ON pay.payer_user_id = payer_u.id
      LEFT JOIN persons payer_p ON payer_u.person_id = payer_p.id
      WHERE pay.event_id = ${eventId} AND pay.school_id = ${schoolId}
        ${status ? sql`AND pay.status = ${status}` : sql``}
      ORDER BY pay.paid_at DESC NULLS LAST, pay.created_at DESC
    `;
  },

  /**
   * Waive payment for a student
   */
  async waivePayment({ schoolId, eventId, studentId, registrationId = null, reason = 'Administrative waiver', userId }) {
    const [payment] = await sql`
      INSERT INTO event_payments (
        school_id, event_id, registration_id, student_id, payer_user_id,
        amount, payment_method, status, notes, paid_at
      ) VALUES (
        ${schoolId}, ${eventId}, ${registrationId}, ${studentId}, ${userId},
        0.00, 'WAIVED', 'WAIVED', ${reason}, now()
      )
      RETURNING *
    `;

    await EventEngineService.logAudit({
      schoolId,
      eventId,
      actorUserId: userId,
      action: 'PAYMENT_WAIVED',
      entityType: 'EVENT_PAYMENT',
      entityId: payment.id,
      details: `Waived fee for student ${studentId}: ${reason}`,
    });

    return payment;
  },

  /**
   * Refund payment
   */
  async refundPayment({ schoolId, paymentId, reason = 'Refund requested', userId }) {
    const [refunded] = await sql`
      UPDATE event_payments
      SET status = 'REFUNDED', notes = COALESCE(notes || ' | ', '') || 'Refunded: ' || ${reason}, updated_at = now()
      WHERE id = ${paymentId} AND school_id = ${schoolId}
      RETURNING *
    `;
    if (!refunded) {
      const err = new Error('Payment not found');
      err.statusCode = 404;
      throw err;
    }

    await EventEngineService.logAudit({
      schoolId,
      eventId: refunded.event_id,
      actorUserId: userId,
      action: 'PAYMENT_REFUNDED',
      entityType: 'EVENT_PAYMENT',
      entityId: paymentId,
      details: `Refunded payment of ₹${refunded.amount}: ${reason}`,
    });

    return refunded;
  }
};

export default EventPaymentService;
