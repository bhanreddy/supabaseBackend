import sql from '../db.js';

/**
 * Middleware to log admin actions and critical mutations
 * Captures user, action, entity, and request traceability.
 */
export const auditLogger = async (req, res, next) => {
    // Capture the original res.json to log after response is sent
    const originalJson = res.json;

    // Generate a request ID if not present (though apiClient should send one)
    const requestId = req.headers['x-request-id'] || req.headers['request-id'] || `req_${Date.now()}`;
    res.setHeader('x-request-id', requestId);
    req.requestId = requestId;

    res.json = function (data) {
        // Only log non-GET requests or admin dashboard stats (to track access)
        const isMutation = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method);
        const isAdminAction = req.path.includes('/admin/');

        if (isMutation || isAdminAction) {
            // Log in background
            logAction(req, res, data, requestId).catch(err => {
                console.error('Audit Log Error:', err);
            });
        }

        return originalJson.call(this, data);
    };

    next();
};

async function logAction(req, res, responseData, requestId) {
    // Skip logging for auth/me or login if success (privacy/noise)
    // But log failed logins for security
    if (req.path.includes('/auth/login') && res.statusCode === 200) return;
    if (req.path.includes('/auth/me')) return;

    const user = req.user; // Set by identifyUser
    const action = `${req.method} ${req.path}`;

    // Attempt to determine entity from path
    const pathParts = req.path.split('/').filter(p => p && p !== 'api' && p !== 'v1');
    const entity = pathParts[0] || 'system';
    const entityId = pathParts[1] || req.body?.id || null;

    // Sanitize body (remove passwords)
    const details = {
        params: req.params,
        query: req.query,
        body: { ...req.body },
        statusCode: res.statusCode
    };

    if (details.body.password) details.body.password = '********';

    try {
        await sql`
            INSERT INTO audit_logs (
                user_id, 
                action, 
                entity, 
                entity_id, 
                details, 
                ip_address, 
                user_agent, 
                request_id
            ) VALUES (
                ${user?.internal_id || null},
                ${action},
                ${entity},
                ${entityId ? String(entityId) : null},
                ${sql.json(details)},
                ${req.ip || req.headers['x-forwarded-for'] || null},
                ${req.headers['user-agent'] || null},
                ${requestId}
            )
        `;
    } catch (error) {
        console.error('Failed to write audit log:', error);
    }
}
