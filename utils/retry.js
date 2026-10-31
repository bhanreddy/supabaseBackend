/**
 * Retries an async function on transient network or database errors.
 * Useful for ETIMEDOUT, ECONNRESET, and connection pool timeouts.
 *
 * @param {Function} fn - The async function to execute.
 * @param {Object} options - Retry options: { retries, delayMs }.
 * @returns {Promise<any>} The result of the async function.
 */
export function isTransientError(err) {
    const status = Number(err?.status ?? err?.statusCode);
    if (status === 429 || (status >= 500 && status <= 599)) return true;
    const codes = new Set([
        'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN',
        'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET',
    ]);
    if (codes.has(err?.code) || codes.has(err?.cause?.code)) return true;
    const message = String(err?.message || '').toLowerCase();
    return err?.name === 'AbortError' || err?.name === 'AuthRetryableFetchError' ||
        ['fetch failed', 'failed to fetch', 'network', 'timeout', 'timed out', 'socket hang up']
            .some((pattern) => message.includes(pattern));
}

export async function withRetry(fn, { retries = 2, delayMs = 500 } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            if (!isTransientError(err) || attempt === retries) {
                throw err;
            }
            // Wait before retrying (with exponential backoff)
            await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
        }
    }
    throw lastError;
}
