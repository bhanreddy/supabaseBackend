/**
 * Handler registry keyed by approval_requests.type.
 * Each handler receives (payload, trx, context) and approves the request-side
 * effect atomically inside the approval transaction.
 */
export const approvalHandlers = {
  /**
   * Authorize one future partial term-fee payment. Accounts must still complete
   * the collection flow; the next matching collection consumes this approval.
   */
  fee_underpayment: async (payload) => {
    return {
      authorization: {
        student_fee_id: payload.student_fee_id,
        amount: payload.amount,
      },
    };
  },

  /**
   * Authorize the requesting accountant to reverse exactly the payment scope
   * captured in the request. Approval itself intentionally does not mutate the
   * ledger; the accountant must consume this one-time authorization.
   */
  fee_payment_deletion: async (payload) => {
    return {
      authorization: {
        scope_key: payload.scope_key,
        transaction_ids: payload.transaction_ids,
      },
    };
  },
};
