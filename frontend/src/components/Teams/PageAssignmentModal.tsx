import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { api } from '../../lib/api';

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

interface PageAssignmentModalProps {
  sessionId: string;
  onClose: () => void;
  onSuccess?: () => void;
}

interface Participant {
  user_id: string;
  user?: { id: string; full_name: string };
}

interface OrgPage {
  org_key: string;
  display_name: string;
  is_primary: boolean;
  role?: string;
  control_mode?: string;
  controllers: string[];
}

export const PageAssignmentModal = ({
  sessionId,
  onClose,
  onSuccess,
}: PageAssignmentModalProps) => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [pages, setPages] = useState<OrgPage[]>([]);
  // userId -> org_key ('' = none)
  const [selection, setSelection] = useState<Record<string, string>>({});

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const sessionResult = await api.sessions.get(sessionId);
      const session = sessionResult.data as { participants?: Participant[] };
      const parts = session?.participants || [];
      setParticipants(parts);

      const headers = await getAuthHeaders();
      const res = await fetch(apiUrl(`/api/social/pages/session/${sessionId}`), { headers });
      const json = await res.json();
      // Players may only be assigned protagonist pages; antagonist (rival) pages
      // are trainer/AI-driven and excluded from the assignment pool.
      const loadedPages = ((json.data || []) as OrgPage[]).filter(
        (pg) => (pg.role ?? 'protagonist') !== 'antagonist',
      );
      setPages(loadedPages);

      const initial: Record<string, string> = {};
      for (const p of parts) {
        const page = loadedPages.find((pg) => pg.controllers?.includes(p.user_id));
        initial[p.user_id] = page?.org_key || '';
      }
      setSelection(initial);
    } catch (error) {
      console.error('Failed to load page assignment data:', error);
      alert('Failed to load data');
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const getUserName = (userId: string): string => {
    const participant = participants.find((p) => p.user_id === userId);
    return participant?.user?.full_name ?? userId;
  };

  const handleChange = async (userId: string, orgKey: string) => {
    setSelection((prev) => ({ ...prev, [userId]: orgKey }));
    setSaving(true);
    try {
      const headers = await getAuthHeaders();
      if (orgKey) {
        await fetch(apiUrl(`/api/social/pages/session/${sessionId}/assign`), {
          method: 'POST',
          headers,
          body: JSON.stringify({ user_id: userId, org_key: orgKey }),
        });
      } else {
        await fetch(apiUrl(`/api/social/pages/session/${sessionId}/assign`), {
          method: 'DELETE',
          headers,
          body: JSON.stringify({ user_id: userId }),
        });
      }
      onSuccess?.();
    } catch {
      alert(`Failed to update page assignment for ${getUserName(userId)}`);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="fixed inset-0 bg-ink/40 backdrop-blur-sm flex items-center justify-center z-50">
        <div className="bg-surface border border-border rounded-2xl shadow-lg p-8">
          <p className="terminal-text text-ink">Loading…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-ink/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-surface border border-border rounded-2xl shadow-lg p-6 max-w-3xl w-full max-h-[90vh] flex flex-col">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl terminal-text">Page assignments</h2>
          {saving && (
            <span className="text-xs terminal-text text-accent px-2 py-1 border border-accent/50 rounded">
              saving…
            </span>
          )}
        </div>

        {pages.length === 0 ? (
          <p className="terminal-text text-muted py-8 text-center">
            No org pages exist for this session yet. Pages are created from the scenario when the
            session begins.
          </p>
        ) : (
          <div className="flex-1 overflow-y-auto min-h-0 space-y-1 pr-1">
            <div className="grid grid-cols-2 gap-2 items-center sticky top-0 bg-surface z-10 py-2 border-b border-border">
              <div className="text-xs terminal-text text-muted uppercase">Participant</div>
              <div className="text-xs terminal-text text-muted uppercase">Controls Page</div>
            </div>

            {participants.map((participant) => (
              <div
                key={participant.user_id}
                className="grid grid-cols-2 gap-2 items-center py-2 border-b border-border"
              >
                <div className="text-sm terminal-text font-medium truncate">
                  {getUserName(participant.user_id)}
                </div>
                <select
                  value={selection[participant.user_id] || ''}
                  onChange={(e) => handleChange(participant.user_id, e.target.value)}
                  className="military-input terminal-text text-sm px-2 py-1"
                >
                  <option value="">None</option>
                  {pages.map((pg) => (
                    <option key={pg.org_key} value={pg.org_key}>
                      {pg.display_name}
                      {pg.is_primary ? ' (crisis page)' : ''}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-4 pt-4 mt-2 border-t border-border flex-shrink-0">
          <button onClick={onClose} disabled={saving} className="military-button px-6 py-3 flex-1">
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
