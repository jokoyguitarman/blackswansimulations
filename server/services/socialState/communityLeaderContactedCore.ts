/**
 * community_leader_contacted: an email_sent whose to/cc addresses include a
 * stakeholder in a relationship the team is expected to reach. With no
 * stakeholders authored, the legacy keyword check runs on the addresses only.
 */

const LEADER_RELATIONSHIPS = new Set([
  'community',
  'partner',
  'regulator',
  'union',
  'investor',
  'client',
]);

const ADDRESS_KEYWORD =
  /leader|imam|pastor|rabbi|priest|community|interfaith|ceo|chairman|director|regulator|commissioner|spokesperson|counsel|attorney|board|stakeholder|governor|mayor|minister/i;

export interface LeaderContactAction {
  action_type: string;
  content?: string | null;
  target_id?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface LeaderContactStakeholder {
  email?: string | null;
  relationship?: string | null;
}

export function communityLeaderContactedCore(
  actions: readonly LeaderContactAction[],
  stakeholders: readonly LeaderContactStakeholder[] | null | undefined,
): boolean {
  const roster = stakeholders ?? [];
  const leaderEmails = roster
    .filter((s) => s.relationship != null && LEADER_RELATIONSHIPS.has(s.relationship) && s.email)
    .map((s) => s.email!.trim().toLowerCase());

  for (const action of actions) {
    if (action.action_type !== 'email_sent') continue;
    const addresses = addressList(action.metadata);
    if (roster.length === 0) {
      if (ADDRESS_KEYWORD.test(addresses.join(' '))) return true;
      continue;
    }
    if (
      addresses.some((addr) => leaderEmails.some((email) => addr === email || addr.includes(email)))
    ) {
      return true;
    }
  }
  return false;
}

function addressList(metadata: Record<string, unknown> | null | undefined): string[] {
  const raw = [
    ...(Array.isArray(metadata?.to_addresses) ? metadata.to_addresses : []),
    ...(Array.isArray(metadata?.cc_addresses) ? metadata.cc_addresses : []),
  ];
  return raw.map((value) => String(value).trim().toLowerCase()).filter((value) => value !== '');
}
