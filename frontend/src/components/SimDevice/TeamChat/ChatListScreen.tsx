import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type ContactSearchResult } from '../../../lib/api';
import { useRealtime } from '../../../hooks/useRealtime';
import { useWebSocket, type WebSocketEvent } from '../../../hooks/useWebSocket';
import { useAuth } from '../../../contexts/AuthContext';
import type { ChatListItem, ChatVariant } from './types';
import { colorFor, groupIcon, initials, relativeTime } from './avatars';

interface ChatListScreenProps {
  sessionId: string;
  variant: ChatVariant;
  onOpen: (item: ChatListItem) => void;
}

const GROUP_ORDER: Record<string, number> = {
  team: 0,
  inter_agency: 1,
  command: 2,
  public: 3,
  private: 4,
  role_specific: 5,
  trainer: 6,
};

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function ChatListScreen({ sessionId, variant, onOpen }: ChatListScreenProps) {
  const isWA = variant === 'whatsapp';
  const { user } = useAuth();
  const [groups, setGroups] = useState<ChatListItem[]>([]);
  const [dms, setDms] = useState<ChatListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [contactResults, setContactResults] = useState<ContactSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const [channelsRes, dmsRes] = await Promise.all([
        api.channels.list(sessionId),
        api.channels.getDMs(sessionId),
      ]);
      const groupItems: ChatListItem[] = (channelsRes.data || [])
        .map((c) => ({
          id: c.id,
          kind: 'group' as const,
          channelKind: 'channel' as const,
          channelType: c.type,
          name: c.name,
          subtitle: `${c.member_count} member${c.member_count === 1 ? '' : 's'}`,
          functionKey: c.function_key,
          teamName: c.team_name,
          memberCount: c.member_count,
          lastMessage: c.last_message?.content ?? null,
          lastSender: c.last_message?.sender_name ?? null,
          lastAt: c.last_message?.created_at ?? null,
          unread: c.unread_count ?? 0,
        }))
        .sort((a, b) => {
          const oa = GROUP_ORDER[a.channelType] ?? 9;
          const ob = GROUP_ORDER[b.channelType] ?? 9;
          if (oa !== ob) return oa - ob;
          return a.name.localeCompare(b.name);
        });

      const dmItems: ChatListItem[] = (dmsRes.data || []).map((d) => {
        const isNpc = d.type === 'npc_direct' || !!d.stakeholder;
        const name = isNpc ? d.stakeholder?.name || 'Contact' : d.recipient?.full_name || 'Unknown';
        const subtitle = isNpc
          ? [d.stakeholder?.title, d.stakeholder?.organisation].filter(Boolean).join(' · ')
          : d.recipient?.team_name || d.recipient?.role || '';
        return {
          id: d.id,
          kind: isNpc ? ('npc' as const) : ('dm' as const),
          channelKind: 'dm' as const,
          channelType: d.type || 'direct',
          name,
          subtitle,
          functionKey: null,
          teamName: null,
          memberCount: 2,
          lastMessage: d.last_message?.content ?? null,
          lastSender: d.last_message?.sender_name ?? null,
          lastAt: d.last_message?.created_at ?? null,
          unread: d.unread_count ?? 0,
          stakeholder: d.stakeholder ?? null,
          recipient: d.recipient ?? null,
        };
      });
      dmItems.sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || ''));

      setGroups(groupItems);
      setDms(dmItems);
      setError(null);
    } catch (err) {
      console.error('[TeamChat] failed to load chats', err);
      setError('Could not load chats');
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live preview / unread updates. RLS guarantees only rows the user may read arrive here.
  const bump = useCallback(
    (payload: {
      channel_id: string;
      content: string;
      created_at: string;
      sender_id: string | null;
      sender_display_name?: string | null;
    }) => {
      const apply = (list: ChatListItem[]) =>
        list.map((item) =>
          item.id === payload.channel_id
            ? {
                ...item,
                lastMessage: payload.content,
                lastSender: payload.sender_display_name ?? null,
                lastAt: payload.created_at,
                unread:
                  payload.sender_id === user?.id ? item.unread : Math.min(99, item.unread + 1),
              }
            : item,
        );
      let known = false;
      setGroups((prev) => {
        if (prev.some((g) => g.id === payload.channel_id)) known = true;
        return apply(prev);
      });
      setDms((prev) => {
        if (prev.some((d) => d.id === payload.channel_id)) known = true;
        const next = apply(prev);
        return [...next].sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || ''));
      });
      // A new conversation we have not listed yet (e.g. someone opened a DM with us).
      setTimeout(() => {
        if (!known) void load();
      }, 0);
    },
    [load, user?.id],
  );

  useRealtime<{
    id: string;
    channel_id: string;
    session_id: string;
    sender_id: string | null;
    content: string;
    created_at: string;
    sender_display_name?: string | null;
  }>({
    table: 'chat_messages',
    onInsert: (row) => {
      if (row.session_id !== sessionId) return;
      bump(row);
    },
    enabled: !!sessionId,
  });

  useWebSocket({
    sessionId,
    eventTypes: ['message.sent'],
    onEvent: (event: WebSocketEvent) => {
      const message = event.data?.message as
        | { channel_id?: string; content?: string; created_at?: string; sender_id?: string | null }
        | undefined;
      if (message?.channel_id && message.content && message.created_at) {
        bump({
          channel_id: message.channel_id,
          content: message.content,
          created_at: message.created_at,
          sender_id: message.sender_id ?? null,
        });
      }
    },
    enabled: !!sessionId,
  });

  // Contacts search (players + visible stakeholders), debounced.
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const q = query.trim();
    if (q.length < 2) {
      setContactResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    searchTimer.current = setTimeout(async () => {
      try {
        const res = await api.contacts.search(sessionId, q);
        setContactResults(res.data || []);
      } catch {
        setContactResults([]);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [query, sessionId]);

  const q = query.trim().toLowerCase();
  const filteredGroups = useMemo(
    () => (q ? groups.filter((g) => g.name.toLowerCase().includes(q)) : groups),
    [groups, q],
  );
  const filteredDms = useMemo(
    () =>
      q
        ? dms.filter(
            (d) => d.name.toLowerCase().includes(q) || d.subtitle.toLowerCase().includes(q),
          )
        : dms,
    [dms, q],
  );
  // Contacts that already have an open conversation are shown as chats, not as new contacts.
  const openStakeholderIds = useMemo(
    () => new Set(dms.map((d) => d.stakeholder?.id).filter(Boolean) as string[]),
    [dms],
  );
  const openRecipientIds = useMemo(
    () => new Set(dms.map((d) => d.recipient?.id).filter(Boolean) as string[]),
    [dms],
  );
  const newContacts = contactResults.filter((r) =>
    r.kind === 'player' ? !openRecipientIds.has(r.id) : !openStakeholderIds.has(r.stakeholder.id),
  );

  const openContact = async (result: ContactSearchResult) => {
    const key = result.kind === 'player' ? `p:${result.id}` : `s:${result.stakeholder.id}`;
    setOpening(key);
    try {
      if (result.kind === 'player') {
        const res = await api.channels.createDM(sessionId, result.id);
        onOpen({
          id: res.data.id,
          kind: 'dm',
          channelKind: 'dm',
          channelType: 'direct',
          name: result.name,
          subtitle: result.function_key || result.team_name || '',
          functionKey: null,
          teamName: null,
          memberCount: 2,
          lastMessage: null,
          lastSender: null,
          lastAt: null,
          unread: 0,
          recipient: {
            id: result.id,
            full_name: result.name,
            role: 'player',
            team_name: result.team_name || undefined,
          },
        });
      } else {
        const res = await api.channels.createNpcDM(sessionId, result.stakeholder.id);
        onOpen({
          id: res.data.id,
          kind: 'npc',
          channelKind: 'dm',
          channelType: 'npc_direct',
          name: result.stakeholder.name,
          subtitle: [result.stakeholder.title, result.stakeholder.organisation]
            .filter(Boolean)
            .join(' · '),
          functionKey: null,
          teamName: null,
          memberCount: 2,
          lastMessage: null,
          lastSender: null,
          lastAt: null,
          unread: 0,
          stakeholder: result.stakeholder,
        });
      }
      setQuery('');
    } catch (err) {
      console.error('[TeamChat] failed to open contact', err);
      setError('Could not start that conversation');
    } finally {
      setOpening(null);
    }
  };

  // ─── styles ───────────────────────────────────────────────────────────────
  const s = {
    root: isWA
      ? 'h-full flex flex-col wa-chat-font'
      : 'h-full flex flex-col terminal-text text-ink bg-surface',
    searchWrap: isWA ? 'px-3 pt-2 pb-1' : 'px-3 pt-2 pb-1',
    search: isWA
      ? 'w-full px-4 py-2 rounded-full text-[14px] outline-none bg-wa-input text-wa-text placeholder:text-wa-text-secondary focus:ring-1 focus:ring-wa-teal/50'
      : 'w-full px-3 py-2 military-input text-sm',
    section: isWA
      ? 'px-4 pt-3 pb-1 text-[12px] font-semibold uppercase tracking-wide text-wa-teal'
      : 'px-3 pt-3 pb-1 text-xs uppercase tracking-wide text-accent',
    row: isWA
      ? 'w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-[#202C33] active:bg-[#2A3942] transition-colors'
      : 'w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-accent/10 border-b border-border',
    name: isWA ? 'text-[16px] text-wa-text truncate' : 'text-sm font-semibold truncate',
    sub: isWA ? 'text-[13px] text-wa-text-secondary truncate' : 'text-xs text-muted truncate',
    time: isWA
      ? 'text-[11px] text-wa-text-secondary flex-shrink-0'
      : 'text-[10px] text-muted flex-shrink-0',
    badge: isWA
      ? 'min-w-[20px] h-5 px-1.5 rounded-full bg-wa-teal text-white text-[11px] font-semibold flex items-center justify-center'
      : 'min-w-[20px] h-5 px-1.5 rounded-full bg-accent text-black text-[10px] font-semibold flex items-center justify-center',
    empty: isWA
      ? 'px-4 py-8 text-center text-[13px] text-wa-text-secondary'
      : 'px-3 py-6 text-center text-xs text-muted',
    divider: isWA ? 'h-px bg-[#222E35] mx-3' : 'h-px bg-border',
  };

  const Avatar = ({ item }: { item: ChatListItem }) => {
    if (item.kind === 'group') {
      return (
        <div
          className="w-12 h-12 rounded-full flex items-center justify-center flex-shrink-0 text-[22px]"
          style={{ backgroundColor: isWA ? '#2A3942' : 'rgba(255,255,255,0.06)' }}
          aria-hidden
        >
          {groupIcon(item.functionKey, item.channelType, item.name)}
        </div>
      );
    }
    if (item.stakeholder?.avatar_url) {
      return (
        <img
          src={item.stakeholder.avatar_url}
          alt=""
          className="w-12 h-12 rounded-full flex-shrink-0 object-cover"
          draggable={false}
        />
      );
    }
    return (
      <div
        className="w-12 h-12 rounded-full flex items-center justify-center flex-shrink-0 text-[15px] font-semibold text-white"
        style={{ backgroundColor: colorFor(item.name) }}
        aria-hidden
      >
        {initials(item.name)}
      </div>
    );
  };

  const Row = ({ item }: { item: ChatListItem }) => {
    const preview = item.lastMessage
      ? `${item.kind === 'group' && item.lastSender ? `${item.lastSender.split(' ')[0]}: ` : ''}${truncate(item.lastMessage, 70)}`
      : item.subtitle;
    return (
      <button className={s.row} onClick={() => onOpen(item)}>
        <Avatar item={item} />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-2">
            <span className={s.name}>{item.name}</span>
            <span className={s.time}>{relativeTime(item.lastAt)}</span>
          </div>
          <div className="flex items-center justify-between gap-2 mt-0.5">
            <span className={s.sub}>{preview}</span>
            {item.unread > 0 && (
              <span className={s.badge}>{item.unread > 99 ? '99+' : item.unread}</span>
            )}
          </div>
        </div>
      </button>
    );
  };

  return (
    <div className={s.root} style={isWA ? { backgroundColor: '#111B21' } : undefined}>
      <div className={s.searchWrap}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search chats and contacts"
          className={s.search}
          aria-label="Search chats and contacts"
        />
      </div>

      <div className="flex-1 overflow-y-auto wa-scrollbar">
        {loading ? (
          <p className={s.empty}>Loading…</p>
        ) : error ? (
          <p className={s.empty}>{error}</p>
        ) : (
          <>
            {filteredGroups.length > 0 && (
              <>
                <div className={s.section}>Groups</div>
                {filteredGroups.map((g) => (
                  <Row key={g.id} item={g} />
                ))}
              </>
            )}

            {(filteredDms.length > 0 || (!q && groups.length > 0)) && (
              <>
                <div className={s.divider} />
                <div className={s.section}>Direct</div>
                {filteredDms.length === 0 ? (
                  <p className={s.empty}>
                    {q
                      ? 'No matching conversations'
                      : 'Search a teammate or contact to start a conversation'}
                  </p>
                ) : (
                  filteredDms.map((d) => <Row key={d.id} item={d} />)
                )}
              </>
            )}

            {q.length >= 2 && (
              <>
                <div className={s.divider} />
                <div className={s.section}>Contacts</div>
                {searching && newContacts.length === 0 ? (
                  <p className={s.empty}>Searching…</p>
                ) : newContacts.length === 0 ? (
                  <p className={s.empty}>No contacts found</p>
                ) : (
                  newContacts.map((r) => {
                    const key = r.kind === 'player' ? `p:${r.id}` : `s:${r.stakeholder.id}`;
                    const name = r.kind === 'player' ? r.name : r.stakeholder.name;
                    const sub =
                      r.kind === 'player'
                        ? r.function_key || r.team_name || 'Teammate'
                        : [r.stakeholder.title, r.stakeholder.organisation]
                            .filter(Boolean)
                            .join(' · ');
                    return (
                      <button
                        key={key}
                        className={s.row}
                        disabled={opening === key}
                        onClick={() => void openContact(r)}
                      >
                        <div
                          className="w-12 h-12 rounded-full flex items-center justify-center flex-shrink-0 text-[15px] font-semibold text-white"
                          style={{ backgroundColor: colorFor(name) }}
                          aria-hidden
                        >
                          {initials(name)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <span className={s.name}>{name}</span>
                          <div className={s.sub}>
                            {r.kind === 'stakeholder' ? `${r.stakeholder.relationship} · ` : ''}
                            {sub}
                          </div>
                        </div>
                        <span className={s.time}>{opening === key ? 'Opening…' : 'Message'}</span>
                      </button>
                    );
                  })
                )}
              </>
            )}

            {!loading && groups.length === 0 && dms.length === 0 && !q && (
              <p className={s.empty}>No chats yet</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
