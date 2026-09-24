import { supabaseAdmin } from '../../lib/supabaseAdmin.js';

/** Roles an approved application can end in: participants are promoted, trainers left as is. */
export const PROMOTABLE_ROLES = ['participant', 'trainer'] as const;

export class PromotionBlockedError extends Error {
  constructor(readonly role: string | null) {
    super(
      role
        ? `This account has the ${role} role, which cannot be switched to trainer automatically.`
        : 'This account has no profile.',
    );
  }
}

export async function getProfileRole(userId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('user_profiles')
    .select('role')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  return (data?.role as string | undefined) ?? null;
}

/**
 * Give an approved applicant the trainer role and a billing profile. Only 'participant' becomes
 * 'trainer', never anything else; the service-role write is trusted by the migration 189
 * anti-escalation trigger. An existing billing row is left untouched so payout setup survives.
 */
export async function promoteToTrainer(userId: string): Promise<'promoted' | 'already_trainer'> {
  const role = await getProfileRole(userId);
  let outcome: 'promoted' | 'already_trainer' = 'already_trainer';

  if (role === 'participant') {
    const { data: updated, error } = await supabaseAdmin
      .from('user_profiles')
      .update({ role: 'trainer' })
      .eq('id', userId)
      .eq('role', 'participant')
      .select('id');
    if (error) throw error;
    if (!updated || updated.length === 0) {
      const now = await getProfileRole(userId);
      if (now !== 'trainer') throw new PromotionBlockedError(now);
    } else {
      outcome = 'promoted';
    }
  } else if (role !== 'trainer') {
    throw new PromotionBlockedError(role);
  }

  const { error: billingError } = await supabaseAdmin
    .from('trainer_billing')
    .upsert(
      { trainer_id: userId, onboarding_status: 'none' },
      { onConflict: 'trainer_id', ignoreDuplicates: true },
    );
  if (billingError) throw billingError;

  return outcome;
}
