import type { Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email?: string;
    role?: string;
    agency?: string;
    /**
     * In-game display name — `user_profiles.full_name`, the single source of truth
     * (docs/session-bugfix-spec-2026-09-20.md §10). Prefer `displayNameOf(user)` from
     * `lib/identity.ts` over reading `metadata.full_name`, which is a stale write-only cache.
     */
    displayName?: string;
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

    // The profile row is the source of truth for the in-game display name (and for role/agency
    // when app_metadata lacks them). One primary-key lookup per request.
    const { data: profile } = await supabaseAdmin
      .from('user_profiles')
      .select('role, agency_name, full_name')
      .eq('id', data.user.id)
      .maybeSingle();

    if (profile && !userRole) {
      userRole = profile.role || undefined;
      userAgency = profile.agency_name || undefined;
    }

    const metadata = data.user.user_metadata as Record<string, unknown>;
    const displayName =
      (typeof profile?.full_name === 'string' && profile.full_name.trim()) ||
      (typeof metadata?.full_name === 'string' && (metadata.full_name as string).trim()) ||
      undefined;

    req.user = {
      id: data.user.id,
      email: data.user.email ?? undefined,
      role: userRole,
      agency: userAgency,
      displayName,
      metadata,
    };

    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Restrict a route to staff (trainer or admin). Must run AFTER requireAuth so that
 * req.user is populated. Used for cost-incurring / diagnostic endpoints.
 */
export const requireStaff = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void => {
  const role = req.user?.role;
  if (role !== 'trainer' && role !== 'admin') {
    res.status(403).json({ error: 'Trainer or admin access required' });
    return;
  }
  next();
};
