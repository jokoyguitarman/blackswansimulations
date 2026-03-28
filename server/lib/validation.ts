import type { Request, Response, NextFunction } from 'express';
import { z, ZodError, type ZodSchema } from 'zod';
import { logger } from './logger.js';

export const validate = (schema: ZodSchema) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const parsed = schema.parse({
        body: req.body,
        query: req.query,
        params: req.params,
      }) as {
        body?: Record<string, unknown>;
        query?: Record<string, unknown>;
        params?: Record<string, unknown>;
      };
      if (parsed.body) req.body = parsed.body;
      if (parsed.query) req.query = parsed.query as Record<string, string>;
      if (parsed.params) req.params = parsed.params as Record<string, string>;
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        logger.warn({ error: error.issues, path: req.path }, 'Validation error');
        res.status(400).json({
          error: 'Validation failed',
          details: error.issues.map((err) => ({
            field: err.path.join('.'),
            message: err.message,
          })),
        });
        return;
      }
      next(error);
    }
  };
};

// Common validation schemas
export const schemas = {
  pagination: z.object({
    query: z.object({
      page: z.coerce.number().int().positive().optional().default(1),
      limit: z.coerce.number().int().positive().max(100).optional().default(20),
    }),
  }),

  id: z.object({
    params: z.object({
      id: z.string().uuid('Invalid ID format'),
    }),
  }),
};
