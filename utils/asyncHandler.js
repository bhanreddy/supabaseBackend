/**
 * Async Handler Wrapper
 * Eliminates try-catch boilerplate in route handlers
 */
import config from '../config/env.js';
import { isSchoolEmailConflict } from './schoolEmail.js';
export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

/**
 * Global Error Handler Middleware
 * Centralizes error handling for all routes
 */
export const errorHandler = (err, req, res, next) => {
  const requestId = req.requestId || 'no-id';

  // Handle known error types
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      error: 'Validation Error',
      details: err.errors || err.message,
      requestId
    });
  }

  if (isSchoolEmailConflict(err)) {
    console.warn('School-scoped email uniqueness violation', {
      constraint: err.constraint || err.constraint_name || err.code || 'SCHOOL_EMAIL_CONFLICT'
    });

    return res.status(409).json({
      error: 'Email already registered in this school',
      requestId
    });
  }

  if (err.code === '23505') {
    // PostgreSQL unique violation — use a mapped message when a handler already set status
    if (err.status || err.statusCode) {
      return res.status(err.status || err.statusCode).json({
        error: err.message || 'Duplicate Entry',
        requestId,
      });
    }

    return res.status(409).json({
      error: 'Duplicate Entry',
      details: err.detail || 'A record with this value already exists',
      requestId
    });
  }

  if (err.code === '23503') {
    // PostgreSQL foreign key violation
    const detail = err.detail || 'Referenced record is still in use';
    return res.status(400).json({
      error: 'Cannot delete: linked records still exist',
      details: detail,
      requestId
    });
  }

  // Timetable scheduling conflicts raised by validate_timetable_entry()
  if (typeof err.message === 'string' && /^(Teacher|Room) Collision:/.test(err.message)) {
    return res.status(409).json({
      error: err.message,
      requestId
    });
  }

  // PL/pgSQL RAISE EXCEPTION 'Unauthorized: ...' (e.g. diary class_subjects check)
  if (typeof err.message === 'string' && err.message.startsWith('Unauthorized:')) {
    const detail = err.message.slice('Unauthorized:'.length).trim();
    return res.status(403).json({
      error: detail || 'Forbidden',
      requestId
    });
  }

  // Handle transient DB/network errors → 503 (so frontend can auto-retry)
  const transientCodes = ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'CONNECTION_ENDED', 'CONNECTION_CLOSED'];
  if (transientCodes.includes(err.code) || err.message?.includes('ETIMEDOUT') || err.message?.includes('Connect Timeout')) {

    return res.status(503).json({
      error: 'Service temporarily unavailable. Please retry.',
      requestId
    });
  }

  // Default to 500
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: config.nodeEnv === 'production' && status === 500 ?
    'Internal Server Error' :
    err.message || 'Internal Server Error',
    requestId,
    ...(config.nodeEnv === 'development' && { stack: err.stack })
  });
};