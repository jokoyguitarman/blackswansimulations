import { Router } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { logger } from '../lib/logger.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { z } from 'zod';
import { validate } from '../lib/validation.js';

const router = Router();

const updateProfileSchema = z.object({
  body: z.object({
    role: z
      .enum(['trainer', 'admin', 'defence', 'health', 'civil', 'utilities', 'intelligence', 'ngo'])
      .optional(),
    agency_name: z.string().max(100).optional(),
    full_name: z.string().max(200).optional(),
  }),
});

// Get current user profile
router.get('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.user!;

    const { data, error } = await supabaseAdmin
      .from('user_profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    if (error) {
      logger.error({ error, userId: user.id }, 'Failed to fetch profile');
      return res.status(500).json({ error: 'Failed to fetch profile' });
    }

    res.json({ data });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /profile');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update user profile (self-service)
router.patch(
  '/',
  requireAuth,
  validate(updateProfileSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      const { role, agency_name, full_name } = req.body;

      // SECURITY: role and agency are NOT self-service. They are privilege/affiliation
      // fields and must only be changed by an admin (or, for trainer/admin, an operator
      // directly in the database). This endpoint uses the service-role client, which
      // bypasses RLS, so the check must be enforced here in code.
      if ((role !== undefined || agency_name !== undefined) && user.role !== 'admin') {
        return res.status(403).json({ error: 'Not allowed to change role or agency' });
      }

      const updates: Record<string, unknown> = {};
      if (role !== undefined) updates.role = role;
      if (agency_name !== undefined) updates.agency_name = agency_name;
      if (full_name !== undefined) updates.full_name = full_name;

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'No updatable fields provided' });
      }

      const { data, error } = await supabaseAdmin
        .from('user_profiles')
        .update(updates)
        .eq('id', user.id)
        .select()
        .single();

      if (error) {
        logger.error({ error, userId: user.id }, 'Failed to update profile');
        return res.status(500).json({ error: 'Failed to update profile' });
      }

      logger.info({ userId: user.id, updates }, 'Profile updated');
      res.json({ data });
    } catch (err) {
      logger.error({ error: err }, 'Error in PATCH /profile');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

export { router as profileRouter };
