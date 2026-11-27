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

/** Caller fields as authored across scenario generators (from_name / caller_name / …). */
export function phoneCaller(
  inject: { title: string },
  config: ChatInjectConfig,
): { name: string; number: string | null } {
  const name =
    firstString(
      config.from_name,
      config.caller_name,
      config.caller_display_name,
      config.caller,
      config.sender_name,
      config.author_display_name,
    ) ??
    firstString(inject.title) ??
    'Unknown caller';
  const number = firstString(
    config.from_number,
    config.from_address,
    config.callback_number,
    config.number,
  );
  return { name, number };
}

export function phoneCallMessage(
  inject: { title: string; content: string },
  config: ChatInjectConfig,
): NpcChatMessage {
  const caller = phoneCaller(inject, config);
  const header = `📞 Call from ${caller.name}${caller.number ? ` (${caller.number})` : ''}`;
  const body = inject.content.trim();
  return {
    sender_stakeholder_id: npcSenderStakeholderId(caller.name, config.stakeholder_id),
    sender_display_name: caller.name,
    content: body ? `${header}\n\n${body}` : header,
    type: 'text',
  };
}
