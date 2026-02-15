import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import http from 'http';
import { pinoHttp } from 'pino-http';
import { env } from './env.js';
import { logger } from './lib/logger.js';
import { healthRouter } from './routes/health.js';
import { scenariosRouter } from './routes/scenarios.js';
import { sessionsRouter } from './routes/sessions.js';
import { channelsRouter } from './routes/channels.js';
import { decisionsRouter } from './routes/decisions.js';
import { resourcesRouter } from './routes/resources.js';
import { injectsRouter } from './routes/injects.js';
import { eventsRouter } from './routes/events.js';
import { mediaRouter } from './routes/media.js';
import { aarRouter } from './routes/aar.js';
import { aiRouter } from './routes/ai.js';
import { profileRouter } from './routes/profile.js';
import { briefingRouter } from './routes/briefing.js';
import { invitationsRouter } from './routes/invitations.js';
import { incidentsRouter } from './routes/incidents.js';
import { teamsRouter } from './routes/teams.js';
import { objectivesRouter } from './routes/objectives.js';
import { notificationsRouter } from './routes/notifications.js';
import { joinRouter } from './routes/join.js';
import { setupWebSocket } from './websocket/index.js';
import { initializeWebSocketService } from './services/websocketService.js';
import { initializeInjectScheduler } from './services/injectSchedulerService.js';
import { initializeAIInjectScheduler } from './services/aiInjectSchedulerService.js';
import jwt from 'jsonwebtoken';

const app = express();
const server = http.createServer(app);

// WebSocket server
const io = setupWebSocket(server);

// Initialize WebSocket service
initializeWebSocketService(io);

// Initialize and start inject scheduler
const injectScheduler = initializeInjectScheduler(io);
injectScheduler.start();

// Initialize and start AI inject scheduler (runs every 5 minutes)
const aiInjectScheduler = initializeAIInjectScheduler(io);
aiInjectScheduler.start();

// Security: Helmet for security headers
app.use(
  helmet({
    contentSecurityPolicy: env.nodeEnv === 'production',
    crossOriginEmbedderPolicy: env.nodeEnv === 'production',
  }),
);

// CORS configuration with origin validation
const allowedOrigins = [
  env.clientUrl,
  'http://localhost:3000',
  'http://localhost:3002',
  'http://localhost:3003',
  'http://localhost:3005',
];
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, etc.)
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        logger.warn({ origin }, 'CORS: Origin not allowed');
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);

// Per-user rate limiting - significantly increased limits
// Each authenticated user gets their own limit, preventing one user from affecting others
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: env.nodeEnv === 'production' ? 10000 : 20000, // 10k per user in prod, 20k in dev
  message: 'Too many requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  // Use user ID for authenticated requests, IP for anonymous
  keyGenerator: (req) => {
    try {
      const authHeader = req.headers.authorization;
      if (authHeader) {
        const [, token] = authHeader.split(' ');
        if (token) {
          // Decode JWT without verification (lightweight)
          // The token will be verified later by requireAuth middleware
          const decoded = jwt.decode(token) as { sub?: string } | null;
          if (decoded?.sub) {
            return `user:${decoded.sub}`;
          }
        }
      }
    } catch {
      // Fall back to IP if token parsing fails
    }
    return req.ip || req.socket.remoteAddress || 'unknown';
  },
  skip: (req) => {
    return req.path === '/health';
  },
});

app.use('/api/', limiter);

// Stricter rate limiter for join endpoints (public, abuse-prone)
const joinLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 requests per minute per IP
  message: 'Too many requests. Please try again in a moment.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || req.socket.remoteAddress || 'unknown',
});
app.use('/api/join', joinLimiter);

// Request logging (with sensitive data redaction)
app.use(pinoHttp({ logger }));

// Body parsing with size limits
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Smaller body limit for join endpoints (prevents abuse)
app.use('/api/join', express.json({ limit: '1kb' }));

// API routes
app.use('/api/health', healthRouter);
app.use('/api/scenarios', scenariosRouter);
app.use('/api/sessions', sessionsRouter);
app.use('/api/channels', channelsRouter);
app.use('/api/decisions', decisionsRouter);
app.use('/api/resources', resourcesRouter);
app.use('/api/injects', injectsRouter);
app.use('/api/events', eventsRouter);
app.use('/api/media', mediaRouter);
app.use('/api/aar', aarRouter);
app.use('/api/ai', aiRouter);
app.use('/api/profile', profileRouter);
app.use('/api/briefing', briefingRouter);
app.use('/api/invitations', invitationsRouter);
app.use('/api/incidents', incidentsRouter);
app.use('/api/teams', teamsRouter);
app.use('/api/objectives', objectivesRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/join', joinRouter);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler - sanitize errors for production
app.use((err: unknown, _req: express.Request, res: express.Response) => {
  const error = err as Error;

  // Log full error server-side
  logger.error({ error: error.message, stack: error.stack }, 'Request error');

  // Send sanitized error to client
  res.status(500).json({
    error: env.nodeEnv === 'production' ? 'Internal Server Error' : error.message,
  });
});

// WebSocket is already set up above

// Graceful shutdown
const shutdown = async () => {
  logger.info('Shutdown signal received, closing server gracefully...');

  // Stop inject schedulers
  injectScheduler.stop();
  aiInjectScheduler.stop();

  // Close HTTP server
  server.close(() => {
    logger.info('HTTP server closed');
  });

  // Close WebSocket connections
  io.close(() => {
    logger.info('WebSocket server closed');
  });

  // Give in-flight requests 10 seconds to complete
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const start = () => {
  server.listen(env.port, () => {
    logger.info(
      {
        port: env.port,
        env: env.nodeEnv,
        clientUrl: env.clientUrl,
      },
      'Server started successfully',
    );
  });
};

// Start server unless in test environment
if (import.meta.url === `file://${process.argv[1]}` || process.env.NODE_ENV !== 'test') {
  start();
}

export { app, server, io };
