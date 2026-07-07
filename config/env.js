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

const parseCsv = (value) =>
    String(value)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

const nodeEnv = required('NODE_ENV', 'development');
const isProduction = nodeEnv === 'production';

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
    },
    rateLimit: {
        apiMax: Number(optional('RATE_LIMIT_API_MAX', isProduction ? '2000' : '1000')),
        apiWindowMs: Number(optional('RATE_LIMIT_API_WINDOW_MS', String(15 * 60 * 1000))),
    },
};

Object.freeze(config);
Object.freeze(config.supabase);
Object.freeze(config.cors);
Object.freeze(config.firebase);
Object.freeze(config.auth);
Object.freeze(config.rateLimit);
Object.freeze(config.paperforge);

/**
 * Whether the PaperForge integration is configured. When the engine URL env var
 * (PAPERFORGE_ENGINE_URL) is unset/empty, PaperForge is treated as disabled and
 * its routes short-circuit instead of attempting a call. All non-PaperForge
 * behaviour is unaffected.
 */
export const isPaperForgeEnabled = () => Boolean(config.paperforge.engineUrl);

export default config;
