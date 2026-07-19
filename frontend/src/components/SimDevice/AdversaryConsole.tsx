import { useState, useEffect, useCallback } from 'react';
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

interface OrgPage {
  org_key: string;
  display_name: string;
  role?: string;
  control_mode?: string;
  facebook?: { page_handle?: string } | null;
  x_twitter?: { page_handle?: string } | null;
}

/**
 * Trainer-only console for the antagonist (rival) brand pages. Lists each AI/seized
 * rival, lets the trainer seize/release control, and post hostile content as the page.
 */
export function AdversaryConsole({ sessionId }: { sessionId: string }) {
  const [pages, setPages] = useState<OrgPage[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [platform, setPlatform] = useState<Record<string, 'x_twitter' | 'facebook'>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!sessionId) return;
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(apiUrl(`/api/social/pages/session/${sessionId}`), { headers });
      const json = await res.json();
      const all = (json.data || []) as OrgPage[];
      setPages(all.filter((p) => (p.role ?? 'protagonist') === 'antagonist'));
    } catch {
      /* ignore */
    }
  }, [sessionId]);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  const seize = useCallback(
    async (orgKey: string, mode: 'ai' | 'trainer') => {
      setBusy(orgKey);
      try {
        const headers = await getAuthHeaders();
        await fetch(apiUrl(`/api/social/pages/session/${sessionId}/seize`), {
          method: 'POST',
          headers,
          body: JSON.stringify({ org_key: orgKey, control_mode: mode }),
        });
        await load();
      } finally {
        setBusy(null);
      }
    },
    [sessionId, load],
  );

  const postAs = useCallback(
    async (orgKey: string) => {
      const content = (draft[orgKey] || '').trim();
      if (!content) return;
      setBusy(orgKey);
      try {
        const headers = await getAuthHeaders();
        await fetch(apiUrl(`/api/social/pages/session/${sessionId}/post-as`), {
          method: 'POST',
          headers,
          body: JSON.stringify({
            org_key: orgKey,
            platform: platform[orgKey] || 'x_twitter',
            content,
          }),
        });
        setDraft((d) => ({ ...d, [orgKey]: '' }));
      } finally {
        setBusy(null);
      }
    },
    [sessionId, draft, platform],
  );

  return (
    <div
      className="rounded-xl border overflow-hidden flex flex-col"
      style={{ backgroundColor: '#FFFFFF', borderColor: '#E4DFD4' }}
    >
      <div
        className="px-4 py-2.5 border-b text-xs font-semibold tracking-wider uppercase flex items-center justify-between"
        style={{ borderColor: '#E4DFD4', color: '#6B7280' }}
      >
        <span>Adversary Console ({pages.length})</span>
        <span
          className="text-[10px] font-bold px-1.5 py-0.5 rounded"
          style={{ backgroundColor: 'rgba(185,28,28,0.12)', color: '#B91C1C' }}
        >
          rivals
        </span>
      </div>
      <div className="flex-1 p-4 overflow-y-auto space-y-3">
        {pages.length === 0 && (
          <div className="text-[12px]" style={{ color: '#6B7280' }}>
            No antagonist pages in this scenario.
          </div>
        )}
        {pages.map((p) => {
          const mode = p.control_mode === 'trainer' ? 'trainer' : 'ai';
          const handle = p.x_twitter?.page_handle || p.facebook?.page_handle || '';
          return (
            <div
              key={p.org_key}
              className="rounded-lg p-3"
              style={{
                backgroundColor: '#FAF8F4',
                border: '1px solid #E4DFD4',
                borderLeft: '3px solid #B91C1C',
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <div>
                  <span className="text-[13px] font-semibold" style={{ color: '#172033' }}>
                    {p.display_name}
                  </span>{' '}
                  <span className="text-[11px]" style={{ color: '#6B7280' }}>
                    {handle}
                  </span>
                </div>
                <button
                  onClick={() => seize(p.org_key, mode === 'trainer' ? 'ai' : 'trainer')}
                  disabled={busy === p.org_key}
                  className="text-[10px] font-bold uppercase px-2.5 py-1 rounded border disabled:opacity-50"
                  style={
                    mode === 'trainer'
                      ? {
                          color: '#D97706',
                          borderColor: 'rgba(217,119,6,0.4)',
                          backgroundColor: 'rgba(217,119,6,0.1)',
                        }
                      : {
                          color: '#1E3A5F',
                          borderColor: 'rgba(30,58,95,0.35)',
                          backgroundColor: 'rgba(30,58,95,0.07)',
                        }
                  }
                >
                  {mode === 'trainer' ? 'Seized · release to AI' : 'AI · seize'}
                </button>
              </div>

              {mode === 'trainer' && (
                <div
                  className="mt-2 rounded-lg p-2"
                  style={{ backgroundColor: '#FFFFFF', border: '1px solid #E4DFD4' }}
                >
                  <div className="flex gap-1 mb-1">
                    {(['x_twitter', 'facebook'] as const).map((pf) => (
                      <button
                        key={pf}
                        onClick={() => setPlatform((s) => ({ ...s, [p.org_key]: pf }))}
                        className="text-[10px] px-2 py-0.5 rounded"
                        style={
                          (platform[p.org_key] || 'x_twitter') === pf
                            ? { backgroundColor: '#1E3A5F', color: '#FFFFFF' }
                            : { color: '#6B7280' }
                        }
                      >
                        {pf === 'x_twitter' ? 'X' : 'Facebook'}
                      </button>
                    ))}
                  </div>
                  <textarea
                    rows={2}
                    value={draft[p.org_key] || ''}
                    onChange={(e) => setDraft((d) => ({ ...d, [p.org_key]: e.target.value }))}
                    placeholder={`Post as ${p.display_name}...`}
                    className="w-full bg-transparent text-[12px] outline-none resize-none"
                    style={{ color: '#172033' }}
                  />
                  <div className="text-right">
                    <button
                      onClick={() => postAs(p.org_key)}
                      disabled={busy === p.org_key || !(draft[p.org_key] || '').trim()}
                      className="text-[11px] font-bold px-3 py-1 rounded disabled:opacity-50"
                      style={{ backgroundColor: '#B91C1C', color: '#fff' }}
                    >
                      Post as page
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
