import 'dotenv/config'; // Required to load .env

const required = (key, defaultValue = undefined) => {
    // || handles both undefined and empty strings ''
    const value = process.env[key] || defaultValue;
    if (value === undefined) {
        throw new Error(`❌ Missing required environment variable: ${key}`);
    }
    return value;
};

const optional = (key, defaultValue = undefined) => {
    const value = process.env[key];
    if (value === undefined || value === '') return defaultValue;
    return value;
};

const boundedNumber = (key, value, low, high) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < low || parsed > high) {
        throw new Error(`❌ ${key} must be a number between ${low} and ${high}`);
    }
    return parsed;
};

const parseCsv = (value) =>
    String(value)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

const nodeEnv = required('NODE_ENV', 'development');
const isProduction = nodeEnv === 'production';

/**
 * pg-boss needs a SESSION-mode connection (LISTEN/NOTIFY, advisory locks,
 * long-lived workers). The Supabase TRANSACTION pooler (port 6543) drops these,
 * causing "Connection terminated unexpectedly". The session pooler is the same
 * host on port 5432, so derive it when DATABASE_URL_DIRECT isn't set explicitly.
 */
const deriveSessionPoolerUrl = (url) => {
    try {
        const u = new URL(url);
        if (u.hostname.includes('pooler.supabase.com') && u.port === '6543') {
            u.port = '5432';
            return u.toString();
        }
        return url;
    } catch {
        return url;
    }
};

const config = {
    port: Number(required('PORT', 3000)),
    nodeEnv,
    isProduction,
    logLevel: optional('LOG_LEVEL', isProduction ? 'info' : 'debug'),
    bodyLimit: optional('BODY_LIMIT', '1mb'),
    databaseUrl: required('DATABASE_URL'),
    supabase: {
        url: required('SUPABASE_URL'),
        anonKey: required('SUPABASE_ANON_KEY'),
        serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
    },
    cors: {
        // In production, prefer an explicit allowlist (no '*').
        allowedOrigins: parseCsv(optional('ALLOWED_ORIGINS', isProduction ? '' : '*')),
    },
    firebase: (() => {
        const projectId = optional('FIREBASE_PROJECT_ID');
        const clientEmail = optional('FIREBASE_CLIENT_EMAIL');
        const privateKey = optional('FIREBASE_PRIVATE_KEY');

        const anyProvided = Boolean(projectId || clientEmail || privateKey);
        const enabled = anyProvided && Boolean(projectId && clientEmail && privateKey);

        if (anyProvided && !enabled) {
            throw new Error('❌ Firebase env is partially configured. Provide FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY together.');
        }

        return { enabled, projectId, clientEmail, privateKey };
    })(),
    auth: {
        passwordResetRedirectUrl: required('PASSWORD_RESET_REDIRECT_URL', 'http://localhost:3000/reset-password'),
    },
    geminiApiKey: optional('GEMINI_API_KEY'),
    openaiApiKey: optional('OPENAI_API_KEY'),
    paperforge: {
        // Internal URL of the PaperForge Engine on the private network.
        // Optional everywhere: when unset the integration is treated as
        // disabled (routes return 503) rather than failing app startup. Dev
        // defaults to localhost. Never sent to or logged for the client.
        engineUrl: optional('PAPERFORGE_ENGINE_URL', isProduction ? undefined : 'http://localhost:8000'),
        // Timeout for status/health proxy calls.
        timeoutMs: Number(optional('PAPERFORGE_TIMEOUT_MS', '30000')),
        // Longer timeout for the streamed PDF upload to /ingest.
        uploadTimeoutMs: Number(optional('PAPERFORGE_UPLOAD_TIMEOUT_MS', '120000')),
        // LLM generation and document export may take longer than status calls.
        generationTimeoutMs: Number(optional('PAPERFORGE_GENERATION_TIMEOUT_MS', '180000')),
    },
    rateLimit: {
        // Dev churns requests via hot-reload/multi-tab remounts against one
        // per-user bucket — keep it high so local testing never trips the limiter.
        apiMax: Number(optional('RATE_LIMIT_API_MAX', isProduction ? '2000' : '10000')),
        apiWindowMs: Number(optional('RATE_LIMIT_API_WINDOW_MS', String(15 * 60 * 1000))),
    },
    transportJobs: {
        enabled: optional('TRANSPORT_JOBS_ENABLED', 'true') !== 'false',
        databaseUrl: optional('DATABASE_URL_DIRECT') || deriveSessionPoolerUrl(required('DATABASE_URL')),
        historyRetentionDays: boundedNumber('TRANSPORT_HISTORY_RETENTION_DAYS', optional('TRANSPORT_HISTORY_RETENTION_DAYS', '60'), 30, 90),
        cron: optional('TRANSPORT_MAINTENANCE_CRON', '30 2 * * *'),
        timezone: optional('TRANSPORT_MAINTENANCE_TIMEZONE', 'Asia/Kolkata'),
    },
};

Object.freeze(config);
Object.freeze(config.supabase);
Object.freeze(config.cors);
Object.freeze(config.firebase);
Object.freeze(config.auth);
Object.freeze(config.rateLimit);
Object.freeze(config.transportJobs);
Object.freeze(config.paperforge);

/**
 * Whether the PaperForge integration is configured. When the engine URL env var
 * (PAPERFORGE_ENGINE_URL) is unset/empty, PaperForge is treated as disabled and
 * its routes short-circuit instead of attempting a call. All non-PaperForge
 * behaviour is unaffected.
 */
export const isPaperForgeEnabled = () => Boolean(config.paperforge.engineUrl);

export default config;
