/**
 * Standardized API response helpers for SchoolIMS.
 * Every success response MUST echo school_id in the envelope per multi-tenant contract.
 */

/**
 * Send success response with mandatory school_id envelope.
 * @param {import('express').Response} res - Express response object
 * @param {string} schoolId - The school_id from the request (required)
 * @param {*} data - Response payload (array, object, or primitive)
 * @param {number} [statusCode=200] - HTTP status code
 */
export const sendSuccess = (res, schoolId, data, statusCode = 200) => {
  return res.status(statusCode).json({
    success: true,
    school_id: schoolId,
    data,
  });
};

/**
 * Generic response (no school_id envelope). Use only for non-tenant routes (e.g. super-admin).
 * Tenant routes MUST use sendSuccess.
 */
export const sendResponse = (res, statusCode, data) => {
  return res.status(statusCode).json(data);
};

/**
 * Send error response. Error responses may omit school_id per contract.
 * Use for 4xx/5xx responses.
 */
export const sendError = (res, statusCode, error, details = null) => {
  const payload = { error };
  if (details) payload.details = details;
  if (res.req?.requestId) payload.requestId = res.req.requestId;
  return res.status(statusCode).json(payload);
};
