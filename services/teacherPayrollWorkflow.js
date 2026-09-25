export const WORKFLOW = ['DRAFT', 'VALIDATED', 'APPROVED', 'LOCKED', 'PAID'];

const TRANSITIONS = {
  DRAFT: ['VALIDATED'],
  VALIDATED: ['APPROVED', 'DRAFT'],
  APPROVED: ['LOCKED'],
  LOCKED: ['PAID'],
  PAID: [],
};

const PUBLISH_RANK = {
  APPROVED: 2,
  LOCKED: 3,
  PAID: 4,
};

export class PayrollWorkflowError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'PayrollWorkflowError';
    this.code = code;
  }
}

export function assertTransition(fromStatus, toStatus) {
  const allowed = TRANSITIONS[fromStatus] || [];
  if (!allowed.includes(toStatus)) {
    throw new PayrollWorkflowError(
      `Payroll cannot move from ${fromStatus} to ${toStatus}.`,
      'INVALID_TRANSITION',
    );
  }
}

export function assertCanRecalculate(status) {
  if (status !== 'DRAFT' && status !== 'VALIDATED') {
    throw new PayrollWorkflowError(
      `Payroll in ${status} cannot be recalculated. Create a reversal or supplementary payroll.`,
      'PAYROLL_IMMUTABLE',
    );
  }
}

export function isPublished(workflowStatus, publishAt) {
  const threshold = publishAt === 'APPROVED' ? 'APPROVED' : 'LOCKED';
  return (PUBLISH_RANK[workflowStatus] || 0) >= PUBLISH_RANK[threshold];
}

function hasPermission(user, permission) {
  if (!user) return false;
  if (user.roles?.includes('admin')) return true;
  return Boolean(user.permissions?.includes(permission));
}

const ACTION_PERMISSION = {
  prepare: 'payroll.prepare',
  validate: 'payroll.prepare',
  adjust: 'payroll.prepare',
  approve: 'payroll.approve',
  lock: 'payroll.approve',
  pay: 'payroll.pay',
  read: 'payroll.audit',
  approveAdjustment: 'payroll.approve',
};

export function authorizePayrollAction(user, action) {
  const permission = ACTION_PERMISSION[action];
  if (!permission || !hasPermission(user, permission)) {
    throw new PayrollWorkflowError('You do not have permission for this payroll action.', 'FORBIDDEN');
  }
}

export function canReadPayroll(user, { isSelf = false } = {}) {
  if (isSelf) return true;
  if (!user) return false;
  if (user.roles?.includes('admin')) return true;
  return Boolean(
    user.permissions?.includes('payroll.audit')
    || user.permissions?.includes('payroll.prepare')
    || user.permissions?.includes('payroll.approve')
    || user.permissions?.includes('payroll.pay')
    || user.permissions?.includes('payslip.view'),
  );
}
