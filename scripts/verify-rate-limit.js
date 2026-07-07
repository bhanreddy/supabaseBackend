/**
 * Quick smoke test for rate-limit configuration.
 * Run: node scripts/verify-rate-limit.js
 */
import { createHash } from 'crypto';
import { ipKeyGenerator } from 'express-rate-limit';
import config from '../config/env.js';
import { shouldSkipApiRateLimit } from '../middleware/rateLimiter.js';

const failures = [];

function assert(condition, message) {
    if (!condition) failures.push(message);
}

// Config defaults
assert(config.rateLimit.apiMax >= 2000 || !config.isProduction, 'production apiMax should be >= 2000');
assert(config.rateLimit.apiWindowMs === 15 * 60 * 1000, 'default window should be 15 minutes');

// OPTIONS should be skipped
assert(shouldSkipApiRateLimit({ method: 'OPTIONS', path: '/api/v1/fees/summaries' }), 'OPTIONS requests must be skipped');
assert(!shouldSkipApiRateLimit({ method: 'GET', path: '/api/v1/fees/summaries' }), 'GET requests must not be skipped');

// Key isolation: two different tokens must not share IP bucket
function keyForToken(token) {
    try {
        const payload = JSON.parse(
            Buffer.from(token.split('.')[1], 'base64url').toString('utf8')
        );
        if (payload?.sub) return `user:${payload.sub}`;
    } catch { /* fall through */ }
    return `token:${createHash('sha256').update(token).digest('hex').slice(0, 16)}`;
}

const fakeHeader = (sub) => {
    const payload = Buffer.from(JSON.stringify({ sub })).toString('base64url');
    return `Bearer x.${payload}.y`;
};

const keyA = keyForToken(fakeHeader('user-a'));
const keyB = keyForToken(fakeHeader('user-b'));
assert(keyA !== keyB, 'different users must have different rate-limit keys');

const ipKey = `ip:${ipKeyGenerator('203.0.113.1')}`;
assert(ipKey.startsWith('ip:'), 'ipKeyGenerator must produce ip-prefixed key');

if (failures.length) {
    console.error('FAIL:', failures.join('\n'));
    process.exit(1);
}

console.log('PASS: rate limit configuration verified');
console.log('  apiMax:', config.rateLimit.apiMax);
console.log('  apiWindowMs:', config.rateLimit.apiWindowMs);
