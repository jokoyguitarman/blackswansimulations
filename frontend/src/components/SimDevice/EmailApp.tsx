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
        return { bg: '#FFE5E5', text: '#FF3B30', label: '!' };
      case 'high':
        return { bg: '#FFF3E0', text: '#FF9500', label: '!' };
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
    const colors = [
      '#007AFF',
      '#34C759',
      '#FF9500',
      '#FF3B30',
      '#5856D6',
      '#AF52DE',
      '#FF2D55',
      '#5AC8FA',
    ];
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return colors[Math.abs(hash) % colors.length];
  }

  // Email Detail View
  if (selectedEmail) {
    const priorityBadge = getPriorityBadge(selectedEmail.priority);
    return (
      <div className="h-full flex flex-col" style={{ backgroundColor: '#FFFFFF' }}>
        {/* Nav Bar */}
        <div
          className="flex items-center justify-between px-4 ios-blur-nav flex-shrink-0"
          style={{
            height: 44,
            backgroundColor: 'rgba(255,255,255,0.92)',
            borderBottom: '0.5px solid rgba(60,60,67,0.29)',
            backdropFilter: 'blur(20px)',
          }}
        >
          <button
            onClick={() => setSelectedEmail(null)}
            className="flex items-center gap-0.5 ios-btn-bounce"
            style={{ color: '#007AFF' }}
          >
            <svg width="12" height="20" viewBox="0 0 12 20" fill="none">
              <path
                d="M10 2L2 10l8 8"
                stroke="#007AFF"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="text-[17px]">Inbox</span>
          </button>
          <div className="flex items-center gap-5" style={{ color: '#007AFF' }}>
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
            </svg>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Subject area */}
          <div className="px-4 pt-5 pb-3">
            <div className="flex items-start gap-2">
              <h1
                className="text-[22px] font-bold leading-tight flex-1"
                style={{ color: '#000000' }}
              >
                {selectedEmail.subject}
              </h1>
              {priorityBadge && (
                <span
                  className="text-[13px] font-bold flex-shrink-0 mt-1"
                  style={{ color: priorityBadge.text }}
                >
                  {priorityBadge.label}
                </span>
              )}
            </div>
          </div>

          {/* Sender card */}
          <div
            className="flex items-center gap-3 px-4 py-3"
            style={{ borderTop: '0.5px solid rgba(60,60,67,0.12)' }}
          >
            <div
              className="w-10 h-10 rounded-full flex items-center justify-center text-white font-semibold text-[16px]"
              style={{ backgroundColor: getInitialsColor(selectedEmail.from_name) }}
            >
              {selectedEmail.from_name.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between">
                <p className="text-[15px] font-semibold" style={{ color: '#000000' }}>
                  {selectedEmail.from_name}
                </p>
                <span className="text-[13px]" style={{ color: '#8E8E93' }}>
                  {formatTime(selectedEmail.created_at)}
                </span>
              </div>
              <p className="text-[13px] truncate" style={{ color: '#8E8E93' }}>
                {selectedEmail.from_address}
              </p>
            </div>
          </div>

          {/* Body */}
          <div className="px-4 py-5" style={{ borderTop: '0.5px solid rgba(60,60,67,0.12)' }}>
            <p
              className="text-[16px] leading-relaxed whitespace-pre-wrap"
              style={{ color: '#1C1C1E' }}
            >
              {selectedEmail.body_text}
            </p>
          </div>
        </div>

        {/* Reply toolbar */}
        <div
          className="flex items-center justify-center gap-6 px-4 py-3 flex-shrink-0"
          style={{
            borderTop: '0.5px solid rgba(60,60,67,0.29)',
            backgroundColor: 'rgba(255,255,255,0.92)',
          }}
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
            className="flex items-center gap-2 ios-btn-bounce"
            style={{ color: '#007AFF' }}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="9 17 4 12 9 7" />
              <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
            </svg>
            <span className="text-[15px]">Reply</span>
          </button>
          <button className="flex items-center gap-2 ios-btn-bounce" style={{ color: '#007AFF' }}>
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="15 17 20 12 15 7" />
              <path d="M4 18v-2a4 4 0 0 1 4-4h12" />
            </svg>
            <span className="text-[15px]">Forward</span>
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
          className="flex items-center justify-between px-4 ios-blur-nav flex-shrink-0"
          style={{
            height: 44,
            backgroundColor: 'rgba(242,242,247,0.92)',
            borderBottom: '0.5px solid rgba(60,60,67,0.29)',
            backdropFilter: 'blur(20px)',
          }}
        >
          <button
            onClick={() => setComposing(false)}
            className="text-[17px] ios-btn-bounce"
            style={{ color: '#007AFF' }}
          >
            Cancel
          </button>
          <span className="text-[17px] font-semibold" style={{ color: '#000000' }}>
            New Message
          </span>
          <button onClick={sendEmail} className="ios-btn-bounce" style={{ color: '#007AFF' }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="#007AFF">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto" style={{ backgroundColor: '#FFFFFF' }}>
          <div style={{ borderBottom: '0.5px solid rgba(60,60,67,0.12)' }}>
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
          <div style={{ borderBottom: '0.5px solid rgba(60,60,67,0.12)' }}>
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
            className="w-full px-4 py-3 text-[16px] outline-none resize-none min-h-[280px]"
            style={{ color: '#000000', lineHeight: '1.5' }}
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
        className="ios-blur-nav flex-shrink-0"
        style={{
          backgroundColor: 'rgba(242,242,247,0.92)',
          borderBottom: '0.5px solid rgba(60,60,67,0.29)',
          backdropFilter: 'blur(20px)',
        }}
      >
        <div className="flex items-center justify-between px-4" style={{ height: 44 }}>
          <button
            onClick={() => navigate(`/sim/${sessionId}/device/home`)}
            className="flex items-center gap-0.5 ios-btn-bounce"
            style={{ color: '#007AFF' }}
          >
            <svg width="12" height="20" viewBox="0 0 12 20" fill="none">
              <path
                d="M10 2L2 10l8 8"
                stroke="#007AFF"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="text-[17px]">Back</span>
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
          <h1 className="text-[34px] font-bold tracking-tight" style={{ color: '#000000' }}>
            Inbox
          </h1>
        </div>
      </div>

      {/* Email List */}
      <div className="flex-1 overflow-y-auto">
        {emails.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 gap-2">
            <svg
              width="52"
              height="52"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#C7C7CC"
              strokeWidth="0.8"
            >
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="M22 7l-10 7L2 7" />
            </svg>
            <p className="text-[17px] font-semibold" style={{ color: '#3C3C43' }}>
              No Mail
            </p>
            <p className="text-[14px]" style={{ color: '#8E8E93' }}>
              Emails will appear as the simulation runs.
            </p>
          </div>
        ) : (
          <div
            className="mt-3 mx-4 rounded-xl overflow-hidden"
            style={{ backgroundColor: '#FFFFFF' }}
          >
            {emails.map((email, idx) => {
              const priorityBadge = getPriorityBadge(email.priority);
              const senderName =
                email.direction === 'inbound' ? email.from_name : `To: ${email.to_addresses[0]}`;
              return (
                <button
                  key={email.id}
                  onClick={() => {
                    setSelectedEmail(email);
                    if (!email.is_read) markRead(email.id);
                  }}
                  className="w-full text-left flex items-start gap-3 px-4 py-3 ios-btn-bounce active:bg-gray-50"
                  style={{
                    borderBottom:
                      idx < emails.length - 1 ? '0.5px solid rgba(60,60,67,0.12)' : 'none',
                  }}
                >
                  {/* Avatar */}
                  <div className="flex-shrink-0 relative">
                    <div
                      className="w-10 h-10 rounded-full flex items-center justify-center text-white font-semibold text-[16px]"
                      style={{ backgroundColor: getInitialsColor(senderName) }}
                    >
                      {senderName.replace('To: ', '').charAt(0).toUpperCase()}
                    </div>
                    {!email.is_read && (
                      <div
                        className="absolute -left-1.5 top-1/2 -translate-y-1/2 w-[10px] h-[10px] rounded-full"
                        style={{ backgroundColor: '#007AFF' }}
                      />
                    )}
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={`text-[15px] truncate ${!email.is_read ? 'font-bold' : 'font-normal'}`}
                        style={{ color: '#000000' }}
                      >
                        {senderName}
                      </span>
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <span className="text-[13px]" style={{ color: '#8E8E93' }}>
                          {formatTime(email.created_at)}
                        </span>
                        <svg width="7" height="12" viewBox="0 0 7 12" fill="none">
                          <path
                            d="M1 1l5 5-5 5"
                            stroke="#C7C7CC"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      {priorityBadge && (
                        <span
                          className="text-[11px] font-bold w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0"
                          style={{ backgroundColor: priorityBadge.bg, color: priorityBadge.text }}
                        >
                          !
                        </span>
                      )}
                      <p
                        className={`text-[14px] truncate ${!email.is_read ? 'font-medium' : ''}`}
                        style={{ color: '#1C1C1E' }}
                      >
                        {email.subject}
                      </p>
                    </div>
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

      {/* Compose FAB */}
      <button
        onClick={() => setComposing(true)}
        className="absolute ios-btn-bounce flex items-center justify-center"
        style={{
          bottom: 24,
          right: 20,
          width: 56,
          height: 56,
          borderRadius: 28,
          backgroundColor: '#007AFF',
          boxShadow: '0 4px 12px rgba(0,122,255,0.35)',
        }}
      >
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="white"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
        </svg>
      </button>
    </div>
  );
}
