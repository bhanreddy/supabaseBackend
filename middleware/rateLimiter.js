/*
 * RATE LIMIT KEYING STRATEGY
 *
 * Primary key  — JWT `sub` (Supabase UID), extracted by base64-decoding the
 *   token payload without signature verification. Safe here because this key
 *   is used only for bucket isolation, never for authorization decisions.
 *   The real auth check still runs through identifyUser middleware downstream.
 *
 * Fallback key — SHA-256 hash of the raw Bearer token when decode fails, so
 *   each logged-in session keeps an independent bucket on shared school Wi-Fi.
 *   IP is used only when no Authorization header is present (login, ping).
 *
 * Why not use req.user.id? The rate limiters are mounted before identifyUser
 *   runs, so req.user is undefined at key-generation time. Decoding the token
 *   payload directly avoids re-ordering global middleware and keeps the auth
 *   layer unchanged.
 *
 * NAT / shared-WiFi safety: Users behind the same router share one public IP.
 *   IP-based keying for authenticated traffic collapses them into a single
 *   bucket. Per-user (or per-token) keying gives each staff member an
 *   independent quota regardless of network topology.
 */

import { createHash } from 'crypto';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import config from '../config/env.js';

function jwtOrIpKey(req) {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
        const token = auth.slice(7);
        try {
            const payload = JSON.parse(
                Buffer.from(token.split('.')[1], 'base64url').toString('utf8')
            );
            if (payload?.sub) return `user:${payload.sub}`;
        } catch {
            // malformed payload — fall through to token hash
        }
        // Per-session bucket — never collapse same-WiFi users into one IP bucket
        const hash = createHash('sha256').update(token).digest('hex').slice(0, 16);
        return `token:${hash}`;
    }
    return `ip:${ipKeyGenerator(req.ip)}`;
}

// 5 AI requests per minute per user (AI calls are expensive)
export const aiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    keyGenerator: jwtOrIpKey,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'AI rate limit exceeded. Try again in 1 minute.' },
});

// 10 notification/reminder dispatches per minute per user
export const notifyLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    keyGenerator: jwtOrIpKey,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Notification rate limit exceeded. Try again in a minute.' },
});

// 60 bus-location updates per minute per user (one per second cadence)
export const transportLocationLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    keyGenerator: jwtOrIpKey,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many location updates. Slow down.' },
});

export function shouldSkipApiRateLimit(req) {
    return (
        req.method === 'OPTIONS' ||
        req.path === '/api/v1/health' ||
        req.path === '/api/v1/ping'
    );
}

// Global API limiter — school-friendly defaults (2000 req / 15 min in production).
// Admin/accounts dashboards fire 3–5 parallel requests per screen; OPTIONS preflights
// on Expo Web no longer count toward the quota.
export const apiLimiter = rateLimit({
    windowMs: config.rateLimit.apiWindowMs,
    max: config.rateLimit.apiMax,
    keyGenerator: jwtOrIpKey,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
    skip: shouldSkipApiRateLimit,
});
