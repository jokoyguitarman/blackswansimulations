// Vercel serverless function entry point for API routes
// This file serves as a bridge between Express routes and Vercel serverless functions
// Note: WebSocket support is not available in Vercel serverless functions
// Consider using a separate service (Railway, Render, Fly.io) for WebSocket functionality

import type { VercelRequest, VercelResponse } from '@vercel/node';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { pinoHttp } from 'pino-http';
import { env } from '../server/env.js';
import { logger } from '../server/lib/logger.js';
import { healthRouter } from '../server/routes/health.js';
import { scenariosRouter } from '../server/routes/scenarios.js';
import { sessionsRouter } from '../server/routes/sessions.js';
import { channelsRouter } from '../server/routes/channels.js';
import { decisionsRouter } from '../server/routes/decisions.js';
import { resourcesRouter } from '../server/routes/resources.js';
import { injectsRouter } from '../server/routes/injects.js';
import { eventsRouter } from '../server/routes/events.js';
import { mediaRouter } from '../server/routes/media.js';
import { aarRouter } from '../server/routes/aar.js';
import { aiRouter } from '../server/routes/ai.js';
import { profileRouter } from '../server/routes/profile.js';
import { briefingRouter } from '../server/routes/briefing.js';
import { invitationsRouter } from '../server/routes/invitations.js';
import { incidentsRouter } from '../server/routes/incidents.js';
import { teamsRouter } from '../server/routes/teams.js';
import { objectivesRouter } from '../server/routes/objectives.js';
import { notificationsRouter } from '../server/routes/notifications.js';

// Create Express app
const app = express();

// Security: Helmet for security headers
app.use(
  helmet({
    contentSecurityPolicy: false, // Disable for API
    crossOriginEmbedderPolicy: false,
  }),
);

// CORS configuration
app.use(
  cors({
    origin: env.clientUrl,
    credentials: true,
  }),
);

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
});
app.use('/api/', limiter);

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Logging middleware
app.use(pinoHttp({ logger }));

// Health check
app.use('/api/health', healthRouter);

// API routes
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

// Error handling middleware
app.use((error: Error, req: express.Request, res: express.Response) => {
  logger.error({ error: error.message, stack: error.stack }, 'Request error');
  res.status(500).json({
    error: env.nodeEnv === 'production' ? 'Internal Server Error' : error.message,
  });
});

// Export as Vercel serverless function
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Convert Vercel request/response to Express-compatible format
  return new Promise((resolve) => {
    app(req as unknown as express.Request, res as unknown as express.Response, () => {
      resolve(undefined);
    });
  });
}
