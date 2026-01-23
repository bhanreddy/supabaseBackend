import 'dotenv/config'; // Required to load .env

const required = (key, defaultValue = undefined) => {
    // || handles both undefined and empty strings ''
    const value = process.env[key] || defaultValue;
    if (value === undefined) {
        throw new Error(`❌ Missing required environment variable: ${key}`);
    }
    return value;
};

const config = {
    port: Number(required('PORT', 3000)),
    nodeEnv: required('NODE_ENV', 'development'),
    databaseUrl: required('DATABASE_URL'),
    supabase: {
        url: required('SUPABASE_URL'),
        anonKey: required('SUPABASE_ANON_KEY'),
        serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
    },
    firebase: {
        projectId: required('FIREBASE_PROJECT_ID'),
        clientEmail: required('FIREBASE_CLIENT_EMAIL'),
        privateKey: required('FIREBASE_PRIVATE_KEY'),
    },
    auth: {
        passwordResetRedirectUrl: required('PASSWORD_RESET_REDIRECT_URL', 'http://localhost:3000/reset-password'),
    }
};

Object.freeze(config);
Object.freeze(config.supabase);
Object.freeze(config.firebase);
Object.freeze(config.auth);

export default config;