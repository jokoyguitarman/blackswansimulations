import React, { useState, useEffect, useRef } from 'react';
import { supabase } from '../../lib/supabase';

const API_BASE_URL = import.meta.env.VITE_API_URL || '';

function apiUrl(path: string): string {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  if (API_BASE_URL) return `${API_BASE_URL.replace(/\/$/, '')}${cleanPath}`;
  return cleanPath;
}

async function getAuthHeaders() {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${session?.access_token || ''}`,
  };
}

interface Thread {
  thread_id: string;
  other_handle: string;
  other_display_name: string;
  other_type: string;
  last_message: string;
  last_time: string;
  unread_count: number;
}

interface Message {
  id: string;
  thread_id: string;
  sender_handle: string;
  sender_display_name: string;
  sender_type: string;
  content: string;
  created_at: string;
  is_read: boolean;
}

interface FacebookMessengerViewProps {
  sessionId: string;
}

const AVATAR_COLORS = [
  '#1877F2',
  '#42B72A',
  '#F02849',
  '#A033FF',
  '#FF6900',
  '#00A3E0',
  '#FF5C93',
  '#7B61FF',
];

function getAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = Math.max(0, now - then);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

function FacebookMessengerView({ sessionId }: FacebookMessengerViewProps) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selectedThread, setSelectedThread] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchThreads();
  }, [sessionId]);

  useEffect(() => {
    if (selectedThread) {
      fetchMessages(selectedThread);
    }
  }, [selectedThread]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function fetchThreads() {
    setLoading(true);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(
        apiUrl(`/api/social/messenger/threads/${sessionId}?platform=facebook`),
        { headers },
      );
      if (res.ok) {
        const data = await res.json();
        setThreads(data);
      }
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }

  async function fetchMessages(threadId: string) {
    setLoading(true);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(apiUrl(`/api/social/messenger/thread/${threadId}`), { headers });
      if (res.ok) {
        const data: Message[] = await res.json();
        setMessages(data);
        markUnreadAsRead(data);
      }
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }

  async function markUnreadAsRead(msgs: Message[]) {
    const headers = await getAuthHeaders();
    const unread = msgs.filter((m) => !m.is_read && m.sender_type !== 'player');
    await Promise.all(
      unread.map((m) =>
        fetch(apiUrl(`/api/social/messenger/${m.id}/read`), {
          method: 'POST',
          headers,
        }),
      ),
    );
    if (unread.length > 0) {
      setThreads((prev) =>
        prev.map((t) => (t.thread_id === selectedThread ? { ...t, unread_count: 0 } : t)),
      );
    }
  }

  async function handleSend() {
    const content = newMessage.trim();
    if (!content || !selectedThread) return;

    const thread = threads.find((t) => t.thread_id === selectedThread);
    if (!thread) return;

    setNewMessage('');
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(apiUrl('/api/social/messenger/send'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          session_id: sessionId,
          recipient_handle: thread.other_handle,
          content,
          platform: 'facebook',
        }),
      });
      if (res.ok) {
        fetchMessages(selectedThread);
        fetchThreads();
      }
    } catch {
      // silently fail
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function openThread(threadId: string) {
    setSelectedThread(threadId);
    setMessages([]);
  }

  function goBack() {
    setSelectedThread(null);
    setMessages([]);
    fetchThreads();
  }

  const activeThread = threads.find((t) => t.thread_id === selectedThread);

  if (selectedThread && activeThread) {
    return (
      <div style={styles.container}>
        {/* Chat Header */}
        <div style={styles.chatHeader}>
          <button onClick={goBack} style={styles.backButton} aria-label="Back">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#1877F2"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <div
            style={{
              ...styles.avatar,
              backgroundColor: getAvatarColor(activeThread.other_display_name),
            }}
          >
            {activeThread.other_display_name.charAt(0).toUpperCase()}
          </div>
          <span style={styles.chatHeaderName}>{activeThread.other_display_name}</span>
        </div>

        {/* Messages */}
        <div style={styles.messagesContainer}>
          {loading && messages.length === 0 && <div style={styles.loadingText}>Loading...</div>}
          {messages.map((msg) => {
            const isMine = msg.sender_type === 'player';
            return (
              <div
                key={msg.id}
                style={{
                  ...styles.messageBubbleRow,
                  justifyContent: isMine ? 'flex-end' : 'flex-start',
                }}
              >
                <div
                  style={{
                    ...styles.messageBubble,
                    backgroundColor: isMine ? '#1877F2' : '#F0F2F5',
                    color: isMine ? '#FFFFFF' : '#050505',
                    borderBottomRightRadius: isMine ? 4 : 18,
                    borderBottomLeftRadius: isMine ? 18 : 4,
                  }}
                >
                  <div style={styles.messageText}>{msg.content}</div>
                  <div
                    style={{
                      ...styles.messageTime,
                      color: isMine ? 'rgba(255,255,255,0.7)' : '#65676B',
                    }}
                  >
                    {timeAgo(msg.created_at)}
                  </div>
                </div>
              </div>
            );
          })}
          <div ref={messagesEndRef} />
        </div>

        {/* Input Bar */}
        <div style={styles.inputBar}>
          <input
            ref={inputRef}
            type="text"
            value={newMessage}
            onChange={(e) => setNewMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Aa"
            style={styles.textInput}
          />
          <button
            onClick={handleSend}
            disabled={!newMessage.trim()}
            style={{
              ...styles.sendButton,
              opacity: newMessage.trim() ? 1 : 0.4,
            }}
            aria-label="Send"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="#1877F2">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
            </svg>
          </button>
        </div>
      </div>
    );
  }

  // Thread List View
  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <span style={styles.headerTitle}>Messenger</span>
        <button style={styles.composeButton} aria-label="New message">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#1877F2"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
          </svg>
        </button>
      </div>

      {/* Thread List */}
      <div style={styles.threadList}>
        {loading && threads.length === 0 && (
          <div style={styles.loadingText}>Loading conversations...</div>
        )}
        {!loading && threads.length === 0 && (
          <div style={styles.emptyText}>No conversations yet</div>
        )}
        {threads.map((thread) => (
          <div
            key={thread.thread_id}
            style={styles.threadItem}
            onClick={() => openThread(thread.thread_id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && openThread(thread.thread_id)}
          >
            <div
              style={{
                ...styles.avatar,
                backgroundColor: getAvatarColor(thread.other_display_name),
              }}
            >
              {thread.other_display_name.charAt(0).toUpperCase()}
            </div>
            <div style={styles.threadContent}>
              <div style={styles.threadTopRow}>
                <span
                  style={{
                    ...styles.threadName,
                    fontWeight: thread.unread_count > 0 ? 700 : 400,
                  }}
                >
                  {thread.other_display_name}
                </span>
                <span style={styles.threadTime}>{timeAgo(thread.last_time)}</span>
              </div>
              <div style={styles.threadBottomRow}>
                <span
                  style={{
                    ...styles.threadPreview,
                    fontWeight: thread.unread_count > 0 ? 600 : 400,
                    color: thread.unread_count > 0 ? '#050505' : '#65676B',
                  }}
                >
                  {thread.last_message
                    ? thread.last_message.length > 50
                      ? thread.last_message.slice(0, 50) + '...'
                      : thread.last_message
                    : ''}
                </span>
                {thread.unread_count > 0 && <div style={styles.unreadDot} />}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    backgroundColor: '#FFFFFF',
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  },

  // Thread List Header
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 16px',
    borderBottom: '1px solid #E4E6EB',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: 700,
    color: '#050505',
  },
  composeButton: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: 6,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Thread List
  threadList: {
    flex: 1,
    overflowY: 'auto' as const,
  },
  threadItem: {
    display: 'flex',
    alignItems: 'center',
    padding: '10px 16px',
    cursor: 'pointer',
    gap: 12,
    transition: 'background-color 0.15s',
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: 600,
    flexShrink: 0,
  },
  threadContent: {
    flex: 1,
    minWidth: 0,
  },
  threadTopRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 2,
  },
  threadName: {
    fontSize: 14,
    color: '#050505',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  threadTime: {
    fontSize: 12,
    color: '#65676B',
    flexShrink: 0,
    marginLeft: 8,
  },
  threadBottomRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  threadPreview: {
    fontSize: 13,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    flex: 1,
  },
  unreadDot: {
    width: 10,
    height: 10,
    borderRadius: '50%',
    backgroundColor: '#1877F2',
    flexShrink: 0,
  },

  // Chat Header
  chatHeader: {
    display: 'flex',
    alignItems: 'center',
    padding: '10px 12px',
    borderBottom: '1px solid #E4E6EB',
    gap: 10,
  },
  backButton: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: 4,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  chatHeaderName: {
    fontSize: 15,
    fontWeight: 600,
    color: '#050505',
  },

  // Messages
  messagesContainer: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: '12px 12px 4px',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  messageBubbleRow: {
    display: 'flex',
    marginBottom: 2,
  },
  messageBubble: {
    maxWidth: '75%',
    padding: '8px 12px',
    borderRadius: 18,
    wordBreak: 'break-word' as const,
  },
  messageText: {
    fontSize: 14,
    lineHeight: '1.35',
  },
  messageTime: {
    fontSize: 11,
    marginTop: 2,
    textAlign: 'right' as const,
  },

  // Input Bar
  inputBar: {
    display: 'flex',
    alignItems: 'center',
    padding: '8px 12px',
    borderTop: '1px solid #E4E6EB',
    gap: 8,
  },
  textInput: {
    flex: 1,
    border: 'none',
    backgroundColor: '#F0F2F5',
    borderRadius: 20,
    padding: '8px 14px',
    fontSize: 14,
    outline: 'none',
    color: '#050505',
  },
  sendButton: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: 4,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Misc
  loadingText: {
    textAlign: 'center' as const,
    padding: 24,
    color: '#65676B',
    fontSize: 14,
  },
  emptyText: {
    textAlign: 'center' as const,
    padding: 24,
    color: '#65676B',
    fontSize: 14,
  },
};

export default FacebookMessengerView;
