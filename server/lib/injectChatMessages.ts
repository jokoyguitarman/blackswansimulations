/**
 * Pure mapping from a chat-app inject (group_chat / phone_call) to the `chat_messages` row it
 * produces. The device has no phone app, so a phone_call inject is delivered as a persisted chat
 * line from the caller; a socket-only event would reach no listener and leave nothing to reload.
 */

export interface ChatInjectConfig {
  sender_name?: string;
  author_display_name?: string;
  stakeholder_id?: string;
  from_name?: string;
  from_address?: string;
  from_number?: string;
  caller_name?: string;
  caller_display_name?: string;
  caller?: unknown;
  callback_number?: string;
  number?: string;
  caller_id?: unknown;
  /** Stable slug from delivery_config, when the author set one. */
  inject_key?: string;
}

export interface NpcChatMessage {
  sender_stakeholder_id: string;
  sender_display_name: string;
  content: string;
  type: 'text';
}

function firstString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/** Stakeholder id when authored, otherwise a stable `npc:` pseudo id keyed on the name. */
export function npcSenderStakeholderId(senderName: string, stakeholderId?: string | null): string {
  if (stakeholderId) return stakeholderId;
  const slug = senderName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `npc:${slug || 'npc'}`;
}

export function groupChatMessage(
  inject: { content: string },
  config: ChatInjectConfig,
): NpcChatMessage {
  const senderName = firstString(config.sender_name, config.author_display_name) ?? 'NPC';
  return {
    sender_stakeholder_id: npcSenderStakeholderId(senderName, config.stakeholder_id),
    sender_display_name: senderName,
    content: inject.content,
    type: 'text',
  };
}

/** At least six digits and only phone punctuation; rejects emails and free-text ids. */
export function looksLikePhoneNumber(value: string): boolean {
  return /^\+?[\d\s().-]+$/.test(value) && (value.match(/\d/g)?.length ?? 0) >= 6;
}

/**
 * Caller fields as authored across scenario generators (from_name / caller_name / caller_id …).
 * `name` is null when nothing names the caller; `caller_id` counts as a number when it looks like
 * one and as a name otherwise.
 */
export function phoneCaller(config: ChatInjectConfig): {
  name: string | null;
  number: string | null;
} {
  const callerId = firstString(config.caller_id);
  const callerIdIsNumber = callerId !== null && looksLikePhoneNumber(callerId);
  const name = firstString(
    config.from_name,
    config.caller_name,
    config.caller_display_name,
    config.caller,
    callerIdIsNumber ? null : callerId,
    config.sender_name,
    config.author_display_name,
  );
  const number =
    [
      firstString(config.from_number),
      callerIdIsNumber ? callerId : null,
      firstString(config.from_address),
      firstString(config.callback_number),
      firstString(config.number),
    ].find((v): v is string => v !== null && looksLikePhoneNumber(v)) ?? null;
  return { name, number };
}

export const UNKNOWN_CALLER = 'Unknown caller';

/**
 * Nameless callers must not share one sender. Prefer the inject id, then its
 * inject_key, then the caller number, then a stable slug of the script.
 */
export function unknownCallerStakeholderId(input: {
  injectId?: string | null;
  injectKey?: string | null;
  number?: string | null;
  title?: string | null;
  content?: string | null;
}): string {
  const injectId = firstString(input.injectId);
  if (injectId) return `npc:unknown_caller:${callerToken(injectId)}`;
  const injectKey = firstString(input.injectKey);
  if (injectKey) return `npc:unknown_caller:${callerToken(injectKey)}`;
  if (input.number && looksLikePhoneNumber(input.number)) {
    const digits = input.number.replace(/\D/g, '');
    if (digits) return `npc:unknown_caller:${digits}`;
  }
  const basis = `${input.title ?? ''}\n${input.content ?? ''}`.trim();
  return `npc:unknown_caller:${callerToken(basis || 'call')}`;
}

function callerToken(value: string): string {
  const trimmed = value.trim();
  if (/^[A-Za-z0-9_.:@+-]{1,80}$/.test(trimmed)) return trimmed;
  const slug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  return slug || 'call';
}

export function phoneCallMessage(
  inject: { title: string; content: string; id?: string | null; inject_key?: string | null },
  config: ChatInjectConfig,
): NpcChatMessage {
  const caller = phoneCaller(config);
  const number = caller.number ? ` (${caller.number})` : '';
  const header = caller.name
    ? `📞 Call from ${caller.name}${number}`
    : `📞 Incoming call${number}: ${inject.title.trim() || 'no subject'}`;
  const senderName = caller.name ?? UNKNOWN_CALLER;
  const body = inject.content.trim();
  const senderId = caller.name
    ? npcSenderStakeholderId(senderName, config.stakeholder_id)
    : config.stakeholder_id
      ? config.stakeholder_id
      : unknownCallerStakeholderId({
          injectId: inject.id,
          injectKey: firstString(inject.inject_key, config.inject_key),
          number: caller.number,
          title: inject.title,
          content: inject.content,
        });
  return {
    sender_stakeholder_id: senderId,
    sender_display_name: senderName,
    content: body ? `${header}\n\n${body}` : header,
    type: 'text',
  };
}

/**
 * Teams whose channels a scoped chat inject is written to. The players' teams that were targeted
 * by name; when none match (target resolved by function key, or org-only scope) all the players'
 * teams. Never widens beyond the targeted players' own teams.
 */
export function selectInjectTeamChannels(
  playerTeamNames: readonly string[],
  targetTeamNames: readonly string[],
): string[] {
  const teams = Array.from(new Set(playerTeamNames));
  const named = new Set(targetTeamNames.filter((t) => t !== 'all' && !t.startsWith('org:')));
  const exact = teams.filter((t) => named.has(t));
  return exact.length > 0 ? exact : teams;
}
