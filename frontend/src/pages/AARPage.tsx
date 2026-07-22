import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AARDashboard } from '../components/AAR/AARDashboard';
import { api } from '../lib/api';

/**
 * Dedicated full-page After-Action Report. Gives the report its own route and
 * the full viewport width instead of living inside a tab/container — trainers
 * arrive from the sim review dashboard, participants from the session view.
 */
export default function AARPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [sessionName, setSessionName] = useState<string>('');

  useEffect(() => {
    if (!id) return;
    api.sessions
      .get(id)
      .then((res) => {
        const data = res.data as Record<string, unknown> | undefined;
        const name = (data?.name as string) || (data?.title as string) || '';
        if (name) setSessionName(name);
      })
      .catch(() => {});
  }, [id]);

  if (!id) return null;

  return (
    <div className="min-h-screen bg-bg">
      <header className="sticky top-0 z-30 bg-bg/95 backdrop-blur border-b border-border">
        <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={() => navigate(-1)}
              className="military-button px-3 py-1.5 text-sm whitespace-nowrap"
            >
              ← Back
            </button>
            <div className="min-w-0">
              <div className="text-[10px] font-extrabold uppercase tracking-widest text-muted">
                After-Action Report
              </div>
              {sessionName && (
                <div className="text-sm font-extrabold text-brand truncate">{sessionName}</div>
              )}
            </div>
          </div>
        </div>
      </header>
      <main className="max-w-screen-2xl mx-auto px-4 sm:px-6 py-6">
        <AARDashboard sessionId={id} />
      </main>
    </div>
  );
}
