import pino from 'pino';
import config from '../config/env.js';

// ── Build transport for dev (pretty) vs production (raw JSON) ──
const transport = config.isProduction
  ? undefined // raw JSON in production (for log aggregators)
  : pino.transport({
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'yyyy-mm-dd HH:MM:ss.l',
        ignore: 'pid,hostname,service,env',
        messageFormat: '{msg}',
        singleLine: false,
        errorLikeObjectKeys: ['err', 'error'],
        customLevels: 'info:30,warn:40,error:50,fatal:60',
        levelFirst: true,
      },
    });

const logger = pino(
  {
    level: config.logLevel,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
        'res.headers["set-cookie"]',
      ],
      remove: true,
    },
    base: {
      service: 'supabase-backend',
      env: config.nodeEnv,
    },
  },
  transport,
);

export default logger;
