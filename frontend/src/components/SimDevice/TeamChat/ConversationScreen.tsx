import { useEffect, useRef, useState } from 'react';
import { ChatInterface } from '../../Chat/ChatInterface';
import { api } from '../../../lib/api';
import { useRealtime } from '../../../hooks/useRealtime';
import type { ChatListItem, ChatVariant } from './types';
import { MemberSheet } from './MemberSheet';

interface ConversationScreenProps {
  sessionId: string;
  variant: ChatVariant;
  item: ChatListItem;
  onMembersOpen?: boolean;
  onMembersClose?: () => void;
}

/**
 * Message pane for one chat. The header lives in GroupChatApp (so it can own back navigation);
 * this component pins ChatInterface to the channel and keeps the read cursor current.
 */
export function ConversationScreen({
  sessionId,
  variant,
  item,
  onMembersOpen,
  onMembersClose,
}: ConversationScreenProps) {
  const markTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showMembers, setShowMembers] = useState(false);

  useEffect(() => {
    setShowMembers(!!onMembersOpen);
  }, [onMembersOpen]);

  const markRead = () => {
    if (markTimer.current) clearTimeout(markTimer.current);
    markTimer.current = setTimeout(() => {
      api.channels.markRead(item.id).catch(() => undefined);
    }, 800);
  };

  useEffect(() => {
    markRead();
    return () => {
      if (markTimer.current) clearTimeout(markTimer.current);
      api.channels.markRead(item.id).catch(() => undefined);
    };
  }, [item.id]);

  useRealtime<{ channel_id: string; session_id: string }>({
    table: 'chat_messages',
    onInsert: (row) => {
      if (row.session_id === sessionId && row.channel_id === item.id) markRead();
    },
    enabled: !!sessionId,
  });

  return (
    <div className="h-full relative flex flex-col">
      <div className="flex-1 min-h-0">
        <ChatInterface
          sessionId={sessionId}
          variant={variant}
          fixedChannelId={item.id}
          fixedChannelKind={item.channelKind}
        />
      </div>
      {showMembers && (
        <MemberSheet
          channelId={item.id}
          title={item.name}
          variant={variant}
          onClose={() => {
            setShowMembers(false);
            onMembersClose?.();
          }}
        />
      )}
    </div>
  );
}
