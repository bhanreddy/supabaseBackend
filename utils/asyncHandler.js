/**
 * Async Handler Wrapper
 * Eliminates try-catch boilerplate in route handlers
 */
export const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

/**
 * Global Error Handler Middleware
 * Centralizes error handling for all routes
 */
export const errorHandler = (err, req, res, next) => {
    console.error('Error:', err);

    // Handle known error types
    if (err.name === 'ValidationError') {
        return res.status(400).json({
            error: 'Validation Error',
            details: err.errors || err.message
        });
    }

    if (err.code === '23505') {
        // PostgreSQL unique violation
        return res.status(409).json({
            error: 'Duplicate Entry',
            details: err.detail || 'A record with this value already exists'
        });
    }

    if (err.code === '23503') {
        // PostgreSQL foreign key violation
        return res.status(400).json({
            error: 'Invalid Reference',
            details: err.detail || 'Referenced record does not exist'
        });
    }

    // Default to 500
    const status = err.status || err.statusCode || 500;
    res.status(status).json({
        error: err.message || 'Internal Server Error',
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    });
};
