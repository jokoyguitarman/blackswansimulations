import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { logger } from '../../lib/logger.js';
import {
  contractRequired,
  type TrainerAgreementStatus,
} from '../../../shared/trainerAgreements.js';

interface GateUser {
  id: string;
  role?: string;
  /** Auth user metadata, set at sign-up. */
  metadata?: Record<string, unknown>;
}

/**
 * Whether this person has to send their signed Consultant Agreement before they can use the app.
 * The rule itself is `contractRequired`; this gathers its inputs, and only for the people it can
 * apply to, so most accounts cost no extra queries.
 *
 * It fails open: a database error returns false and is logged. The gate is a convenience that keeps
 * applicants on the form, not a permission, so an outage must not lock anyone out of the app.
 */
export async function isContractRequired(user: GateUser): Promise<boolean> {
  const signedUpAsConsultant = user.metadata?.applying_as_consultant === true;
  if (user.role === 'participant' && !signedUpAsConsultant) return false;
  if (user.role !== 'participant' && user.role !== 'trainer') return false;

  try {
    let enrolledFromConsole = false;
    if (user.role === 'trainer') {
      const { data, error } = await supabaseAdmin
        .from('trainer_billing')
        .select('enrolled_via')
        .eq('trainer_id', user.id)
        .maybeSingle();
      if (error) throw error;
      enrolledFromConsole = data?.enrolled_via === 'admin_enrollment';
      if (!enrolledFromConsole) return false;
    }

    const { data: rows, error } = await supabaseAdmin
      .from('trainer_agreements')
      .select('status')
      .eq('user_id', user.id);
    if (error) throw error;

    return contractRequired({
      role: user.role,
      signedUpAsConsultant,
      enrolledFromConsole,
      statuses: (rows ?? []).map((r) => r.status as TrainerAgreementStatus),
    });
  } catch (error) {
    logger.warn({ error, userId: user.id }, 'Could not work out whether a contract is required');
    return false;
  }
}
