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

  function getStatusStyle(status: string): { bg: string; text: string } {
    switch (status) {
      case 'published':
        return { bg: '#E8F5E9', text: '#34C759' };
      case 'approved':
        return { bg: '#E3F2FD', text: '#007AFF' };
      case 'submitted':
        return { bg: '#FFF8E1', text: '#FF9500' };
      default:
        return { bg: '#F2F2F7', text: '#8E8E93' };
    }
  }

  // Editor View
  if (editing) {
    return (
      <div className="h-full flex flex-col" style={{ backgroundColor: '#F2F2F7' }}>
        {/* Nav */}
        <div
          className="flex items-center justify-between px-4 ios-blur-nav"
          style={{
            height: 44,
            backgroundColor: 'rgba(242,242,247,0.85)',
            borderBottom: '0.5px solid #C6C6C8',
          }}
        >
          <button
            onClick={() => setEditing(false)}
            className="text-[17px] ios-btn-bounce"
            style={{ color: '#007AFF' }}
          >
            Cancel
          </button>
          <div className="flex items-center gap-3">
            <button
              onClick={saveDraft}
              className="text-[15px] font-medium ios-btn-bounce"
              style={{ color: '#007AFF' }}
            >
              Save
            </button>
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
              className="px-3 py-1 rounded-full text-[14px] font-semibold text-white ios-btn-bounce"
              style={{ backgroundColor: '#007AFF' }}
            >
              Publish
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Title */}
          <div style={{ backgroundColor: '#FFFFFF', borderBottom: '0.5px solid #C6C6C8' }}>
            <input
              value={currentDraft.title}
              onChange={(e) => setCurrentDraft({ ...currentDraft, title: e.target.value })}
              placeholder="Title..."
              className="w-full px-4 py-3 text-[22px] font-bold outline-none"
              style={{ color: '#000000' }}
            />
          </div>

          {/* Content */}
          <div style={{ backgroundColor: '#FFFFFF' }}>
            <textarea
              value={currentDraft.content}
              onChange={(e) => setCurrentDraft({ ...currentDraft, content: e.target.value })}
              placeholder="Write your official response..."
              className="w-full px-4 py-3 text-[15px] outline-none resize-none min-h-[200px]"
              style={{ color: '#1C1C1E', lineHeight: 1.5 }}
              autoFocus
            />
          </div>

          {/* Grade Card */}
          {grade && (
            <div
              className="mx-4 mt-4 rounded-xl overflow-hidden"
              style={{ backgroundColor: '#FFFFFF' }}
            >
              <div className="px-4 py-3" style={{ borderBottom: '0.5px solid #E5E5EA' }}>
                <div className="flex items-center gap-2">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="#5856D6">
                    <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                  </svg>
                  <span className="text-[17px] font-bold" style={{ color: '#000000' }}>
                    AI Grade
                  </span>
                </div>
              </div>
              <div className="p-4 grid grid-cols-2 gap-3">
                {[
                  'accuracy',
                  'tone',
                  'cultural_sensitivity',
                  'persuasiveness',
                  'completeness',
                  'overall',
                ].map((key) => {
                  const score = Number(grade[key]) || 0;
                  return (
                    <div key={key} className="flex items-center justify-between">
                      <span className="text-[13px] capitalize" style={{ color: '#8E8E93' }}>
                        {key.replace('_', ' ')}
                      </span>
                      <span
                        className="text-[15px] font-bold"
                        style={{ color: getScoreColor(score) }}
                      >
                        {String(grade[key])}/100
                      </span>
                    </div>
                  );
                })}
              </div>
              {typeof grade.feedback === 'string' && grade.feedback.length > 0 && (
                <div className="px-4 pb-4">
                  <p
                    className="text-[13px] leading-relaxed"
                    style={{ color: '#6C6C70', borderTop: '0.5px solid #E5E5EA', paddingTop: 12 }}
                  >
                    {grade.feedback}
                  </p>
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
        className="ios-blur-nav"
        style={{ backgroundColor: 'rgba(242,242,247,0.85)', borderBottom: '0.5px solid #C6C6C8' }}
      >
        <div className="flex items-center justify-between px-4" style={{ height: 44 }}>
          <button
            onClick={() => navigate(`/sim/${sessionId}/device/home`)}
            className="flex items-center gap-1 ios-btn-bounce"
            style={{ color: '#FF9500' }}
          >
            <svg width="10" height="16" viewBox="0 0 10 16" fill="none">
              <path
                d="M9 1L2 8l7 7"
                stroke="#FF9500"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="text-[17px]">Home</span>
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
          <h1 className="ios-large-title" style={{ color: '#000000' }}>
            DraftPad
          </h1>
        </div>
      </div>

      {/* Drafts */}
      <div className="flex-1 overflow-y-auto">
        {drafts.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 gap-3">
            <svg
              width="56"
              height="56"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#C7C7CC"
              strokeWidth="1"
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
              <polyline points="10 9 9 9 8 9" />
            </svg>
            <p className="text-[15px]" style={{ color: '#8E8E93' }}>
              No drafts yet
            </p>
            <button
              onClick={createNew}
              className="px-4 py-2 rounded-full text-[15px] font-semibold text-white ios-btn-bounce"
              style={{ backgroundColor: '#FF9500' }}
            >
              Create Your First Draft
            </button>
          </div>
        ) : (
          <div
            className="mx-4 mt-3 rounded-xl overflow-hidden"
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
                  className="w-full text-left px-4 py-3 ios-btn-bounce"
                  style={{ borderBottom: idx < drafts.length - 1 ? '0.5px solid #C6C6C8' : 'none' }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className="text-[15px] font-semibold truncate"
                      style={{ color: '#000000' }}
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
                  <p className="text-[13px] mt-0.5 truncate" style={{ color: '#8E8E93' }}>
                    {draft.content.substring(0, 80)}
                  </p>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
