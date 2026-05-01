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

  function getPriorityColor(priority: string): string {
    switch (priority) {
      case 'urgent':
        return 'text-red-400 bg-red-900/30';
      case 'high':
        return 'text-orange-400 bg-orange-900/30';
      default:
        return 'text-gray-400';
    }
  }

  if (selectedEmail) {
    return (
      <div className="h-full flex flex-col bg-gray-950 text-white">
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-800">
          <button onClick={() => setSelectedEmail(null)} className="text-blue-400 text-sm">
            ← Back
          </button>
          <span className="flex-1 truncate font-medium">{selectedEmail.subject}</span>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="font-semibold text-sm">{selectedEmail.from_name}</p>
              <p className="text-xs text-gray-500">{selectedEmail.from_address}</p>
            </div>
            {selectedEmail.priority !== 'normal' && (
              <span
                className={`text-xs px-2 py-0.5 rounded ${getPriorityColor(selectedEmail.priority)}`}
              >
                {selectedEmail.priority.toUpperCase()}
              </span>
            )}
          </div>
          <div className="text-sm whitespace-pre-wrap leading-relaxed text-gray-300">
            {selectedEmail.body_text}
          </div>
        </div>
        <div className="p-3 border-t border-gray-800">
          <button
            onClick={() => {
              setComposing(true);
              setReplyData({
                to: selectedEmail.from_address,
                subject: `RE: ${selectedEmail.subject}`,
                body: '',
              });
            }}
            className="w-full bg-blue-600 text-white py-2 rounded-lg text-sm font-medium"
          >
            Reply
          </button>
        </div>
      </div>
    );
  }

  if (composing) {
    return (
      <div className="h-full flex flex-col bg-gray-950 text-white">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <button onClick={() => setComposing(false)} className="text-blue-400 text-sm">
            Cancel
          </button>
          <span className="font-medium">New Email</span>
          <button onClick={sendEmail} className="text-blue-400 text-sm font-bold">
            Send
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          <input
            value={replyData.to}
            onChange={(e) => setReplyData({ ...replyData, to: e.target.value })}
            placeholder="To"
            className="w-full bg-gray-900 text-white px-3 py-2 rounded border border-gray-800 text-sm"
          />
          <input
            value={replyData.subject}
            onChange={(e) => setReplyData({ ...replyData, subject: e.target.value })}
            placeholder="Subject"
            className="w-full bg-gray-900 text-white px-3 py-2 rounded border border-gray-800 text-sm"
          />
          <textarea
            value={replyData.body}
            onChange={(e) => setReplyData({ ...replyData, body: e.target.value })}
            placeholder="Write your email..."
            className="w-full flex-1 bg-gray-900 text-white px-3 py-2 rounded border border-gray-800 text-sm min-h-[200px] resize-none"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-gray-950 text-white">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
        <button
          onClick={() => navigate(`/sim/${sessionId}/device/home`)}
          className="text-blue-400 text-sm"
        >
          ← Home
        </button>
        <span className="font-bold">Email</span>
        <button onClick={() => setComposing(true)} className="text-blue-400 text-sm">
          Compose
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {emails.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-gray-500 text-sm">
            No emails
          </div>
        ) : (
          emails.map((email) => (
            <button
              key={email.id}
              onClick={() => {
                setSelectedEmail(email);
                if (!email.is_read) markRead(email.id);
              }}
              className={`w-full text-left px-4 py-3 border-b border-gray-800 hover:bg-gray-900 transition-colors ${!email.is_read ? 'bg-gray-900/50' : ''}`}
            >
              <div className="flex items-center gap-2">
                {!email.is_read && (
                  <span className="w-2 h-2 bg-blue-500 rounded-full flex-shrink-0" />
                )}
                <span className={`text-sm ${!email.is_read ? 'font-bold' : ''} flex-1 truncate`}>
                  {email.direction === 'inbound' ? email.from_name : `To: ${email.to_addresses[0]}`}
                </span>
                {email.priority !== 'normal' && (
                  <span
                    className={`text-[10px] px-1 py-0.5 rounded ${getPriorityColor(email.priority)}`}
                  >
                    {email.priority}
                  </span>
                )}
              </div>
              <p className="text-sm font-medium mt-0.5 truncate">{email.subject}</p>
              <p className="text-xs text-gray-500 mt-0.5 truncate">
                {email.body_text.substring(0, 80)}
              </p>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
