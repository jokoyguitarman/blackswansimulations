/**
 * Pure shaping and validation for Messenger and TeamChat NPC direct-message injects.
 * Database inserts live in the feed engine; this module has no Supabase import.
 */

const DM_SENDER_TYPES = new Set([
  'npc_public',
  'npc_media',
  'npc_politician',
  'npc_influencer',
  'player',
  'official_account',
]);

const DM_PLATFORMS = new Set(['facebook', 'x_twitter']);

export interface MessengerDmConfig {
  author_handle?: string | null;
  author_display_name?: string | null;
  author_type?: string | null;
  platform?: string | null;
  stakeholder_id?: string | null;
}

export interface MessengerRecipient {
  userId: string;
  handle: string;
  /** Existing thread between the sender and this player, when one is already known. */
  threadId?: string | null;
}

export interface MessengerDmRow {
  recipient_user_id: string;
  recipient_handle: string;
  sender_handle: string;
  sender_display_name: string;
  sender_type: string;
  platform: string;
  thread_id: string;
  content: string;
}

export function buildMessengerDmRows(
  inject: { content: string },
  config: MessengerDmConfig,
  recipients: readonly MessengerRecipient[],
  mintThreadId: (recipient: MessengerRecipient) => string,
): MessengerDmRow[] {
  const senderHandle = config.author_handle?.trim() ?? '';
  const senderName = senderDisplayName(config, senderHandle);
  const senderType = dmSenderType(config.author_type);
  const platform = dmPlatform(config.platform);
  const rows: MessengerDmRow[] = [];
  for (const recipient of recipients) {
    const userId = recipient.userId.trim();
    const handle = recipient.handle.trim();
    if (!userId || !handle) continue;
    const existing = recipient.threadId?.trim();
    rows.push({
      recipient_user_id: userId,
      recipient_handle: handle,
      sender_handle: senderHandle,
      sender_display_name: senderName,
      sender_type: senderType,
      platform,
      thread_id: existing || mintThreadId(recipient),
      content: inject.content,
    });
  }
  return rows;
}

export const NPC_DM_NEEDS_STAKEHOLDER = 'An npc_dm inject needs a stakeholder_id.';
export const MESSENGER_DM_NEEDS_HANDLE = 'A messenger_dm inject needs an author_handle.';

/** Null when the config is not a DM app, or the DM app has the field it requires. */
export function dmDeliveryConfigError(config: unknown): string | null {
  if (!config || typeof config !== 'object') return null;
  const record = config as { app?: unknown; stakeholder_id?: unknown; author_handle?: unknown };
  if (record.app === 'npc_dm' && !nonEmptyString(record.stakeholder_id)) {
    return NPC_DM_NEEDS_STAKEHOLDER;
  }
  if (record.app === 'messenger_dm' && !nonEmptyString(record.author_handle)) {
    return MESSENGER_DM_NEEDS_HANDLE;
  }
  return null;
}

function senderDisplayName(config: MessengerDmConfig, senderHandle: string): string {
  const name = config.author_display_name?.trim();
  if (name) return name;
  if (senderHandle) return senderHandle.replace(/^@/, '') || senderHandle;
  return 'NPC';
}

function dmSenderType(value: string | null | undefined): string {
  const trimmed = value?.trim();
  if (trimmed && DM_SENDER_TYPES.has(trimmed)) return trimmed;
  return 'npc_public';
}

function dmPlatform(value: string | null | undefined): string {
  const trimmed = value?.trim();
  if (trimmed && DM_PLATFORMS.has(trimmed)) return trimmed;
  return 'facebook';
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}
