export const FINE_STATUSES = Object.freeze({
  DRAFT: 'DRAFT',
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  APPROVED: 'APPROVED',
  POSTED: 'POSTED',
  PARTIALLY_PAID: 'PARTIALLY_PAID',
  PAID: 'PAID',
  WAIVED: 'WAIVED',
  PARTIALLY_WAIVED: 'PARTIALLY_WAIVED',
  CANCELLED: 'CANCELLED',
  REJECTED: 'REJECTED',
  DISPUTED: 'DISPUTED',
});

export const PERMITTED_TRANSITIONS = Object.freeze({
  [FINE_STATUSES.DRAFT]: [
    FINE_STATUSES.PENDING_APPROVAL,
    FINE_STATUSES.POSTED,
    FINE_STATUSES.CANCELLED,
  ],
  [FINE_STATUSES.PENDING_APPROVAL]: [
    FINE_STATUSES.APPROVED,
    FINE_STATUSES.REJECTED,
    FINE_STATUSES.CANCELLED,
  ],
  [FINE_STATUSES.APPROVED]: [
    FINE_STATUSES.POSTED,
    FINE_STATUSES.CANCELLED,
  ],
  [FINE_STATUSES.POSTED]: [
    FINE_STATUSES.PARTIALLY_PAID,
    FINE_STATUSES.PAID,
    FINE_STATUSES.WAIVED,
    FINE_STATUSES.PARTIALLY_WAIVED,
    FINE_STATUSES.CANCELLED,
    FINE_STATUSES.DISPUTED,
  ],
  [FINE_STATUSES.PARTIALLY_PAID]: [
    FINE_STATUSES.PARTIALLY_PAID,
    FINE_STATUSES.PAID,
    FINE_STATUSES.PARTIALLY_WAIVED,
    FINE_STATUSES.WAIVED,
    FINE_STATUSES.DISPUTED,
  ],
  [FINE_STATUSES.PARTIALLY_WAIVED]: [
    FINE_STATUSES.PARTIALLY_PAID,
    FINE_STATUSES.PAID,
    FINE_STATUSES.WAIVED,
    FINE_STATUSES.DISPUTED,
  ],
  [FINE_STATUSES.DISPUTED]: [
    FINE_STATUSES.POSTED,
    FINE_STATUSES.PARTIALLY_PAID,
    FINE_STATUSES.PARTIALLY_WAIVED,
    FINE_STATUSES.WAIVED,
    FINE_STATUSES.CANCELLED,
  ],
  [FINE_STATUSES.PAID]: [],
  [FINE_STATUSES.WAIVED]: [],
  [FINE_STATUSES.CANCELLED]: [],
  [FINE_STATUSES.REJECTED]: [],
});

/**
 * Checks whether a status transition is legally permitted.
 */
export function isValidTransition(currentStatus, targetStatus) {
  const allowed = PERMITTED_TRANSITIONS[currentStatus] || [];
  return allowed.includes(targetStatus);
}

/**
 * Asserts whether a status transition is legally permitted.
 */
export function assertCanTransition(currentStatus, targetStatus) {
  const allowed = PERMITTED_TRANSITIONS[currentStatus] || [];
  if (!allowed.includes(targetStatus)) {
    const error = new Error(
      `Illegal fine status transition from '${currentStatus}' to '${targetStatus}'. Allowed: ${allowed.join(', ') || 'None (Terminal state)'}`
    );
    error.status = 400;
    error.code = 'ILLEGAL_FINE_TRANSITION';
    throw error;
  }
}

/**
 * Determines new status after a payment is applied.
 */
export function determineStatusAfterPayment(outstandingAmount) {
  const remaining = Number(outstandingAmount);
  if (remaining <= 0.005) {
    return FINE_STATUSES.PAID;
  }
  return FINE_STATUSES.PARTIALLY_PAID;
}

/**
 * Determines new status after a waiver is applied.
 */
export function determineStatusAfterWaiver(outstandingAmount) {
  const remaining = Number(outstandingAmount);
  if (remaining <= 0.005) {
    return FINE_STATUSES.WAIVED;
  }
  return FINE_STATUSES.PARTIALLY_WAIVED;
}
