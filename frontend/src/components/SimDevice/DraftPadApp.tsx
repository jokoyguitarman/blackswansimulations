import React, { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
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
  const { user } = useAuth();
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

  if (editing) {
    return (
      <div className="h-full flex flex-col bg-gray-950 text-white">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <button onClick={() => setEditing(false)} className="text-yellow-400 text-sm">
            ← Back
          </button>
          <div className="flex gap-2">
            <button onClick={saveDraft} className="text-yellow-400 text-sm font-medium">
              Save
            </button>
            <button
              onClick={gradeDraft}
              disabled={grading}
              className="text-blue-400 text-sm font-medium"
            >
              {grading ? 'Grading...' : 'Grade'}
            </button>
            <button
              onClick={publishDraft}
              className="bg-green-600 text-white px-3 py-1 rounded text-sm font-medium"
            >
              Publish
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          <input
            value={currentDraft.title}
            onChange={(e) => setCurrentDraft({ ...currentDraft, title: e.target.value })}
            placeholder="Draft title..."
            className="w-full bg-gray-900 text-white px-3 py-2 rounded border border-gray-800 text-sm"
          />
          <textarea
            value={currentDraft.content}
            onChange={(e) => setCurrentDraft({ ...currentDraft, content: e.target.value })}
            placeholder="Write your official response..."
            className="w-full bg-gray-900 text-white px-3 py-2 rounded border border-gray-800 text-sm min-h-[200px] resize-none"
          />
          {grade && (
            <div className="bg-gray-900 rounded-lg p-3 border border-gray-800 space-y-2">
              <h4 className="text-sm font-bold text-yellow-400">AI Grade</h4>
              <div className="grid grid-cols-2 gap-2 text-xs">
                {[
                  'accuracy',
                  'tone',
                  'cultural_sensitivity',
                  'persuasiveness',
                  'completeness',
                  'overall',
                ].map((key) => (
                  <div key={key} className="flex justify-between">
                    <span className="text-gray-400 capitalize">{key.replace('_', ' ')}</span>
                    <span
                      className={`font-bold ${(grade[key] as number) >= 70 ? 'text-green-400' : (grade[key] as number) >= 40 ? 'text-yellow-400' : 'text-red-400'}`}
                    >
                      {grade[key] as number}/100
                    </span>
                  </div>
                ))}
              </div>
              {grade.feedback && (
                <p className="text-xs text-gray-300 mt-2">{grade.feedback as string}</p>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-gray-950 text-white">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
        <button
          onClick={() => navigate(`/sim/${sessionId}/device/home`)}
          className="text-yellow-400 text-sm"
        >
          ← Home
        </button>
        <span className="font-bold">DraftPad</span>
        <button onClick={createNew} className="text-yellow-400 text-sm font-medium">
          + New
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {drafts.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-gray-500 text-sm gap-2">
            <p>No drafts yet</p>
            <button onClick={createNew} className="text-yellow-400 text-sm">
              Create your first draft
            </button>
          </div>
        ) : (
          drafts.map((draft) => (
            <button
              key={draft.id}
              onClick={() => {
                setCurrentDraft({ title: draft.title, content: draft.content });
                setGrade(draft.grade || null);
                setEditing(true);
              }}
              className="w-full text-left px-4 py-3 border-b border-gray-800 hover:bg-gray-900"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium truncate">{draft.title}</span>
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded ${draft.status === 'published' ? 'bg-green-900 text-green-400' : draft.status === 'approved' ? 'bg-blue-900 text-blue-400' : 'bg-gray-800 text-gray-400'}`}
                >
                  {draft.status}
                </span>
              </div>
              <p className="text-xs text-gray-500 mt-0.5 truncate">
                {draft.content.substring(0, 80)}
              </p>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
