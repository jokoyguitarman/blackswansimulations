import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { readAppIntent } from '../../lib/appIntents';
import { useAuth } from '../../contexts/AuthContext';
import { useWebRTC } from '../../hooks/useWebRTC';
import { VoiceCallPanel } from '../Chat/VoiceCallPanel';
import { IncomingCallToast } from '../Chat/IncomingCallToast';
import { ChatListScreen } from './TeamChat/ChatListScreen';
import { ConversationScreen } from './TeamChat/ConversationScreen';
import { colorFor, groupIcon, initials } from './TeamChat/avatars';
import type { ChatListItem, ChatScreenState, ChatVariant } from './TeamChat/types';

/**
 * TeamChat — WhatsApp-style chat list → conversation. Shared by the phone (route
 * /device/chat, deep-linkable with ?channel=<id>) and the desktop window.
 */
export default function GroupChatApp() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const isDesktop = location.pathname.includes('/desktop');

  const [variant, setVariant] = useState<ChatVariant>('whatsapp');
  const [screen, setScreen] = useState<ChatScreenState>({ screen: 'list' });
  const [membersOpen, setMembersOpen] = useState(false);
  const [participants, setParticipants] = useState<Array<{ id: string; full_name: string }>>([]);
  const webrtc = useWebRTC(user?.id);
  const isWA = variant === 'whatsapp';

  useEffect(() => {
    if (!sessionId) return;
    api.sessions
      .get(sessionId)
      .then((res) => {
        const session = (res.data ?? res) as Record<string, unknown>;
        setVariant(session?.sim_mode === 'social_media' ? 'whatsapp' : 'terminal');
      })
      .catch(() => {});
    api.channels
      .getParticipants(sessionId)
      .then((res) => setParticipants(res.data || []))
      .catch(() => {});
  }, [sessionId]);

  // Deep link from a notification (/device/chat?channel=<id>) or from another app on the desktop
  // (Contacts → "Chat" parks an intent; see lib/appIntents).
  const [deepLinkChannel, setDeepLinkChannel] = useState<string | null>(null);
  useEffect(() => {
    const intent = readAppIntent('chat', location.search);
    if (intent?.channel) setDeepLinkChannel(intent.channel);
  }, [location.search]);
  useEffect(() => {
    if (!sessionId || !deepLinkChannel) return;
    let cancelled = false;
    (async () => {
      try {
        const [channelsRes, dmsRes] = await Promise.all([
          api.channels.list(sessionId),
          api.channels.getDMs(sessionId),
        ]);
        if (cancelled) return;
        const group = (channelsRes.data || []).find((c) => c.id === deepLinkChannel);
        if (group) {
          setScreen({
            screen: 'conversation',
            item: {
              id: group.id,
              kind: 'group',
              channelKind: 'channel',
              channelType: group.type,
              name: group.name,
              subtitle: `${group.member_count} member${group.member_count === 1 ? '' : 's'}`,
              functionKey: group.function_key,
              teamName: group.team_name,
              memberCount: group.member_count,
              lastMessage: null,
              lastSender: null,
              lastAt: null,
              unread: 0,
            },
          });
          return;
        }
        const dm = (dmsRes.data || []).find((d) => d.id === deepLinkChannel);
        if (dm) {
          const isNpc = dm.type === 'npc_direct' || !!dm.stakeholder;
          setScreen({
            screen: 'conversation',
            item: {
              id: dm.id,
              kind: isNpc ? 'npc' : 'dm',
              channelKind: 'dm',
              channelType: dm.type || 'direct',
              name: isNpc
                ? dm.stakeholder?.name || 'Contact'
                : dm.recipient?.full_name || 'Unknown',
              subtitle: isNpc
                ? [dm.stakeholder?.title, dm.stakeholder?.organisation].filter(Boolean).join(' · ')
                : dm.recipient?.team_name || dm.recipient?.role || '',
              functionKey: null,
              teamName: null,
              memberCount: 2,
              lastMessage: null,
              lastSender: null,
              lastAt: null,
              unread: 0,
              stakeholder: dm.stakeholder ?? null,
              recipient: dm.recipient ?? null,
            },
          });
        }
      } catch {
        /* stay on the list */
      } finally {
        if (!cancelled) {
          setDeepLinkChannel(null);
          // Consume the query param so back navigation does not re-open the chat.
          if (!isDesktop && location.search) navigate(location.pathname, { replace: true });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, deepLinkChannel]);

  const openItem = useCallback((item: ChatListItem) => {
    setMembersOpen(false);
    setScreen({ screen: 'conversation', item });
  }, []);

  const goList = useCallback(() => {
    setMembersOpen(false);
    setScreen({ screen: 'list' });
  }, []);

  const goHome = () => navigate(`/sim/${sessionId}/device/home`);

  // ─── header ───────────────────────────────────────────────────────────────
  const headerBg = isWA ? '#075E54' : 'var(--color-surface-2, #12151b)';
  const headerFg = isWA ? '#FFFFFF' : undefined;

  const BackButton = ({ onClick, label }: { onClick: () => void; label: string }) => (
    <button onClick={onClick} className="flex items-center ios-btn-bounce pr-1" aria-label={label}>
      <svg width="12" height="20" viewBox="0 0 12 20" fill="none">
        <path
          d="M10 2L2 10l8 8"
          stroke={isWA ? '#FFFFFF' : 'currentColor'}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );

  const renderHeader = () => {
    if (screen.screen === 'conversation') {
      const item = screen.item;
      const canShowMembers = item.kind === 'group';
      return (
        <>
          <BackButton onClick={goList} label="Back to chats" />
          <button
            className="flex items-center gap-3 flex-1 min-w-0 text-left"
            onClick={() => canShowMembers && setMembersOpen(true)}
            disabled={!canShowMembers}
            aria-label={canShowMembers ? `${item.name}, show members` : item.name}
          >
            {item.kind === 'group' ? (
              <div
                className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 text-[18px]"
                style={{ backgroundColor: isWA ? '#25D366' : 'rgba(255,255,255,0.08)' }}
                aria-hidden
              >
                {groupIcon(item.functionKey, item.channelType, item.name)}
              </div>
            ) : (
              <div
                className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 text-[13px] font-semibold text-white"
                style={{ backgroundColor: colorFor(item.name) }}
                aria-hidden
              >
                {initials(item.name)}
              </div>
            )}
            <div className="flex-1 min-w-0">
              <span
                className="font-semibold text-[16px] block truncate"
                style={{ color: headerFg }}
              >
                {item.name}
              </span>
              <p
                className="text-[12px] truncate"
                style={{ color: isWA ? 'rgba(255,255,255,0.7)' : undefined }}
              >
                {item.kind === 'group'
                  ? `${item.memberCount} member${item.memberCount === 1 ? '' : 's'} · tap for info`
                  : item.subtitle}
              </p>
            </div>
          </button>
        </>
      );
    }
    if (screen.screen === 'calls') {
      return (
        <>
          <BackButton onClick={goList} label="Back to chats" />
          <span className="font-semibold text-[16px] flex-1" style={{ color: headerFg }}>
            Calls
          </span>
        </>
      );
    }
    return (
      <>
        {!isDesktop && <BackButton onClick={goHome} label="Back home" />}
        <span className="font-semibold text-[18px] flex-1" style={{ color: headerFg }}>
          TeamChat
        </span>
        <button
          onClick={() => setScreen({ screen: 'calls' })}
          className="px-3 py-1 rounded-full text-[12px] font-medium"
          style={{
            backgroundColor: isWA ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.08)',
            color: headerFg,
          }}
        >
          {webrtc.state.isInCall ? 'In call' : 'Calls'}
        </button>
      </>
    );
  };

  if (!sessionId) return null;

  return (
    <div
      className={`h-full flex flex-col relative ${isWA ? '' : 'terminal-text text-ink'}`}
      style={{ backgroundColor: isWA ? '#0B141A' : undefined }}
    >
      <div
        className="flex items-center gap-3 px-3 flex-shrink-0"
        style={{ height: 56, backgroundColor: headerBg, color: headerFg }}
      >
        {renderHeader()}
      </div>

      {webrtc.incomingCall && (
        <IncomingCallToast
          callId={webrtc.incomingCall.callId}
          callerName={
            participants.find((p) => p.id === webrtc.incomingCall?.from)?.full_name ?? 'Unknown'
          }
          onAccept={webrtc.acceptCall}
          onReject={webrtc.rejectCall}
          variant={variant}
        />
      )}

      <div className="flex-1 min-h-0 relative">
        {screen.screen === 'list' && (
          <ChatListScreen sessionId={sessionId} variant={variant} onOpen={openItem} />
        )}
        {screen.screen === 'calls' && user && (
          <div className={`h-full overflow-y-auto p-3 ${isWA ? 'wa-chat-font' : ''}`}>
            <VoiceCallPanel sessionId={sessionId} currentUserId={user.id} variant={variant} />
          </div>
        )}
        {screen.screen === 'conversation' && (
          <div
            className="h-full"
            style={
              isWA
                ? {
                    backgroundColor: '#0B141A',
                    backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='0.03'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`,
                  }
                : undefined
            }
          >
            <ConversationScreen
              key={screen.item.id}
              sessionId={sessionId}
              variant={variant}
              item={screen.item}
              onMembersOpen={membersOpen}
              onMembersClose={() => setMembersOpen(false)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
