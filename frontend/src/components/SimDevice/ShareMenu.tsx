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
}

interface ShareMenuProps {
  postId: string;
  sessionId: string;
  platform: 'facebook' | 'x_twitter';
  authorHandle: string;
  authorDisplayName: string;
  contentPreview: string;
  onClose: () => void;
  onReposted?: (repost: Record<string, unknown>) => void;
  onCopied?: () => void;
}

export default function ShareMenu({
  postId,
  sessionId,
  platform,
  authorHandle,
  authorDisplayName,
  contentPreview,
  onClose,
  onReposted,
  onCopied,
}: ShareMenuProps) {
  const [view, setView] = useState<'menu' | 'dm-picker'>('menu');
  const [threads, setThreads] = useState<Thread[]>([]);
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [sending, setSending] = useState(false);
  const [reposting, setReposting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  async function handleShareToGroupChat() {
    if (sending) return;
    setSending(true);
    try {
      const headers = await getAuthHeaders();
      const channelsRes = await fetch(apiUrl(`/api/channels/session/${sessionId}`), { headers });
      if (!channelsRes.ok) {
        setStatus('No group chat found');
        setSending(false);
        return;
      }
      const channelsJson = await channelsRes.json();
      const channels = channelsJson.data || [];
      const generalChannel =
        channels.find((c: Record<string, string>) => c.type === 'general') || channels[0];
      if (!generalChannel) {
        setStatus('No group chat found');
        setSending(false);
        return;
      }
      const platformLabel = platform === 'facebook' ? 'Fakebook' : 'Z';
      const preview =
        contentPreview.length > 100 ? contentPreview.slice(0, 100) + '...' : contentPreview;
      const messageContent = `[Shared ${platformLabel} post by ${authorDisplayName}]\n"${preview}"`;
      const sendRes = await fetch(apiUrl(`/api/channels/${generalChannel.id}/messages`), {
        method: 'POST',
        headers,
        body: JSON.stringify({ content: messageContent, message_type: 'text' }),
      });
      if (sendRes.ok) {
        setStatus('Shared to group chat!');
        setTimeout(onClose, 1200);
      } else {
        setStatus('Failed to share');
      }
    } catch {
      setStatus('Failed to share');
    } finally {
      setSending(false);
    }
  }

  async function handleRepost() {
    if (reposting) return;
    setReposting(true);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(apiUrl(`/api/social/posts/${postId}/repost`), {
        method: 'POST',
        headers,
        body: JSON.stringify({ session_id: sessionId }),
      });
      if (res.ok) {
        const json = await res.json();
        onReposted?.(json.data);
        setStatus('Shared to profile!');
        setTimeout(onClose, 1200);
      } else {
        setStatus('Failed to share');
      }
    } catch {
      setStatus('Failed to share');
    } finally {
      setReposting(false);
    }
  }

  function handleCopyLink() {
    const domain = platform === 'facebook' ? 'fakebook.sim' : 'z.com';
    const pathSegment = platform === 'facebook' ? 'posts' : 'status';
    const postUrl = `https://${domain}/${authorHandle.replace('@', '')}/${pathSegment}/${postId.slice(0, 8)}`;
    navigator.clipboard.writeText(postUrl).then(() => {
      onCopied?.();
      setStatus('Link copied!');
      setTimeout(onClose, 1200);
    });
  }

  async function openDMPicker() {
    setView('dm-picker');
    setLoadingThreads(true);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(
        apiUrl(`/api/social/messenger/threads/${sessionId}?platform=${platform}`),
        { headers },
      );
      if (res.ok) {
        const json = await res.json();
        const raw = Array.isArray(json) ? json : Array.isArray(json.data) ? json.data : [];
        const normalized: Thread[] = raw.map((t: Record<string, unknown>) => ({
          thread_id: String(t.thread_id || ''),
          other_handle: String(
            (t.other_participant as Record<string, string>)?.handle || t.other_handle || '',
          ),
          other_display_name: String(
            (t.other_participant as Record<string, string>)?.display_name ||
              t.other_display_name ||
              '',
          ),
        }));
        setThreads(normalized);
      }
    } catch {
      // silently fail
    } finally {
      setLoadingThreads(false);
    }
  }

  async function sendToDM(recipientHandle: string) {
    if (sending) return;
    setSending(true);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(apiUrl('/api/social/messenger/send'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          session_id: sessionId,
          recipient_handle: recipientHandle,
          content: `Shared a post by ${authorDisplayName}: "${contentPreview.slice(0, 100)}${contentPreview.length > 100 ? '...' : ''}"`,
          platform,
          shared_post_id: postId,
        }),
      });
      if (res.ok) {
        setStatus('Sent!');
        setTimeout(onClose, 1200);
      } else {
        setStatus('Failed to send');
      }
    } catch {
      setStatus('Failed to send');
    } finally {
      setSending(false);
    }
  }

  const menuStyle: React.CSSProperties = {
    position: 'absolute',
    bottom: '100%',
    right: 0,
    marginBottom: 4,
    backgroundColor: platform === 'facebook' ? '#FFFFFF' : '#16181C',
    borderRadius: 12,
    boxShadow:
      platform === 'facebook' ? '0 2px 12px rgba(0,0,0,0.15)' : '0 0 15px rgba(255,255,255,0.1)',
    minWidth: 220,
    zIndex: 50,
    overflow: 'hidden',
  };

  const itemStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 14px',
    cursor: 'pointer',
    fontSize: 14,
    fontWeight: 500,
    color: platform === 'facebook' ? '#1C1E21' : '#E7E9EA',
    border: 'none',
    background: 'none',
    width: '100%',
    textAlign: 'left',
  };

  const hoverBg = platform === 'facebook' ? '#F2F3F5' : '#1D1F23';

  if (status) {
    return (
      <div ref={menuRef} style={menuStyle}>
        <div
          style={{
            padding: '14px 16px',
            textAlign: 'center',
            fontSize: 14,
            fontWeight: 600,
            color: platform === 'facebook' ? '#1C1E21' : '#E7E9EA',
          }}
        >
          {status}
        </div>
      </div>
    );
  }

  if (view === 'dm-picker') {
    return (
      <div ref={menuRef} style={{ ...menuStyle, maxHeight: 280, overflowY: 'auto' }}>
        <div
          style={{
            padding: '10px 14px',
            fontWeight: 600,
            fontSize: 13,
            color: platform === 'facebook' ? '#65676B' : '#71767B',
            borderBottom: `1px solid ${platform === 'facebook' ? '#E4E6EB' : '#2F3336'}`,
          }}
        >
          Send to...
        </div>
        {loadingThreads && (
          <div
            style={{
              padding: '16px',
              textAlign: 'center',
              fontSize: 13,
              color: platform === 'facebook' ? '#65676B' : '#71767B',
            }}
          >
            Loading...
          </div>
        )}
        {!loadingThreads && threads.length === 0 && (
          <div
            style={{
              padding: '16px',
              textAlign: 'center',
              fontSize: 13,
              color: platform === 'facebook' ? '#65676B' : '#71767B',
            }}
          >
            No conversations yet
          </div>
        )}
        {threads.map((t) => (
          <button
            key={t.thread_id}
            onClick={() => sendToDM(t.other_handle)}
            disabled={sending}
            style={itemStyle}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = hoverBg)}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
          >
            <span
              style={{
                width: 32,
                height: 32,
                borderRadius: '50%',
                backgroundColor: platform === 'facebook' ? '#1877F2' : '#1D9BF0',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff',
                fontSize: 13,
                fontWeight: 700,
                flexShrink: 0,
              }}
            >
              {(t.other_display_name || t.other_handle).charAt(0).toUpperCase()}
            </span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {t.other_display_name || t.other_handle}
            </span>
          </button>
        ))}
      </div>
    );
  }

  return (
    <div ref={menuRef} style={menuStyle}>
      <button
        onClick={handleRepost}
        disabled={reposting}
        style={itemStyle}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = hoverBg)}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M17 1l4 4-4 4" />
          <path d="M3 11V9a4 4 0 0 1 4-4h14" />
          <path d="M7 23l-4-4 4-4" />
          <path d="M21 13v2a4 4 0 0 1-4 4H3" />
        </svg>
        {reposting ? 'Sharing...' : 'Share to your profile'}
      </button>
      <button
        onClick={openDMPicker}
        style={itemStyle}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = hoverBg)}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
        </svg>
        Send via message
      </button>
      <button
        onClick={handleShareToGroupChat}
        disabled={sending}
        style={itemStyle}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = hoverBg)}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
        Share to group chat
      </button>
      <button
        onClick={handleCopyLink}
        style={itemStyle}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = hoverBg)}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
        Copy link
      </button>
    </div>
  );
}
