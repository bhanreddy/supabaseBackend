import sql from '../db.js';
import { EventEngineService } from './eventEngineService.js';

export const EventVendorService = {
  async addVendorQuotation({ schoolId, eventId, data, userId }) {
    const {
      vendor_name,
      contact_person = null,
      phone = null,
      email = null,
      service_type,
      quotation_amount = data.quotation_amount ?? data.quoted_amount,
      quotation_document_url = null,
      rating = null,
      notes = null,
    } = data;

    if (!vendor_name || !service_type || quotation_amount === undefined) {
      const err = new Error('vendor_name, service_type, and quotation_amount are required');
      err.statusCode = 400;
      throw err;
    }

    const [vendor] = await sql`
      INSERT INTO event_vendors (
        school_id, event_id, vendor_name, contact_person, phone, email,
        service_type, quotation_amount, quotation_document_url, rating, notes
      ) VALUES (
        ${schoolId}, ${eventId}, ${vendor_name}, ${contact_person}, ${phone},
        ${email}, ${service_type}, ${quotation_amount}, ${quotation_document_url},
        ${rating}, ${notes}
      )
      RETURNING *
    `;

    await EventEngineService.logAudit({
      schoolId,
      eventId,
      actorUserId: userId,
      action: 'VENDOR_QUOTATION_ADDED',
      entityType: 'EVENT_VENDOR',
      entityId: vendor.id,
      details: `Added quotation from ${vendor_name} for ${service_type}: ₹${quotation_amount}`,
    });

    return vendor;
  },

  async listVendors({ schoolId, eventId, serviceType = null }) {
    return await sql`
      SELECT *
      FROM event_vendors
      WHERE event_id = ${eventId} AND school_id = ${schoolId}
        ${serviceType ? sql`AND service_type = ${serviceType}` : sql``}
      ORDER BY service_type ASC, quotation_amount ASC
    `;
  },

  /**
   * Group and compare quotations across service types
   */
  async compareQuotations({ schoolId, eventId }) {
    const vendors = await sql`
      SELECT *
      FROM event_vendors
      WHERE event_id = ${eventId} AND school_id = ${schoolId}
      ORDER BY service_type ASC, quotation_amount ASC
    `;

    const groups = {};
    for (const v of vendors) {
      if (!groups[v.service_type]) {
        groups[v.service_type] = [];
      }
      groups[v.service_type].push(v);
    }

    return Object.entries(groups).map(([serviceType, list]) => {
      const amounts = list.map((item) => Number(item.quotation_amount));
      const minAmount = Math.min(...amounts);
      const maxAmount = Math.max(...amounts);

      return {
        service_type: serviceType,
        lowest_quote: minAmount,
        highest_quote: maxAmount,
        spread: maxAmount - minAmount,
        vendors: list.map((v) => ({
          ...v,
          is_lowest: Number(v.quotation_amount) === minAmount,
        })),
      };
    });
  },

  /**
   * Approve a vendor quotation
   */
  async approveVendor({ schoolId, eventId, vendorId, finalContractAmount = null, userId }) {
    return await sql.begin(async (tx) => {
      // Un-approve previous winner for same service type
      const [targetVendor] = await tx`
        SELECT service_type, vendor_name, quotation_amount FROM event_vendors
        WHERE id = ${vendorId} AND school_id = ${schoolId}
      `;
      if (!targetVendor) {
        const err = new Error('Vendor not found');
        err.statusCode = 404;
        throw err;
      }

      await tx`
        UPDATE event_vendors
        SET is_approved = false
        WHERE event_id = ${eventId} AND service_type = ${targetVendor.service_type} AND school_id = ${schoolId}
      `;

      const [approved] = await tx`
        UPDATE event_vendors
        SET 
          is_approved = true,
          is_shortlisted = true,
          final_contract_amount = COALESCE(${finalContractAmount}, quotation_amount),
          updated_at = now()
        WHERE id = ${vendorId} AND school_id = ${schoolId}
        RETURNING *
      `;

      await EventEngineService.logAudit({
        schoolId,
        eventId,
        actorUserId: userId,
        action: 'VENDOR_APPROVED',
        entityType: 'EVENT_VENDOR',
        entityId: vendorId,
        details: `Approved vendor ${targetVendor.vendor_name} for ${targetVendor.service_type}`,
      }, tx);

      return approved;
    });
  }
};

export default EventVendorService;
