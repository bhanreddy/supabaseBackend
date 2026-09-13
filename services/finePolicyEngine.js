import { toZonedTime } from 'date-fns-tz';

export const CALCULATION_TYPES = Object.freeze({
  FIXED: 'FIXED',
  PER_DAY: 'PER_DAY',
  PERCENTAGE: 'PERCENTAGE',
  VARIABLE: 'VARIABLE',
});

/**
 * Validates a fine policy payload for consistent calculation values.
 */
export function validateFinePolicy(policy = {}) {
  const errors = [];
  const type = policy.calculation_type?.toUpperCase();

  if (!type || !Object.values(CALCULATION_TYPES).includes(type)) {
    errors.push(`calculation_type must be one of: ${Object.values(CALCULATION_TYPES).join(', ')}`);
  }

  if (type === CALCULATION_TYPES.FIXED) {
    const fixed = Number(policy.fixed_amount);
    if (!Number.isFinite(fixed) || fixed <= 0) {
      errors.push('fixed_amount must be greater than 0 for FIXED policies');
    }
  } else if (type === CALCULATION_TYPES.PER_DAY) {
    const perDay = Number(policy.per_day_amount);
    if (!Number.isFinite(perDay) || perDay <= 0) {
      errors.push('per_day_amount must be greater than 0 for PER_DAY policies');
    }
  } else if (type === CALCULATION_TYPES.PERCENTAGE) {
    const pct = Number(policy.percentage);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
      errors.push('percentage must be between 0 and 100 for PERCENTAGE policies');
    }
  }

  const min = policy.minimum_amount != null ? Number(policy.minimum_amount) : null;
  const max = policy.maximum_amount != null ? Number(policy.maximum_amount) : null;

  if (min != null && min < 0) {
    errors.push('minimum_amount cannot be negative');
  }
  if (max != null && max < 0) {
    errors.push('maximum_amount cannot be negative');
  }
  if (min != null && max != null && max < min) {
    errors.push('maximum_amount cannot be less than minimum_amount');
  }

  const graceDays = Number(policy.grace_days ?? 0);
  if (!Number.isInteger(graceDays) || graceDays < 0) {
    errors.push('grace_days must be a non-negative integer');
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

/**
 * Calculates days between two YYYY-MM-DD dates in the target timezone.
 */
export function calculateDaysBetween(fromDateStr, toDateStr) {
  if (!fromDateStr || !toDateStr) return 0;
  const from = new Date(fromDateStr + 'T00:00:00Z').getTime();
  const to = new Date(toDateStr + 'T00:00:00Z').getTime();
  const diffMs = to - from;
  return Math.max(0, Math.floor(diffMs / (24 * 60 * 60 * 1000)));
}

/**
 * Formats a Date object to YYYY-MM-DD in the given timezone.
 */
export function formatYmdInTimezone(date = new Date(), timezone = 'Asia/Kolkata') {
  const zoned = toZonedTime(date, timezone);
  const y = zoned.getFullYear();
  const m = String(zoned.getMonth() + 1).padStart(2, '0');
  const d = String(zoned.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Computes fine amount and calculation breakdown from policy and context.
 */
export function calculateFineAmount(policy, context = {}) {
  const {
    variable_amount,
    base_amount = 0,
    due_date,
    as_of_date,
    timezone = 'Asia/Kolkata',
  } = context;

  const type = policy?.calculation_type?.toUpperCase() || CALCULATION_TYPES.VARIABLE;
  let rawAmount = 0;
  let calculationDetails = {
    calculation_type: type,
    rate: null,
    days_overdue: 0,
    fineable_days: 0,
    grace_days: policy?.grace_days || 0,
    capped_at_max: false,
    raised_to_min: false,
  };

  switch (type) {
    case CALCULATION_TYPES.FIXED: {
      rawAmount = Number(policy.fixed_amount || 0);
      calculationDetails.rate = rawAmount;
      break;
    }

    case CALCULATION_TYPES.PER_DAY: {
      const perDay = Number(policy.per_day_amount || 0);
      const graceDays = Number(policy.grace_days || 0);
      const todayYmd = as_of_date || formatYmdInTimezone(new Date(), timezone);
      const dueYmd = due_date ? String(due_date).slice(0, 10) : todayYmd;

      const elapsedDays = calculateDaysBetween(dueYmd, todayYmd);
      const fineableDays = Math.max(0, elapsedDays - graceDays);

      rawAmount = fineableDays * perDay;
      calculationDetails = {
        ...calculationDetails,
        rate: perDay,
        due_date: dueYmd,
        as_of_date: todayYmd,
        days_overdue: elapsedDays,
        grace_days: graceDays,
        fineable_days: fineableDays,
        formula: `${perDay}/day × ${fineableDays} day${fineableDays === 1 ? '' : 's'}`,
      };
      break;
    }

    case CALCULATION_TYPES.PERCENTAGE: {
      const pct = Number(policy.percentage || 0);
      const base = Number(base_amount || 0);
      rawAmount = (base * pct) / 100;
      calculationDetails = {
        ...calculationDetails,
        rate: pct,
        base_amount: base,
        formula: `${pct}% of ₹${base.toLocaleString('en-IN')}`,
      };
      break;
    }

    case CALCULATION_TYPES.VARIABLE:
    default: {
      rawAmount = Number(variable_amount || 0);
      calculationDetails.rate = rawAmount;
      calculationDetails.formula = `Manual assessment: ₹${rawAmount.toLocaleString('en-IN')}`;
      break;
    }
  }

  // Apply maximum cap
  const max = policy?.maximum_amount != null ? Number(policy.maximum_amount) : null;
  if (max != null && rawAmount > max) {
    rawAmount = max;
    calculationDetails.capped_at_max = true;
    calculationDetails.max_cap = max;
  }

  // Apply minimum floor (only if non-zero raw fine was incurred)
  const min = policy?.minimum_amount != null ? Number(policy.minimum_amount) : null;
  if (min != null && rawAmount > 0 && rawAmount < min) {
    rawAmount = min;
    calculationDetails.raised_to_min = true;
    calculationDetails.min_floor = min;
  }

  const finalAmount = Number(Math.max(0, rawAmount).toFixed(2));

  return {
    amount: finalAmount,
    details: calculationDetails,
  };
}
