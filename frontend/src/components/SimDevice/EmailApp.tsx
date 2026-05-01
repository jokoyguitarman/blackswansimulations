import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useWebSocket } from '../../hooks/useWebSocket';
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

interface SimEmail {
  id: string;
  direction: string;
  from_address: string;
  from_name: string;
  to_addresses: string[];
  subject: string;
  body_text: string;
  body_html: string;
  priority: string;
  is_read: boolean;
  created_at: string;
}

export default function EmailApp() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const [emails, setEmails] = useState<SimEmail[]>([]);
  const [selectedEmail, setSelectedEmail] = useState<SimEmail | null>(null);
  const [composing, setComposing] = useState(false);
  const [replyData, setReplyData] = useState({ to: '', subject: '', body: '' });

  useEffect(() => {
    loadEmails();
  }, [sessionId]);

  useWebSocket({
    sessionId: sessionId || '',
    eventTypes: ['sim_email.received', 'sim_email.sent'],
    onEvent: () => {
      loadEmails();
    },
  });

  async function loadEmails() {
    if (!sessionId) return;
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(apiUrl(`/api/social/emails/session/${sessionId}`), { headers });
      const result = await res.json();
      if (result.data) setEmails(result.data);
    } catch {
      /* ignore */
    }
  }

  async function markRead(emailId: string) {
    try {
      const headers = await getAuthHeaders();
      await fetch(apiUrl(`/api/social/emails/${emailId}/read`), { method: 'POST', headers });
      setEmails((prev) => prev.map((e) => (e.id === emailId ? { ...e, is_read: true } : e)));
    } catch {
      /* ignore */
    }
  }

  async function sendEmail() {
    if (!replyData.subject.trim() || !replyData.body.trim() || !sessionId) return;
    try {
      const headers = await getAuthHeaders();
      await fetch(apiUrl('/api/social/emails'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          session_id: sessionId,
          to_addresses: [replyData.to || 'recipient@sim.local'],
          subject: replyData.subject,
          body_text: replyData.body,
          replied_to_id: selectedEmail?.id,
        }),
      });
      setComposing(false);
      setReplyData({ to: '', subject: '', body: '' });
      loadEmails();
    } catch {
      /* ignore */
    }
  }

  function getPriorityBadge(priority: string): { bg: string; text: string; label: string } | null {
    switch (priority) {
      case 'urgent':
        return { bg: '#FFE5E5', text: '#FF3B30', label: 'Urgent' };
      case 'high':
        return { bg: '#FFF3E0', text: '#FF9500', label: 'High' };
      default:
        return null;
    }
  }

  function formatTime(dateStr: string): string {
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffHours = diffMs / (1000 * 60 * 60);
    if (diffHours < 24) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function getInitialsColor(name: string): string {
    const colors = ['#007AFF', '#34C759', '#FF9500', '#FF3B30', '#5856D6', '#AF52DE'];
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return colors[Math.abs(hash) % colors.length];
  }

  // Email Detail View
  if (selectedEmail) {
    const priorityBadge = getPriorityBadge(selectedEmail.priority);
    return (
      <div className="h-full flex flex-col" style={{ backgroundColor: '#F2F2F7' }}>
        {/* Nav Bar */}
        <div
          className="flex items-center gap-3 px-4 ios-blur-nav"
          style={{
            height: 44,
            backgroundColor: 'rgba(242,242,247,0.85)',
            borderBottom: '0.5px solid #C6C6C8',
          }}
        >
          <button
            onClick={() => setSelectedEmail(null)}
            className="flex items-center gap-1 ios-btn-bounce"
            style={{ color: '#007AFF' }}
          >
            <svg width="10" height="16" viewBox="0 0 10 16" fill="none">
              <path
                d="M9 1L2 8l7 7"
                stroke="#007AFF"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="text-[17px]">Inbox</span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Subject */}
          <div className="px-4 pt-4 pb-2" style={{ backgroundColor: '#FFFFFF' }}>
            <div className="flex items-start justify-between gap-2">
              <h1 className="text-[22px] font-bold leading-tight" style={{ color: '#000000' }}>
                {selectedEmail.subject}
              </h1>
              {priorityBadge && (
                <span
                  className="text-[11px] font-semibold px-2 py-0.5 rounded-full flex-shrink-0"
                  style={{ backgroundColor: priorityBadge.bg, color: priorityBadge.text }}
                >
                  {priorityBadge.label}
                </span>
              )}
            </div>
          </div>

          {/* Sender info */}
          <div
            className="flex items-center gap-3 px-4 py-3"
            style={{ backgroundColor: '#FFFFFF', borderBottom: '0.5px solid #C6C6C8' }}
          >
            <div
              className="w-10 h-10 rounded-full flex items-center justify-center text-white font-semibold text-[16px]"
              style={{ backgroundColor: getInitialsColor(selectedEmail.from_name) }}
            >
              {selectedEmail.from_name.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1">
              <p className="text-[15px] font-semibold" style={{ color: '#000000' }}>
                {selectedEmail.from_name}
              </p>
              <p className="text-[13px]" style={{ color: '#8E8E93' }}>
                {selectedEmail.from_address}
              </p>
            </div>
            <span className="text-[13px]" style={{ color: '#8E8E93' }}>
              {formatTime(selectedEmail.created_at)}
            </span>
          </div>

          {/* Body */}
          <div className="px-4 py-4" style={{ backgroundColor: '#FFFFFF' }}>
            <p
              className="text-[15px] leading-relaxed whitespace-pre-wrap"
              style={{ color: '#000000' }}
            >
              {selectedEmail.body_text}
            </p>
          </div>
        </div>

        {/* Reply bar */}
        <div
          className="px-4 py-3"
          style={{ backgroundColor: '#FFFFFF', borderTop: '0.5px solid #C6C6C8' }}
        >
          <button
            onClick={() => {
              setComposing(true);
              setReplyData({
                to: selectedEmail.from_address,
                subject: `RE: ${selectedEmail.subject}`,
                body: '',
              });
            }}
            className="w-full py-2.5 rounded-xl text-[17px] font-semibold text-white ios-btn-bounce"
            style={{ backgroundColor: '#007AFF' }}
          >
            Reply
          </button>
        </div>
      </div>
    );
  }

  // Compose View
  if (composing) {
    return (
      <div className="h-full flex flex-col" style={{ backgroundColor: '#F2F2F7' }}>
        <div
          className="flex items-center justify-between px-4 ios-blur-nav"
          style={{
            height: 44,
            backgroundColor: 'rgba(242,242,247,0.85)',
            borderBottom: '0.5px solid #C6C6C8',
          }}
        >
          <button
            onClick={() => setComposing(false)}
            className="text-[17px] ios-btn-bounce"
            style={{ color: '#007AFF' }}
          >
            Cancel
          </button>
          <span className="ios-nav-title" style={{ color: '#000000' }}>
            New Message
          </span>
          <button
            onClick={sendEmail}
            className="text-[17px] font-semibold ios-btn-bounce"
            style={{ color: '#007AFF' }}
          >
            Send
          </button>
        </div>
        <div className="flex-1 overflow-y-auto" style={{ backgroundColor: '#FFFFFF' }}>
          <div style={{ borderBottom: '0.5px solid #C6C6C8' }}>
            <div className="flex items-center px-4 py-2.5">
              <span className="text-[15px] w-16" style={{ color: '#8E8E93' }}>
                To:
              </span>
              <input
                value={replyData.to}
                onChange={(e) => setReplyData({ ...replyData, to: e.target.value })}
                className="flex-1 text-[15px] outline-none"
                style={{ color: '#000000' }}
              />
            </div>
          </div>
          <div style={{ borderBottom: '0.5px solid #C6C6C8' }}>
            <div className="flex items-center px-4 py-2.5">
              <span className="text-[15px] w-16" style={{ color: '#8E8E93' }}>
                Subject:
              </span>
              <input
                value={replyData.subject}
                onChange={(e) => setReplyData({ ...replyData, subject: e.target.value })}
                className="flex-1 text-[15px] outline-none"
                style={{ color: '#000000' }}
              />
            </div>
          </div>
          <textarea
            value={replyData.body}
            onChange={(e) => setReplyData({ ...replyData, body: e.target.value })}
            placeholder="Write your email..."
            className="w-full px-4 py-3 text-[15px] outline-none resize-none min-h-[240px]"
            style={{ color: '#000000' }}
            autoFocus
          />
        </div>
      </div>
    );
  }

  // Inbox List
  return (
    <div className="h-full flex flex-col" style={{ backgroundColor: '#F2F2F7' }}>
      {/* Nav */}
      <div
        className="ios-blur-nav"
        style={{ backgroundColor: 'rgba(242,242,247,0.85)', borderBottom: '0.5px solid #C6C6C8' }}
      >
        <div className="flex items-center justify-between px-4" style={{ height: 44 }}>
          <button
            onClick={() => navigate(`/sim/${sessionId}/device/home`)}
            className="flex items-center gap-1 ios-btn-bounce"
            style={{ color: '#007AFF' }}
          >
            <svg width="10" height="16" viewBox="0 0 10 16" fill="none">
              <path
                d="M9 1L2 8l7 7"
                stroke="#007AFF"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="text-[17px]">Home</span>
          </button>
          <button
            onClick={() => setComposing(true)}
            className="ios-btn-bounce"
            style={{ color: '#007AFF' }}
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#007AFF"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
            </svg>
          </button>
        </div>
        <div className="px-4 pb-2">
          <h1 className="ios-large-title" style={{ color: '#000000' }}>
            Inbox
          </h1>
        </div>
      </div>

      {/* Email List */}
      <div className="flex-1 overflow-y-auto">
        {emails.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 gap-1">
            <svg
              width="48"
              height="48"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#C7C7CC"
              strokeWidth="1"
            >
              <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
              <polyline points="22,6 12,13 2,6" />
            </svg>
            <p className="text-[15px]" style={{ color: '#8E8E93' }}>
              No emails
            </p>
          </div>
        ) : (
          <div style={{ backgroundColor: '#FFFFFF' }}>
            {emails.map((email, idx) => {
              const priorityBadge = getPriorityBadge(email.priority);
              return (
                <button
                  key={email.id}
                  onClick={() => {
                    setSelectedEmail(email);
                    if (!email.is_read) markRead(email.id);
                  }}
                  className="w-full text-left flex gap-3 px-4 py-3 ios-btn-bounce"
                  style={{ borderBottom: idx < emails.length - 1 ? '0.5px solid #C6C6C8' : 'none' }}
                >
                  {/* Unread dot */}
                  <div className="flex items-start pt-1.5" style={{ width: 10 }}>
                    {!email.is_read && (
                      <div
                        className="w-[10px] h-[10px] rounded-full"
                        style={{ backgroundColor: '#007AFF' }}
                      />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={`text-[15px] truncate ${!email.is_read ? 'font-semibold' : ''}`}
                        style={{ color: '#000000' }}
                      >
                        {email.direction === 'inbound'
                          ? email.from_name
                          : `To: ${email.to_addresses[0]}`}
                      </span>
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        {priorityBadge && (
                          <span
                            className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                            style={{ backgroundColor: priorityBadge.bg, color: priorityBadge.text }}
                          >
                            {priorityBadge.label}
                          </span>
                        )}
                        <span className="text-[13px]" style={{ color: '#8E8E93' }}>
                          {formatTime(email.created_at)}
                        </span>
                        <svg width="8" height="13" viewBox="0 0 8 13" fill="none">
                          <path
                            d="M1 1l5.5 5.5L1 12"
                            stroke="#C7C7CC"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </div>
                    </div>
                    <p
                      className={`text-[14px] mt-0.5 truncate ${!email.is_read ? 'font-medium' : ''}`}
                      style={{ color: '#000000' }}
                    >
                      {email.subject}
                    </p>
                    <p className="text-[13px] mt-0.5 truncate" style={{ color: '#8E8E93' }}>
                      {email.body_text.substring(0, 90)}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
