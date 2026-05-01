import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
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

interface Draft {
  id: string;
  title: string;
  content: string;
  status: 'draft' | 'submitted' | 'approved' | 'published';
  grade?: Record<string, unknown>;
  created_at: string;
}

export default function DraftPadApp() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [editing, setEditing] = useState(false);
  const [currentDraft, setCurrentDraft] = useState({ title: '', content: '' });
  const [grading, setGrading] = useState(false);
  const [grade, setGrade] = useState<Record<string, unknown> | null>(null);

  function createNew() {
    setCurrentDraft({ title: '', content: '' });
    setGrade(null);
    setEditing(true);
  }

  function saveDraft() {
    const draft: Draft = {
      id: crypto.randomUUID(),
      title: currentDraft.title || 'Untitled Draft',
      content: currentDraft.content,
      status: 'draft',
      created_at: new Date().toISOString(),
    };
    setDrafts((prev) => [draft, ...prev]);
    setEditing(false);
  }

  async function gradeDraft() {
    if (!sessionId || !currentDraft.content.trim()) return;
    setGrading(true);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(apiUrl('/api/social/grade'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          session_id: sessionId,
          content: currentDraft.content,
        }),
      });
      const result = await res.json();
      setGrade(result.data);
    } catch {
      /* ignore */
    } finally {
      setGrading(false);
    }
  }

  async function publishDraft() {
    if (!sessionId || !currentDraft.content.trim()) return;
    try {
      const headers = await getAuthHeaders();
      await fetch(apiUrl('/api/social/posts'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          session_id: sessionId,
          content: currentDraft.content,
        }),
      });
      setEditing(false);
      setDrafts((prev) =>
        prev.map((d) =>
          d.content === currentDraft.content ? { ...d, status: 'published' as const } : d,
        ),
      );
    } catch {
      /* ignore */
    }
  }

  function getScoreColor(score: number): string {
    if (score >= 70) return '#34C759';
    if (score >= 40) return '#FF9500';
    return '#FF3B30';
  }

  function getScoreBg(score: number): string {
    if (score >= 70) return 'rgba(52,199,89,0.12)';
    if (score >= 40) return 'rgba(255,149,0,0.12)';
    return 'rgba(255,59,48,0.12)';
  }

  function getStatusStyle(status: string): { bg: string; text: string } {
    switch (status) {
      case 'published':
        return { bg: 'rgba(52,199,89,0.12)', text: '#34C759' };
      case 'approved':
        return { bg: 'rgba(0,122,255,0.12)', text: '#007AFF' };
      case 'submitted':
        return { bg: 'rgba(255,149,0,0.12)', text: '#FF9500' };
      default:
        return { bg: 'rgba(142,142,147,0.12)', text: '#8E8E93' };
    }
  }

  function formatDate(dateStr: string): string {
    const d = new Date(dateStr);
    return d.toLocaleDateString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  // Editor View
  if (editing) {
    return (
      <div className="h-full flex flex-col" style={{ backgroundColor: '#FFFFFF' }}>
        {/* Nav */}
        <div
          className="flex items-center justify-between px-4 ios-blur-nav flex-shrink-0"
          style={{
            height: 44,
            backgroundColor: 'rgba(255,255,255,0.92)',
            borderBottom: '0.5px solid rgba(60,60,67,0.18)',
            backdropFilter: 'blur(20px)',
          }}
        >
          <button
            onClick={() => setEditing(false)}
            className="flex items-center gap-0.5 ios-btn-bounce"
            style={{ color: '#FF9500' }}
          >
            <svg width="12" height="20" viewBox="0 0 12 20" fill="none">
              <path
                d="M10 2L2 10l8 8"
                stroke="#FF9500"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="text-[17px]">Notes</span>
          </button>
          <div className="flex items-center gap-3">
            <button
              onClick={gradeDraft}
              disabled={grading}
              className="text-[15px] font-medium ios-btn-bounce"
              style={{ color: '#5856D6' }}
            >
              {grading ? 'Grading...' : 'Grade'}
            </button>
            <button
              onClick={publishDraft}
              className="text-[15px] font-semibold ios-btn-bounce"
              style={{ color: '#FF9500' }}
            >
              Publish
            </button>
            <button onClick={saveDraft} className="ios-btn-bounce" style={{ color: '#FF9500' }}>
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                <polyline points="17 21 17 13 7 13 7 21" />
                <polyline points="7 3 7 8 15 8" />
              </svg>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto" style={{ backgroundColor: '#FFFFFF' }}>
          {/* Title */}
          <input
            value={currentDraft.title}
            onChange={(e) => setCurrentDraft({ ...currentDraft, title: e.target.value })}
            placeholder="Title"
            className="w-full px-5 pt-5 pb-1 text-[24px] font-bold outline-none placeholder:text-[#C7C7CC]"
            style={{ color: '#1C1C1E' }}
          />

          {/* Date line */}
          <p className="px-5 pb-3 text-[13px]" style={{ color: '#8E8E93' }}>
            {new Date().toLocaleDateString([], {
              weekday: 'long',
              month: 'long',
              day: 'numeric',
              year: 'numeric',
            })}
          </p>

          {/* Content */}
          <textarea
            value={currentDraft.content}
            onChange={(e) => setCurrentDraft({ ...currentDraft, content: e.target.value })}
            placeholder="Start writing your official response..."
            className="w-full px-5 text-[16px] outline-none resize-none min-h-[200px] placeholder:text-[#C7C7CC]"
            style={{ color: '#1C1C1E', lineHeight: '1.6' }}
            autoFocus
          />

          {/* Grade Card */}
          {grade && (
            <div
              className="mx-4 mt-4 mb-4 rounded-xl overflow-hidden"
              style={{ backgroundColor: '#F2F2F7' }}
            >
              <div
                className="px-4 py-3 flex items-center gap-2"
                style={{ borderBottom: '0.5px solid rgba(60,60,67,0.12)' }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="#5856D6">
                  <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                </svg>
                <span className="text-[15px] font-semibold" style={{ color: '#1C1C1E' }}>
                  AI Grade
                </span>
              </div>
              <div className="p-4 space-y-2.5">
                {[
                  'accuracy',
                  'tone',
                  'cultural_sensitivity',
                  'persuasiveness',
                  'completeness',
                  'overall',
                ].map((key) => {
                  const score = Number(grade[key]) || 0;
                  const color = getScoreColor(score);
                  const bg = getScoreBg(score);
                  return (
                    <div key={key} className="flex items-center justify-between">
                      <span className="text-[14px] capitalize" style={{ color: '#6C6C70' }}>
                        {key.replace('_', ' ')}
                      </span>
                      <span
                        className="text-[14px] font-bold px-2.5 py-0.5 rounded-md"
                        style={{ color, backgroundColor: bg }}
                      >
                        {String(grade[key])}/100
                      </span>
                    </div>
                  );
                })}
              </div>
              {typeof grade.feedback === 'string' && grade.feedback.length > 0 && (
                <div className="px-4 pb-4">
                  <div style={{ borderTop: '0.5px solid rgba(60,60,67,0.12)', paddingTop: 12 }}>
                    <p className="text-[13px] leading-relaxed" style={{ color: '#6C6C70' }}>
                      {grade.feedback}
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Draft List
  return (
    <div className="h-full flex flex-col" style={{ backgroundColor: '#F2F2F7' }}>
      {/* Nav */}
      <div
        className="ios-blur-nav flex-shrink-0"
        style={{
          backgroundColor: 'rgba(242,242,247,0.92)',
          borderBottom: '0.5px solid rgba(60,60,67,0.18)',
          backdropFilter: 'blur(20px)',
        }}
      >
        <div className="flex items-center justify-between px-4" style={{ height: 44 }}>
          <button
            onClick={() => navigate(`/sim/${sessionId}/device/home`)}
            className="flex items-center gap-0.5 ios-btn-bounce"
            style={{ color: '#FF9500' }}
          >
            <svg width="12" height="20" viewBox="0 0 12 20" fill="none">
              <path
                d="M10 2L2 10l8 8"
                stroke="#FF9500"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="text-[17px]">Back</span>
          </button>
          <button onClick={createNew} className="ios-btn-bounce" style={{ color: '#FF9500' }}>
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#FF9500"
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
            Notes
          </h1>
        </div>
      </div>

      {/* Drafts */}
      <div className="flex-1 overflow-y-auto">
        {drafts.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 gap-3">
            <svg
              width="52"
              height="52"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#C7C7CC"
              strokeWidth="0.8"
            >
              <rect x="4" y="2" width="16" height="20" rx="2" />
              <line x1="8" y1="6" x2="16" y2="6" />
              <line x1="8" y1="10" x2="16" y2="10" />
              <line x1="8" y1="14" x2="12" y2="14" />
            </svg>
            <p className="text-[17px] font-semibold" style={{ color: '#3C3C43' }}>
              No Notes
            </p>
            <p className="text-[14px]" style={{ color: '#8E8E93' }}>
              Your draft responses will appear here.
            </p>
            <button
              onClick={createNew}
              className="mt-1 px-5 py-2 rounded-full text-[15px] font-semibold text-white ios-btn-bounce"
              style={{ backgroundColor: '#FF9500' }}
            >
              New Note
            </button>
          </div>
        ) : (
          <div>
            {/* Section header */}
            <p
              className="text-[13px] font-normal px-8 pb-2 pt-4 uppercase"
              style={{ color: '#6C6C70', letterSpacing: '0.02em' }}
            >
              {drafts.length} {drafts.length === 1 ? 'Note' : 'Notes'}
            </p>
            <div
              className="mx-4 rounded-[10px] overflow-hidden"
              style={{ backgroundColor: '#FFFFFF' }}
            >
              {drafts.map((draft, idx) => {
                const statusStyle = getStatusStyle(draft.status);
                return (
                  <button
                    key={draft.id}
                    onClick={() => {
                      setCurrentDraft({ title: draft.title, content: draft.content });
                      setGrade(draft.grade || null);
                      setEditing(true);
                    }}
                    className="w-full text-left flex items-center px-4 py-3 ios-btn-bounce active:bg-gray-50"
                    style={{
                      borderBottom:
                        idx < drafts.length - 1 ? '0.5px solid rgba(60,60,67,0.12)' : 'none',
                    }}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className="text-[15px] font-semibold truncate"
                          style={{ color: '#1C1C1E' }}
                        >
                          {draft.title}
                        </span>
                        <span
                          className="text-[11px] font-semibold px-2 py-0.5 rounded-full flex-shrink-0"
                          style={{ backgroundColor: statusStyle.bg, color: statusStyle.text }}
                        >
                          {draft.status}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[13px]" style={{ color: '#8E8E93' }}>
                          {formatDate(draft.created_at)}
                        </span>
                        <span className="text-[13px] truncate" style={{ color: '#AEAEB2' }}>
                          {draft.content.substring(0, 50)}
                        </span>
                      </div>
                    </div>
                    {/* Chevron */}
                    <svg
                      width="7"
                      height="12"
                      viewBox="0 0 7 12"
                      fill="none"
                      className="flex-shrink-0 ml-2"
                    >
                      <path
                        d="M1 1l5 5-5 5"
                        stroke="#C7C7CC"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
