export type ChatVariant = 'terminal' | 'whatsapp';

export type ChatKind = 'group' | 'dm' | 'npc';

export interface ChatListItem {
  /** chat_channels.id */
  id: string;
  kind: ChatKind;
  /** 'channel' → group channel; 'dm' → direct / npc_direct (what ChatInterface needs) */
  channelKind: 'channel' | 'dm';
  channelType: string;
  name: string;
  /** group: "3 members" · dm: team / role · npc: "title · organisation" */
  subtitle: string;
  functionKey: string | null;
  teamName: string | null;
  memberCount: number;
  lastMessage: string | null;
  lastSender: string | null;
  lastAt: string | null;
  unread: number;
  stakeholder?: {
    id: string;
    name: string;
    title: string;
    organisation: string;
    relationship: string;
    handle: string;
    avatar_url?: string;
  } | null;
  recipient?: { id: string; full_name: string; role: string; team_name?: string } | null;
}

export type ChatScreenState =
  | { screen: 'list' }
  | { screen: 'calls' }
  | { screen: 'conversation'; item: ChatListItem };
