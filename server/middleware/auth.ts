import type { Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email?: string;
    role?: string;
    agency?: string;
    metadata?: Record<string, unknown>;
  };
}

export const requireAuth = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      res.status(401).json({ error: 'Missing authorization header' });
      return;
    }

    const [, token] = authHeader.split(' ');
    if (!token) {
      res.status(401).json({ error: 'Invalid authorization header' });
      return;
    }

    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    // Get role from app_metadata first, then fallback to user_profiles table
    let userRole = (data.user.app_metadata as Record<string, unknown>)?.role as string | undefined;
    let userAgency = (data.user.app_metadata as Record<string, unknown>)?.agency as
      | string
      | undefined;

    // If role not in app_metadata, check user_profiles table
    if (!userRole) {
      const { data: profile } = await supabaseAdmin
        .from('user_profiles')
        .select('role, agency_name')
        .eq('id', data.user.id)
        .single();

      if (profile) {
        userRole = profile.role || undefined;
        userAgency = profile.agency_name || undefined;
      }
    }

    req.user = {
      id: data.user.id,
      email: data.user.email ?? undefined,
      role: userRole,
      agency: userAgency,
      metadata: data.user.user_metadata as Record<string, unknown>,
    };

    next();
  } catch (err) {
    next(err);
  }
};
