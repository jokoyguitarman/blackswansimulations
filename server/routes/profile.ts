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

    // Opportunistic sync after a confirmed email change: usernames default to
    // the signup email, so when the auth email has moved on, follow it (only
    // when the stored username is itself an email, i.e. was never customized).
    if (
      user.email &&
      typeof data.username === 'string' &&
      data.username.includes('@') &&
      data.username !== user.email
    ) {
      const { error: syncError } = await supabaseAdmin
        .from('user_profiles')
        .update({ username: user.email })
        .eq('id', user.id);
      if (!syncError) {
        data.username = user.email;
        logger.info({ userId: user.id }, 'Profile username synced to new auth email');
      }
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

      // SECURITY: role is NEVER self-service. Agency is self-service only for
      // trainers (it is their business identity, e.g. fixing a typo from admin
      // enrollment) - for domain-role participants it is an exercise-relevant
      // affiliation and stays admin-only. This endpoint uses the service-role
      // client, which bypasses RLS, so checks must be enforced here in code.
      if (role !== undefined && user.role !== 'admin') {
        return res.status(403).json({ error: 'Not allowed to change role' });
      }
      if (agency_name !== undefined && user.role !== 'admin' && user.role !== 'trainer') {
        return res.status(403).json({ error: 'Not allowed to change agency' });
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

/**
 * Self-service trainer signup (payment portal).
 *
 * SECURITY: this deliberately relaxes part of migration 189's posture - trainer
 * accounts are now free to create because every cost-incurring action (Warroom
 * AI steps, scenario compilation, session creation) is gated on credits, which
 * only exist after a client pays a real invoice. The endpoint is a strict
 * one-way door: only 'participant' -> 'trainer', never anything else, and it
 * can never grant 'admin' (admin remains operator-provisioned only).
 *
 * The write uses the service-role client, which the 189 anti-escalation
 * trigger intentionally trusts (auth.uid() is NULL in that context).
 */
router.post('/become-trainer', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.user!;

    const { data: profile, error: fetchError } = await supabaseAdmin
      .from('user_profiles')
      .select('id, role')
      .eq('id', user.id)
      .single();

    if (fetchError || !profile) {
      logger.error({ error: fetchError, userId: user.id }, 'Failed to load profile');
      return res.status(500).json({ error: 'Failed to load profile' });
    }

    if (profile.role === 'trainer') {
      return res.json({ data: { role: 'trainer' }, alreadyTrainer: true });
    }
    if (profile.role !== 'participant') {
      return res.status(403).json({
        error: 'Only participant accounts can be upgraded to trainer',
      });
    }

    const { error: updateError } = await supabaseAdmin
      .from('user_profiles')
      .update({ role: 'trainer' })
      .eq('id', user.id)
      .eq('role', 'participant');

    if (updateError) {
      logger.error({ error: updateError, userId: user.id }, 'Failed to upgrade to trainer');
      return res.status(500).json({ error: 'Failed to upgrade account' });
    }

    // Billing profile row (Stripe Connect onboarding starts as 'none').
    await supabaseAdmin
      .from('trainer_billing')
      .upsert({ trainer_id: user.id, onboarding_status: 'none' }, { onConflict: 'trainer_id' });

    logger.info({ userId: user.id }, 'Account upgraded to trainer (self-service)');
    res.json({ data: { role: 'trainer' } });
  } catch (err) {
    logger.error({ error: err }, 'Error in POST /profile/become-trainer');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as profileRouter };
