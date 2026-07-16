import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import cors from 'cors';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { aiLimiter, authLimiter, notifyLimiter, transportLocationLimiter, apiLimiter } from './middleware/rateLimiter.js';
import config from './config/env.js';
import logger from './utils/logger.js';
// Accept self-signed certificates in local development
if (!config.isProduction) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}
import { identifyUser } from './middleware/auth.js';
import { resolveActiveContext } from './middleware/activeContext.js';
import { resolveStaffPortalAccess } from './middleware/staffPortalAccess.js';
import { requireSchoolId } from './middleware/schoolId.js';
import { auditLogger } from './middleware/audit.js';
import { errorHandler } from './utils/asyncHandler.js';
import { sendSuccess } from './utils/apiResponse.js';
import sql from './db.js';
import { startSupportNotificationOutboxWorker, stopSupportNotificationOutboxWorker } from './services/supportNotificationOutboxService.js';
import { startTransportJobs, stopTransportJobs, isTransportJobsReady } from './services/transportJobService.js';

const app = express();
const port = config.port;

// Lightweight liveness probe — exempt from all rate limiting and auth middleware
app.get('/api/v1/ping', (req, res) => res.json({ ok: true }));
app.get('/api/v1/healthz', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));
app.get('/api/v1/readyz', async (_req, res) => {
    try {
        await sql`SELECT 1`;
        if (!isTransportJobsReady()) {
            return res.status(503).json({ ok: false, database: 'connected', transport_jobs: 'starting' });
        }
        return res.json({ ok: true, database: 'connected', transport_jobs: 'ready' });
    } catch {
        return res.status(503).json({ ok: false, database: 'unavailable' });
    }
});

// Security Middleware
// Chain is: client → Cloudflare Worker (sets X-Forwarded-For = CF-Connecting-IP)
// → Cloud Run (appends its caller IP). `true` takes the leftmost XFF entry (the
// real client the Worker stamped) regardless of how many hops Cloud Run adds, so
// req.ip / rate-limit IP keying / logs reflect the actual client.
app.set('trust proxy', true);
app.use(helmet({
    // Relax cross-origin policies so browser fetch (Expo Web) can reach the API
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginOpenerPolicy: config.isProduction ? undefined : false,
    crossOriginEmbedderPolicy: config.isProduction ? undefined : false,
}));
app.disable('x-powered-by');

// Stricter rate limits for high-cost paths (run before the global /api limiter)
// Limiters are defined in middleware/rateLimiter.js with JWT-aware key generation.
app.use('/api/v1/ai', aiLimiter);
app.use('/api/v1/auth', authLimiter);
app.use('/api/v1/admin/notifications', notifyLimiter);
app.use((req, res, next) => {
    if (req.method === 'POST' && (
        req.path === '/api/v1/fees/remind' ||
        req.path === '/api/v1/defaulters/remind'
    )) {
        return notifyLimiter(req, res, next);
    }
    next();
});
app.use((req, res, next) => {
    if (req.method === 'POST' && /^\/api\/v1\/transport\/buses\/[^/]+\/locations?(?:\/batch)?\/?$/i.test(req.path)) {
        return transportLocationLimiter(req, res, next);
    }
    next();
});

// Global rate limiter — per-user (JWT) keying, falls back to IP for unauthed routes
app.use('/api/', apiLimiter);

// Structured HTTP logging + request id
app.use(pinoHttp({
    logger,
    genReqId: (req, res) => {
        const headerId = req.headers['x-request-id'] || req.headers['request-id'];
        const id = (Array.isArray(headerId) ? headerId[0] : headerId) || `req_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        res.setHeader('x-request-id', id);
        return id;
    },
    // Only log essential request info (no giant header dumps)
    serializers: {
        req(req) {
            return {
                method: req.method,
                url: req.url,
            };
        },
        res(res) {
            return {
                statusCode: res.statusCode,
            };
        },
    },
    // Custom success / error messages
    customSuccessMessage(req, res) {
        const status = res.statusCode;
        const icon = status < 300 ? '✅' : status < 400 ? '↪️' : '⛔';
        const tag  = status < 400 ? 'OK' : 'FAIL';
        const ms   = res[Symbol.for('pino-http.startTime')]
            ? `${Date.now() - res[Symbol.for('pino-http.startTime')]}ms`
            : '';
        return `${icon} ${req.method.padEnd(7)} ${status} │ ${req.url}${ms ? `  (${ms})` : ''}`;
    },
    customErrorMessage(req, res, err) {
        return `💥 ${req.method.padEnd(7)} ${res.statusCode} │ ${req.url}  ▸ ${err.message}`;
    },
    // Custom log level based on status code
    customLogLevel(req, res, err) {
        if (res.statusCode >= 500 || err) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
    },
    // Skip logging noisy health-check polls
    autoLogging: {
        ignore: (req) => req.url === '/api/v1/health',
    },
}));

// CORS - Allow all origins for mobile app (Restrict in production if possible)
app.use(cors({
    origin: (origin, cb) => {
        const allow = config.cors.allowedOrigins;
        if (!allow || allow.length === 0) {
            // Default to permissive (echo the origin back) if not configured
            return cb(null, origin || true);
        }
        if (allow.includes('*')) return cb(null, true);
        if (!origin) return cb(null, true); // server-to-server / curl
        return cb(null, allow.includes(origin));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: [
        'Content-Type',
        'Authorization',
        'authorization-refresh',
        'x-request-id',
        'Accept',
        'X-Device-Id',
        'x-device-id',
        'X-Active-Context',
        'x-active-context',
        'X-Staff-Portal-Id',
        'x-staff-portal-id',
    ],
    credentials: true,
}));

// Middleware
app.use(compression());
app.use(cookieParser());
app.use(express.json({ limit: config.bodyLimit }));

// Auth & Audit Middleware (Global)
app.use(identifyUser);
app.use(resolveActiveContext);
app.use(resolveStaffPortalAccess);
app.use(requireSchoolId);
app.use(auditLogger);


// Import routes
import authRouter from './routes/authRoutes.js';
import studentsRouter from './routes/studentsRoutes.js';
import studentDashboardRouter from './routes/studentDashboardRoutes.js';
import teachersRouter from './routes/teachersRoutes.js';
import staffRouter from './routes/staffRoutes.js';
import userRoutes from './routes/userRoutes.js';
import academicsRouter from './routes/academicsRoutes.js';
import attendanceRouter from './routes/attendanceRoutes.js';
import feesRouter from './routes/feesRoutes.js';
import resultsRouter from './routes/resultsRoutes.js';
import complaintsRouter from './routes/complaintsRoutes.js';
import noticesRouter from './routes/noticesRoutes.js';
import leavesRouter from './routes/leavesRoutes.js';
import diaryRouter from './routes/diaryRoutes.js';
import timetableRouter from './routes/timetableRoutes.js';
import transportRouter from './routes/transportRoutes.js';
import transportFeeRouter from './routes/transportFeeRoutes.js';
import transportImportRouter from './routes/transportImportRoutes.js';
import hostelRouter from './routes/hostelRoutes.js';
import eventsRouter from './routes/eventsRoutes.js';
import lmsRouter from './routes/lmsRoutes.js';
import adminRouter from './routes/adminRoutes.js';
import notificationRouter from './routes/notificationRoutes.js';
import aiRouter from './routes/aiRoutes.js';
import analyticsRouter from './routes/analyticsRoutes.js';
import adminAnalyticsRouter from './routes/adminAnalyticsRoutes.js';
import adminNotificationRoutes from './routes/adminNotificationRoutes.js';
import invoicesRouter from './routes/invoicesRoutes.js';
import expensesRouter from './routes/expensesRoutes.js';
import refundRouter from './routes/refundRoutes.js';
import approvalRouter from './routes/approvalRoutes.js';
import payrollRouter from './routes/payrollRoutes.js';
import logRouter from './routes/logRoutes.js';
import schoolSettingsRouter from './routes/schoolSettingsRoutes.js';
import schoolRouter from './routes/schoolRoutes.js';
import settingsUpiRouter from './routes/settingsUpiRoutes.js';
import referenceRouter from './routes/referenceRoutes.js';
import dcgdRouter from './routes/dcgdRoutes.js';
import contentRouter from './routes/contentRoutes.js';
import academicYearUpgradeRouter from './routes/academicYearUpgradeRoutes.js';
import defaulterRouter from './routes/defaulterRoutes.js';
import appRouter from './routes/appRoutes.js';
import paperforgeRouter from './routes/paperforge.routes.js';
import paymentRouter from './routes/paymentRoutes.js';
import meRouter from './routes/meRoutes.js';
import messagesRouter from './routes/messagesRoutes.js';
import { requireFeature } from './middleware/requireFeature.js';

// Health check endpoint (requires school_id per multi-tenant contract)
app.get('/api/v1/health', async (req, res) => {
    try {
        // Check DB connectivity
        await sql`SELECT 1`;
        sendSuccess(res, req.schoolId, {
            status: 'healthy',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            database: 'connected'
        });
    } catch (error) {
        res.status(503).json({
            status: 'unhealthy',
            timestamp: new Date().toISOString(),
            error: 'Database connection failed'
        });
    }
});

// Root route
app.get('/', (req, res) => {
    res.json({
        message: 'School Management System API',
        version: '2.0.0',
        endpoints: {
            auth: '/api/v1/auth',
            admin: '/api/v1/admin',
            students: '/api/v1/students',
            staff: '/api/v1/staff',
            users: '/api/v1/users',
            academics: '/api/v1/academics',
            attendance: '/api/v1/attendance',
            fees: '/api/v1/fees',
            results: '/api/v1/results',
            complaints: '/api/v1/complaints',
            notices: '/api/v1/notices',
            leaves: '/api/v1/leaves',
            diary: '/api/v1/diary',
            timetable: '/api/v1/timetable',
            transport: '/api/v1/transport',
            hostel: '/api/v1/hostel',
            events: '/api/v1/events',
            lms: '/api/v1/lms',
            health: '/api/v1/health',
            messages: '/api/v1/messages'
        }
    });
});

// API v1 Routes
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/students', studentsRouter);
app.use('/api/v1/student', studentDashboardRouter);
app.use('/api/v1/teachers', teachersRouter);
app.use('/api/v1/staff', staffRouter);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/academics', academicsRouter);
// Student feature flags. requireFeature() is role-scoped (gates the STUDENT role
// only) so it is safe at these shared router mounts — staff/admin/accounts pass
// through untouched. Data-bearing features whose endpoints live in a shared
// multi-purpose router (quick.science_projects on contentRouter, quick.profile,
// home.academic_advisor) are gated at the endpoint level inside those routers.
app.use('/api/v1/attendance', requireFeature('home.todays_snapshot'), attendanceRouter);
app.use('/api/v1/fees', requireFeature('nav.fees'), feesRouter);
app.use('/api/v1/results', requireFeature('nav.results'), resultsRouter);
app.use('/api/v1/complaints', requireFeature('quick.complaints'), complaintsRouter);
app.use('/api/v1/notices', requireFeature('quick.announcements'), noticesRouter);
app.use('/api/v1/leaves', leavesRouter);
app.use('/api/v1/diary', requireFeature('topbar.diary'), diaryRouter);
app.use('/api/v1/timetable', requireFeature('nav.time_table'), timetableRouter);
app.use('/api/v1/transport', requireFeature('quick.transport'), transportImportRouter);
app.use('/api/v1/transport', requireFeature('quick.transport'), transportFeeRouter);
app.use('/api/v1/transport', requireFeature('quick.transport'), transportRouter);
app.use('/api/v1/hostel', hostelRouter);
app.use('/api/v1/events', eventsRouter);
app.use('/api/v1/admin', adminRouter);
app.use('/api/v1/lms', requireFeature('topbar.lms'), lmsRouter);
app.use('/api/v1/notifications', notificationRouter);
app.use('/api/v1/ai', requireFeature('menu.ai_doubt_assist'), aiRouter);
app.use('/api/v1/analytics', analyticsRouter);
app.use('/api/v1/admin/analytics', adminAnalyticsRouter);
app.use('/api/v1/admin/notifications', adminNotificationRoutes);
app.use('/api/v1/admin/academic-year', academicYearUpgradeRouter);
app.use('/api/v1/defaulters', defaulterRouter);
app.use('/api/v1/invoices', invoicesRouter);
app.use('/api/v1/expenses', expensesRouter);
app.use('/api/v1/refunds', refundRouter);
app.use('/api/v1/approvals', approvalRouter);
app.use('/api/v1/payroll', payrollRouter);
app.use('/api/v1/log', logRouter);
app.use('/api/v1/school-settings', schoolSettingsRouter);
app.use('/api/v1/schools', schoolRouter);
app.use('/api/v1/dcgd', requireFeature('menu.dcgd'), dcgdRouter);
app.use('/api/v1/content', contentRouter);
app.use('/api/v1/settings', settingsUpiRouter);
app.use('/api/settings', settingsUpiRouter);
app.use('/api/v1/reference', referenceRouter);
app.use('/api/v1/app', appRouter);
app.use('/api/v1/me', meRouter);
app.use('/api/v1/paperforge', paperforgeRouter);
app.use('/api/v1/messages', requireFeature('comm.messenger'), messagesRouter);
// Payment Gateway (Phase 2) — credential-save path. school_id is JWT-derived
// (paths are in middleware/schoolId.js -> JWT_SCHOOL_ID_PATHS).
app.use('/api/v1/admin/payments', paymentRouter);

// Legacy routes (for backward compatibility)
app.use('/students', studentsRouter);
app.use('/teachers', teachersRouter);
app.use('/staff', staffRouter);
app.use('/users', userRoutes);
app.use('/academics', academicsRouter);

// 404 Handler
app.use((req, res) => {
    res.status(404).json({ error: 'Not Found', path: req.path });
});

// Global Error Handler
app.use((err, req, res, next) => {
    const isSchedulingConflict =
        typeof err.message === 'string' && /^(Teacher|Room) Collision:/.test(err.message);

    if (isSchedulingConflict) {
        req.log?.warn({ err: err.message }, `⛔ ${req.method} ${req.url} — scheduling conflict`);
    } else {
        req.log?.error({ err: err.message, stack: err.stack }, `❌ ${req.method} ${req.url} — Unhandled error`);
    }

    // Call the original errorHandler utility
    errorHandler(err, req, res, next);
});

// Prevent silent failures; let process manager restart in production
process.on('unhandledRejection', (reason) => {
    logger.error({ reason: reason?.message || reason }, '⚠️  Unhandled Promise Rejection');
    if (config.isProduction) process.exit(1);
});
process.on('uncaughtException', (err) => {
    logger.fatal({ err: err.message }, '💥 Uncaught Exception — shutting down');
    process.exit(1);
});

// ── ANSI helpers ─────────────────────────────────────────────────────
const c = {
    reset:   '\x1b[0m',
    bold:    '\x1b[1m',
    dim:     '\x1b[2m',
    italic:  '\x1b[3m',
    underline:'\x1b[4m',
    // Foreground
    black:   '\x1b[30m',
    red:     '\x1b[31m',
    green:   '\x1b[32m',
    yellow:  '\x1b[33m',
    blue:    '\x1b[34m',
    magenta: '\x1b[35m',
    cyan:    '\x1b[36m',
    white:   '\x1b[37m',
    gray:    '\x1b[90m',
    // Background
    bgBlack: '\x1b[40m',
    bgRed:   '\x1b[41m',
    bgGreen: '\x1b[42m',
    bgYellow:'\x1b[43m',
    bgBlue:  '\x1b[44m',
    bgMagenta:'\x1b[45m',
    bgCyan:  '\x1b[46m',
    bgWhite: '\x1b[47m',
};

const server = app.listen(port);
startSupportNotificationOutboxWorker();
setImmediate(() => startTransportJobs().catch((error) => {
    logger.error({ error }, 'Failed to start transport maintenance worker');
}));

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        logger.fatal(
            { port, err: err.message },
            `Port ${port} is already in use — another server instance may still be running. Stop it (e.g. lsof -i :${port}) and try again.`,
        );
    } else {
        logger.fatal({ port, err: err.message }, 'Failed to start HTTP server');
    }
    process.exit(1);
});

server.on('listening', async () => {
    // ── Perform DB health check FIRST (this may trigger noisy logs) ──
    let dbOk = false;
    try {
        await sql`SELECT 1`;
        dbOk = true;
    } catch (error) {
        logger.error({ error: error.message }, '❌ Database connection failed at startup');
    }

    // ── Build the entire banner in a buffer, then flush once ─────────
    const W = 60; // inner width (between the two border chars)
    const hr  = '─'.repeat(W);
    const dhr = '━'.repeat(W);

    const pad = (text, w = W) => {
        const visible = text.replace(/\x1b\[[0-9;]*m/g, ''); // strip ANSI for length
        const remaining = w - visible.length;
        const left = Math.floor(remaining / 2);
        const right = remaining - left;
        return ' '.repeat(Math.max(left, 0)) + text + ' '.repeat(Math.max(right, 0));
    };

    const row = (content) => `${c.cyan}│${c.reset}${content}${c.cyan}│${c.reset}`;

    const kvRow = (icon, label, value, valueColor = c.white) => {
        const strVal = String(value);
        const left = `  ${icon} ${c.white}${label}${c.reset}`;
        const right = `${valueColor}${c.bold}${strVal}${c.reset}`;
        // visible length of left = 2 + icon(1) + 1 + label.length = 4 + label.length
        // visible length of right = strVal.length
        const leftVisible = 4 + label.length;
        const rightVisible = strVal.length;
        const gap = W - leftVisible - rightVisible;
        return row(`${left}${' '.repeat(Math.max(gap, 1))}${right}`);
    };

    const now = new Date();
    const ts = now.toLocaleTimeString('en-GB', { hour12: false });
    const uptime = process.uptime();
    const uptimeStr = uptime < 60 ? `${uptime.toFixed(1)}s` : `${(uptime / 60).toFixed(1)}m`;

    const logo = [
        `${c.bold}${c.cyan} ███╗   ██╗███████╗██╗  ██╗${c.magenta}███████╗██╗   ██╗██████╗ ${c.yellow}██╗   ██╗███████╗${c.reset}`,
        `${c.bold}${c.cyan} ████╗  ██║██╔════╝╚██╗██╔╝${c.magenta}██╔════╝╚██╗ ██╔╝██╔══██╗${c.yellow}██║   ██║██╔════╝${c.reset}`,
        `${c.bold}${c.cyan} ██╔██╗ ██║█████╗   ╚███╔╝ ${c.magenta}███████╗ ╚████╔╝ ██████╔╝${c.yellow}██║   ██║███████╗${c.reset}`,
        `${c.bold}${c.cyan} ██║╚██╗██║██╔══╝   ██╔██╗ ${c.magenta}╚════██║  ╚██╔╝  ██╔══██╗${c.yellow}██║   ██║╚════██║${c.reset}`,
        `${c.bold}${c.cyan} ██║ ╚████║███████╗██╔╝ ██╗${c.magenta}███████║   ██║   ██║  ██║${c.yellow}╚██████╔╝███████║${c.reset}`,
        `${c.bold}${c.cyan} ╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝${c.magenta}╚══════╝   ╚═╝   ╚═╝  ╚═╝${c.yellow} ╚═════╝ ╚══════╝${c.reset}`,
    ];

    const dbIcon  = dbOk ? `${c.green}●${c.reset}` : `${c.red}●${c.reset}`;
    const dbLabel = dbOk ? 'ONLINE' : 'OFFLINE';
    const dbColor = dbOk ? c.green : c.red;
    const modeColor = config.isProduction ? c.red : c.green;

    const lines = [
        '',
        ...logo,
        `${c.dim}${'─'.repeat(76)}${c.reset}`,
        `${c.cyan}┌${hr}┐${c.reset}`,
        row(pad(`${c.bold}${c.white}v2.0.0${c.reset}  ${c.dim}·${c.reset}  ${c.gray}API Engine${c.reset}  ${c.dim}·${c.reset}  ${c.gray}${ts}${c.reset}`)),
        `${c.cyan}├${hr}┤${c.reset}`,
        row(`${' '.repeat(W)}`),
        kvRow(`${c.cyan}⬡${c.reset}`, 'PORT ·············', String(port), c.cyan),
        kvRow(`${modeColor}◆${c.reset}`, 'MODE ·············', config.nodeEnv.toUpperCase(), modeColor),
        kvRow(`${c.yellow}◈${c.reset}`, 'LOG LEVEL ········', config.logLevel.toUpperCase(), c.yellow),
        kvRow(dbIcon, 'DATABASE ·········', dbLabel, dbColor),
        kvRow(`${c.magenta}◉${c.reset}`, 'UPTIME ···········', uptimeStr, c.magenta),
        row(`${' '.repeat(W)}`),
        `${c.cyan}├${hr}┤${c.reset}`,
        row(pad(`${c.green}${c.bold}✦  SYSTEM READY  ✦${c.reset}`)),
        `${c.cyan}└${hr}┘${c.reset}`,
        '',
    ];

    // Flush the whole banner at once so nothing interrupts it
    process.stdout.write(lines.join('\n') + '\n');

    const host = '127.0.0.1';
    logger.info(
        { port, url: `http://${host}:${port}` },
        'HTTP server listening — keep this terminal open. Press Ctrl+C to stop (SIGINT).'
    );
});

server.on('close', () => {
    logger.warn('HTTP server closed (socket no longer listening)');
});

async function shutdown(signal) {
    try {
        logger.info({ signal }, 'Shutdown initiated');
        stopSupportNotificationOutboxWorker();
        await stopTransportJobs();
        server.close(() => logger.info('HTTP server closed'));
        await sql.end({ timeout: 5 });
        process.exit(0);
    } catch (err) {
        logger.error({ err }, 'Shutdown error');
        process.exit(1);
    }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
