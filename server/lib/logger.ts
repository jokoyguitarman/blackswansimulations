import pino from 'pino';
import { env } from '../env.js';

// Detect if running on Vercel
const isVercel = process.env.VERCEL === '1';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  // For Vercel, use a simpler format that's easier to read
  ...(isVercel && {
    formatters: {
      level: (label) => {
        return { level: label };
      },
    },
  }),
  transport:
    env.nodeEnv === 'development'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
  // Ensure logs are flushed immediately (important for serverless)
  sync: isVercel,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.token',
      '*.apiKey',
      '*.secret',
    ],
    remove: true,
  },
});
