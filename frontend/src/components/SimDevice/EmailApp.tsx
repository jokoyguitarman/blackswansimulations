import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useWebSocket } from '../../hooks/useWebSocket';
import { useRoleVisibility } from '../../hooks/useRoleVisibility';
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
  email_category: string;
  is_read: boolean;
  thread_id: string | null;
  replied_to_id: string | null;
  created_at: string;
}

interface EmailDraft {
  id: string;
  to: string;
  subject: string;
  body: string;
  replyToId?: string;
  savedAt: string;
}

function getDraftsKey(sessionId: string): string {
  return `email_drafts_${sessionId}`;
}

function loadDrafts(sessionId: string): EmailDraft[] {
  try {
    const raw = localStorage.getItem(getDraftsKey(sessionId));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveDrafts(sessionId: string, drafts: EmailDraft[]): void {
  localStorage.setItem(getDraftsKey(sessionId), JSON.stringify(drafts));
}

export default function EmailApp() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const { isTrainer } = useRoleVisibility();
  const [emails, setEmails] = useState<SimEmail[]>([]);
  const [selectedEmail, setSelectedEmail] = useState<SimEmail | null>(null);
  const [composing, setComposing] = useState(false);
  const [replying, setReplying] = useState(false);
  const [folder, setFolder] = useState<'inbox' | 'sent' | 'drafts'>('inbox');
  const [replyData, setReplyData] = useState({ to: '', subject: '', body: '' });
  const [drafts, setDrafts] = useState<EmailDraft[]>([]);
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const [contacts, setContacts] = useState<
    Array<{ address: string; name: string; source: string }>
  >([]);
  const [showContactDropdown, setShowContactDropdown] = useState(false);

  // Load drafts from localStorage on mount
  useEffect(() => {
    if (sessionId) setDrafts(loadDrafts(sessionId));
  }, [sessionId]);

  function saveDraft() {
    if (!sessionId) return;
    if (!replyData.to && !replyData.subject && !replyData.body) return;

    const updated = [...drafts];
    if (editingDraftId) {
      const idx = updated.findIndex((d) => d.id === editingDraftId);
      if (idx >= 0) {
        updated[idx] = {
          ...updated[idx],
          to: replyData.to,
          subject: replyData.subject,
          body: replyData.body,
          savedAt: new Date().toISOString(),
        };
      }
    } else {
      updated.unshift({
        id: `draft-${Date.now()}`,
        to: replyData.to,
        subject: replyData.subject,
        body: replyData.body,
        replyToId: selectedEmail?.id,
        savedAt: new Date().toISOString(),
      });
    }
    setDrafts(updated);
    saveDrafts(sessionId, updated);
    setEditingDraftId(null);
  }

  function deleteDraft(draftId: string) {
    if (!sessionId) return;
    const updated = drafts.filter((d) => d.id !== draftId);
    setDrafts(updated);
    saveDrafts(sessionId, updated);
  }

  function openDraft(draft: EmailDraft) {
    setReplyData({ to: draft.to, subject: draft.subject, body: draft.body });
    setEditingDraftId(draft.id);
    setComposing(true);
    setSelectedEmail(null);
  }

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

  async function loadContacts() {
    if (!sessionId) return;
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(apiUrl(`/api/social/emails/contacts/session/${sessionId}`), {
        headers,
      });
      const result = await res.json();
      if (result.data) setContacts(result.data);
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
    if (!replyData.body.trim() || !replyData.to.trim() || !sessionId) return;
    try {
      const headers = await getAuthHeaders();
      await fetch(apiUrl('/api/social/emails'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          session_id: sessionId,
          to_addresses: [replyData.to],
          subject: replyData.subject || '(No Subject)',
          body_text: replyData.body,
          replied_to_id: selectedEmail?.id,
        }),
      });
      setComposing(false);
      setReplying(false);
      setReplyData({ to: '', subject: '', body: '' });
      if (editingDraftId) {
        deleteDraft(editingDraftId);
        setEditingDraftId(null);
      }
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

  function getCategoryBadge(category: string): { bg: string; text: string; label: string } | null {
    switch (category) {
      case 'holding_statement':
        return { bg: '#FFE5E5', text: '#CC1100', label: 'HOLDING STATEMENT' };
      case 'communication_boundaries':
        return { bg: '#FFF3E0', text: '#CC7700', label: 'DIRECTIVE' };
      case 'approval_chain':
        return { bg: '#F3E8FF', text: '#7C3AED', label: 'APPROVAL REQUIRED' };
      case 'legal_advisory':
        return { bg: '#FDE8E8', text: '#991B1B', label: 'LEGAL' };
      case 'stakeholder_priority':
        return { bg: '#DBEAFE', text: '#1D4ED8', label: 'PRIORITY MATRIX' };
      case 'sitrep_request':
        return { bg: '#D1FAE5', text: '#047857', label: 'SITREP' };
      case 'resource_authorization':
        return { bg: '#DCFCE7', text: '#15803D', label: 'AUTHORIZATION' };
      case 'stand_down_pivot':
        return { bg: '#FFE5E5', text: '#CC1100', label: 'ACTION REQUIRED' };
      case 'messaging_framework':
        return { bg: '#DBEAFE', text: '#1D4ED8', label: 'KEY MESSAGES' };
      default:
        return null;
    }
  }

  function getThreadEmails(email: SimEmail): SimEmail[] {
    const threadId = email.thread_id || email.id;
    return emails
      .filter((e) => e.id === threadId || e.thread_id === threadId)
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  }

  function openEmail(email: SimEmail) {
    setSelectedEmail(email);
    setReplying(false);
    if (!email.is_read) markRead(email.id);
  }

  function startReply() {
    if (!selectedEmail) return;
    setReplying(true);
    setReplyData({
      to: selectedEmail.from_address,
      subject: selectedEmail.subject.startsWith('RE:')
        ? selectedEmail.subject
        : `RE: ${selectedEmail.subject}`,
      body: '',
    });
    setTimeout(() => replyRef.current?.focus(), 100);
  }

  const filteredEmails = emails.filter((e) =>
    folder === 'inbox' ? e.direction === 'inbound' : e.direction === 'outbound',
  );

  // ─── Compose New Email View ─────────────────────────────────────────────────
  if (composing && !selectedEmail) {
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
            onClick={() => {
              if (replyData.to || replyData.subject || replyData.body) {
                saveDraft();
              }
              setComposing(false);
              setReplyData({ to: '', subject: '', body: '' });
              setEditingDraftId(null);
            }}
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
          <div style={{ borderBottom: '0.5px solid rgba(60,60,67,0.12)', position: 'relative' }}>
            <div className="flex items-center px-4 py-2.5">
              <span className="text-[15px] w-16" style={{ color: '#8E8E93' }}>
                To:
              </span>
              <input
                value={replyData.to}
                onChange={(e) => {
                  setReplyData({ ...replyData, to: e.target.value });
                  setShowContactDropdown(e.target.value.length > 0);
                }}
                onFocus={() => {
                  if (replyData.to.length > 0 || contacts.length > 0) setShowContactDropdown(true);
                }}
                onBlur={() => setTimeout(() => setShowContactDropdown(false), 200)}
                placeholder="Recipient email address"
                className="flex-1 text-[15px] outline-none"
                style={{ color: '#000000', backgroundColor: '#FFFFFF' }}
                autoFocus
              />
            </div>
            {showContactDropdown &&
              (() => {
                const query = replyData.to.toLowerCase();
                const filtered = query
                  ? contacts.filter(
                      (c) =>
                        c.name.toLowerCase().includes(query) ||
                        c.address.toLowerCase().includes(query),
                    )
                  : contacts;
                if (filtered.length === 0) return null;
                return (
                  <div
                    className="absolute left-0 right-0 z-50 mx-4 rounded-lg overflow-hidden"
                    style={{
                      top: '100%',
                      backgroundColor: '#FFFFFF',
                      boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
                      border: '0.5px solid rgba(60,60,67,0.18)',
                      maxHeight: 200,
                      overflowY: 'auto',
                    }}
                  >
                    {filtered.slice(0, 8).map((contact, i) => (
                      <button
                        key={contact.address}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          setReplyData({ ...replyData, to: contact.address });
                          setShowContactDropdown(false);
                        }}
                        className="w-full text-left flex items-center justify-between px-3 py-2.5 active:bg-gray-50"
                        style={{
                          borderBottom:
                            i < filtered.length - 1 && i < 7
                              ? '0.5px solid rgba(60,60,67,0.1)'
                              : 'none',
                        }}
                      >
                        <span
                          className="text-[14px] font-medium truncate"
                          style={{ color: '#000' }}
                        >
                          {contact.name}
                        </span>
                        <span
                          className="text-[12px] ml-2 flex-shrink-0"
                          style={{ color: '#8E8E93' }}
                        >
                          {contact.address}
                        </span>
                      </button>
                    ))}
                  </div>
                );
              })()}
            {replyData.to.length > 0 &&
              !contacts.some((c) => c.address.toLowerCase() === replyData.to.toLowerCase()) && (
                <div className="px-4 pb-1">
                  <span className="text-[11px]" style={{ color: '#8E8E93' }}>
                    Unknown recipient — may not respond
                  </span>
                </div>
              )}
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
                style={{ color: '#000000', backgroundColor: '#FFFFFF' }}
              />
            </div>
          </div>
          <textarea
            value={replyData.body}
            onChange={(e) => setReplyData({ ...replyData, body: e.target.value })}
            placeholder="Write your email..."
            className="w-full px-4 py-3 text-[16px] outline-none resize-none min-h-[280px]"
            style={{ color: '#000000', lineHeight: '1.5', backgroundColor: '#FFFFFF' }}
            autoFocus
          />
        </div>
      </div>
    );
  }

  // ─── Thread Detail + Inline Reply View ──────────────────────────────────────
  if (selectedEmail) {
    const threadEmails = getThreadEmails(selectedEmail);
    const detailCategoryBadge = getCategoryBadge(selectedEmail.email_category);
    const threadSubject = threadEmails[0]?.subject || selectedEmail.subject;

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
            onClick={() => {
              setSelectedEmail(null);
              setReplying(false);
            }}
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
            <span className="text-[17px]">{replying ? 'Cancel' : 'Inbox'}</span>
          </button>
          <div className="flex items-center gap-5" style={{ color: '#007AFF' }}>
            {replying ? (
              <button onClick={sendEmail} className="ios-btn-bounce">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="#007AFF">
                  <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                </svg>
              </button>
            ) : (
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
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Category banner (trainer only) */}
          {isTrainer && detailCategoryBadge && (
            <div
              className="flex items-center gap-2 px-4 py-2"
              style={{ backgroundColor: detailCategoryBadge.bg }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke={detailCategoryBadge.text}
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <span
                className="text-[12px] font-bold tracking-wide uppercase"
                style={{ color: detailCategoryBadge.text }}
              >
                {detailCategoryBadge.label}
              </span>
            </div>
          )}

          {/* Inline Reply Compose (shown at top when replying) */}
          {replying && (
            <>
              <div className="px-4 pt-4 pb-2">
                <p className="text-[13px]" style={{ color: '#8E8E93' }}>
                  To: {replyData.to}
                </p>
              </div>
              <div className="px-4 pb-3">
                <textarea
                  ref={replyRef}
                  value={replyData.body}
                  onChange={(e) => setReplyData({ ...replyData, body: e.target.value })}
                  placeholder="Write your reply..."
                  className="w-full text-[16px] outline-none resize-none min-h-[120px]"
                  style={{ color: '#000000', lineHeight: '1.5', backgroundColor: '#FFFFFF' }}
                />
              </div>
              <div
                className="flex items-center justify-center px-4 py-2"
                style={{
                  borderTop: '0.5px solid rgba(60,60,67,0.12)',
                  borderBottom: '0.5px solid rgba(60,60,67,0.12)',
                }}
              >
                <span className="text-[12px]" style={{ color: '#8E8E93' }}>
                  --- Original Message ---
                </span>
              </div>
            </>
          )}

          {/* Subject area */}
          <div className="px-4 pt-4 pb-3">
            <h1 className="text-[22px] font-bold leading-tight" style={{ color: '#000000' }}>
              {threadSubject}
            </h1>
          </div>

          {/* Thread messages */}
          {threadEmails.map((msg, idx) => {
            const isOutbound = msg.direction === 'outbound';
            return (
              <div
                key={msg.id}
                className="px-4 py-3"
                style={{
                  borderTop: idx > 0 ? '0.5px solid rgba(60,60,67,0.12)' : undefined,
                  backgroundColor: isOutbound ? '#F0F9FF' : '#FFFFFF',
                  opacity: replying ? 0.7 : 1,
                }}
              >
                <div className="flex items-center gap-3 mb-2">
                  <div
                    className="w-9 h-9 rounded-full flex items-center justify-center text-white font-semibold text-[14px]"
                    style={{ backgroundColor: getInitialsColor(msg.from_name) }}
                  >
                    {msg.from_name.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <p className="text-[15px] font-semibold" style={{ color: '#000000' }}>
                        {isOutbound ? 'You' : msg.from_name}
                      </p>
                      <span className="text-[13px]" style={{ color: '#8E8E93' }}>
                        {formatTime(msg.created_at)}
                      </span>
                    </div>
                    <p className="text-[12px] truncate" style={{ color: '#8E8E93' }}>
                      {msg.from_address}
                    </p>
                  </div>
                </div>
                <p
                  className="text-[15px] leading-relaxed whitespace-pre-wrap"
                  style={{ color: '#1C1C1E' }}
                >
                  {msg.body_text}
                </p>
              </div>
            );
          })}
        </div>

        {/* Reply toolbar (hidden when already replying) */}
        {!replying && (
          <div
            className="flex items-center justify-center gap-6 px-4 py-3 flex-shrink-0"
            style={{
              borderTop: '0.5px solid rgba(60,60,67,0.29)',
              backgroundColor: 'rgba(255,255,255,0.92)',
            }}
          >
            <button
              onClick={startReply}
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
        )}
      </div>
    );
  }

  // ─── Inbox / Sent List View ─────────────────────────────────────────────────
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
            onClick={() => {
              setComposing(true);
              setReplyData({ to: '', subject: '', body: '' });
              loadContacts();
            }}
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
            {folder === 'inbox' ? 'Inbox' : folder === 'sent' ? 'Sent' : 'Drafts'}
          </h1>
        </div>
        {/* Folder Toggle */}
        <div className="px-4 pb-3">
          <div
            className="flex rounded-[9px] p-[2px]"
            style={{ backgroundColor: 'rgba(118,118,128,0.12)' }}
          >
            <button
              onClick={() => setFolder('inbox')}
              className="flex-1 py-[6px] text-[13px] font-semibold rounded-[7px] transition-all"
              style={{
                backgroundColor: folder === 'inbox' ? '#FFFFFF' : 'transparent',
                color: folder === 'inbox' ? '#000000' : '#8E8E93',
                boxShadow: folder === 'inbox' ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
              }}
            >
              Inbox
            </button>
            <button
              onClick={() => setFolder('sent')}
              className="flex-1 py-[6px] text-[13px] font-semibold rounded-[7px] transition-all"
              style={{
                backgroundColor: folder === 'sent' ? '#FFFFFF' : 'transparent',
                color: folder === 'sent' ? '#000000' : '#8E8E93',
                boxShadow: folder === 'sent' ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
              }}
            >
              Sent
            </button>
            <button
              onClick={() => setFolder('drafts')}
              className="flex-1 py-[6px] text-[13px] font-semibold rounded-[7px] transition-all relative"
              style={{
                backgroundColor: folder === 'drafts' ? '#FFFFFF' : 'transparent',
                color: folder === 'drafts' ? '#000000' : '#8E8E93',
                boxShadow: folder === 'drafts' ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
              }}
            >
              Drafts{drafts.length > 0 && ` (${drafts.length})`}
            </button>
          </div>
        </div>
      </div>

      {/* Email List */}
      <div className="flex-1 overflow-y-auto">
        {folder === 'drafts' ? (
          drafts.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 gap-2">
              <svg
                width="52"
                height="52"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#C7C7CC"
                strokeWidth="0.8"
              >
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
              </svg>
              <p className="text-[17px] font-semibold" style={{ color: '#3C3C43' }}>
                No Drafts
              </p>
              <p className="text-[14px]" style={{ color: '#8E8E93' }}>
                Unsent emails will be saved here.
              </p>
            </div>
          ) : (
            <div
              className="mt-3 mx-4 rounded-xl overflow-hidden"
              style={{ backgroundColor: '#FFFFFF' }}
            >
              {drafts.map((draft, idx) => (
                <div
                  key={draft.id}
                  className="flex items-start gap-3 px-4 py-3"
                  style={{
                    borderBottom:
                      idx < drafts.length - 1 ? '0.5px solid rgba(60,60,67,0.12)' : 'none',
                  }}
                >
                  <button onClick={() => openDraft(draft)} className="flex-1 text-left min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className="text-[15px] font-semibold truncate"
                        style={{ color: '#000000' }}
                      >
                        {draft.to || '(No recipient)'}
                      </span>
                      <span className="text-[13px] flex-shrink-0" style={{ color: '#8E8E93' }}>
                        {new Date(draft.savedAt).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </div>
                    <p className="text-[14px] truncate mt-0.5" style={{ color: '#1C1C1E' }}>
                      {draft.subject || '(No subject)'}
                    </p>
                    <p className="text-[13px] truncate mt-0.5" style={{ color: '#8E8E93' }}>
                      {draft.body || '(Empty)'}
                    </p>
                  </button>
                  <button
                    onClick={() => deleteDraft(draft.id)}
                    className="flex-shrink-0 mt-1 ios-btn-bounce"
                    style={{ color: '#FF3B30' }}
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
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )
        ) : filteredEmails.length === 0 ? (
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
              {folder === 'inbox' ? 'No Mail' : 'No Sent Mail'}
            </p>
            <p className="text-[14px]" style={{ color: '#8E8E93' }}>
              {folder === 'inbox'
                ? 'Emails will appear as the simulation runs.'
                : 'Sent emails will appear here.'}
            </p>
          </div>
        ) : (
          <div
            className="mt-3 mx-4 rounded-xl overflow-hidden"
            style={{ backgroundColor: '#FFFFFF' }}
          >
            {filteredEmails.map((email, idx) => {
              const priorityBadge = getPriorityBadge(email.priority);
              const categoryBadge = getCategoryBadge(email.email_category);
              const senderName =
                email.direction === 'inbound' ? email.from_name : `To: ${email.to_addresses[0]}`;
              return (
                <button
                  key={email.id}
                  onClick={() => openEmail(email)}
                  className="w-full text-left flex items-start gap-3 px-4 py-3 ios-btn-bounce active:bg-gray-50"
                  style={{
                    borderBottom:
                      idx < filteredEmails.length - 1 ? '0.5px solid rgba(60,60,67,0.12)' : 'none',
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
                    {!email.is_read && email.direction === 'inbound' && (
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
                        className={`text-[15px] truncate ${!email.is_read && email.direction === 'inbound' ? 'font-bold' : 'font-normal'}`}
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
                    {isTrainer && categoryBadge && (
                      <span
                        className="inline-block text-[10px] font-bold tracking-wide uppercase px-1.5 py-0.5 rounded mt-0.5"
                        style={{
                          backgroundColor: categoryBadge.bg,
                          color: categoryBadge.text,
                        }}
                      >
                        {categoryBadge.label}
                      </span>
                    )}
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
                        className={`text-[14px] truncate ${!email.is_read && email.direction === 'inbound' ? 'font-medium' : ''}`}
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
        onClick={() => {
          setComposing(true);
          setReplyData({ to: '', subject: '', body: '' });
          loadContacts();
        }}
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
