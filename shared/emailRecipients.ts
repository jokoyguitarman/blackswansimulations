/** Split a free-text recipient field on commas/semicolons into trimmed, non-empty addresses. */
export function splitAddresses(raw: string): string[] {
  return raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Case-insensitive dedupe preserving first occurrence. */
export function dedupeAddresses(addresses: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of addresses) {
    const a = raw.trim();
    if (!a) continue;
    const key = a.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

export interface ReplyableEmail {
  from_address: string;
  to_addresses: string[] | null;
  cc_addresses?: string[] | null;
  sent_by_player_id?: string | null;
}

export interface RecipientSet {
  to: string[];
  cc: string[];
}

/** Dedupe To and Cc, drop self addresses from both, drop Cc entries already in To,
 *  and promote Cc to To when To would otherwise be empty. */
export function normalizeRecipients(
  to: string[],
  cc: string[],
  selfAddresses: string[],
): RecipientSet {
  const self = new Set(selfAddresses.map((a) => a.trim().toLowerCase()).filter(Boolean));
  const outTo = dedupeAddresses(to).filter((a) => !self.has(a.toLowerCase()));
  const toKeys = new Set(outTo.map((a) => a.toLowerCase()));
  const outCc = dedupeAddresses(cc).filter(
    (a) => !self.has(a.toLowerCase()) && !toKeys.has(a.toLowerCase()),
  );
  if (outTo.length === 0 && outCc.length > 0) return { to: outCc, cc: [] };
  return { to: outTo, cc: outCc };
}

/** Recipients for Reply (`all=false`) or Reply All (`all=true`) to `email`. */
export function buildReplyRecipients(
  email: ReplyableEmail,
  opts: { all: boolean; selfAddresses: string[]; currentUserId: string | null },
): RecipientSet {
  const mine = !!opts.currentUserId && email.sent_by_player_id === opts.currentUserId;
  const origTo = email.to_addresses ?? [];
  const origCc = email.cc_addresses ?? [];
  const to = mine ? origTo : opts.all ? [email.from_address, ...origTo] : [email.from_address];
  const cc = opts.all ? origCc : [];
  // When replying to my own mail, my own from_address is a self address too.
  const self = mine ? [...opts.selfAddresses, email.from_address] : opts.selfAddresses;
  return normalizeRecipients(to, cc, self);
}
