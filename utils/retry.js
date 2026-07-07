/**
 * Retries an async function on transient network or database errors.
 * Useful for ETIMEDOUT, ECONNRESET, and connection pool timeouts.
 *
 * @param {Function} fn - The async function to execute.
 * @param {Object} options - Retry options: { retries, delayMs }.
 * @returns {Promise<any>} The result of the async function.
 */
export async function withRetry(fn, { retries = 2, delayMs = 500 } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            const isTransient =
                err.code === 'ETIMEDOUT' ||
                err.code === 'UND_ERR_CONNECT_TIMEOUT' ||
                err.code === 'ECONNRESET' ||
                err.code === 'ECONNREFUSED' ||
                err.message?.includes('fetch failed') ||
                err.message?.includes('Connect Timeout') ||
                err.cause?.code === 'UND_ERR_CONNECT_TIMEOUT' ||
                err.cause?.code === 'ETIMEDOUT';

            if (!isTransient || attempt === retries) {
                throw err;
            }
            // Wait before retrying (with exponential backoff)
            await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
        }
    }
    throw lastError;
}
