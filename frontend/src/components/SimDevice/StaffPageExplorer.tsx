import { useEffect, useState } from 'react';
import { PageModeProvider } from '../../contexts/PageModeContext';
import { getAuthHeaders } from '../../lib/api';
import {
  explorerPageGroups,
  explorerPages,
  pageExplorerVisible,
  type ExplorerPage,
} from '../../lib/simSpectator';
import FacebookMessengerView from './FacebookMessengerView';
import OrgPageView from './OrgPageView';

const API_BASE = import.meta.env.VITE_API_URL || '';

function apiUrl(path: string): string {
  const clean = path.startsWith('/') ? path : `/${path}`;
  return API_BASE ? `${API_BASE.replace(/\/$/, '')}${clean}` : clean;
}

/**
 * Trainer-console list of every org page and its inbox.
 * Hidden when the page-inbox probe answers 404 (ENABLE_STAFF_PAGE_EXPLORER off).
 * Reads go through getAuthHeaders with the spectator frame. Live and concluded.
 */
export function StaffPageExplorer({
  sessionId,
  initialPane = 'profile',
}: {
  sessionId: string;
  /** Opens the profile or the inbox. The trainer console starts on the profile. */
  initialPane?: 'profile' | 'inbox';
}) {
  const [visible, setVisible] = useState(false);
  const [pages, setPages] = useState<ExplorerPage[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [pane, setPane] = useState<'profile' | 'inbox'>(initialPane);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setVisible(false);
    setError(false);
    (async () => {
      try {
        const headers = await getAuthHeaders({ sessionId, spectator: true });
        const probe = await fetch(apiUrl(`/api/social/messenger/page-inbox/${sessionId}`), {
          headers,
        });
        if (cancelled) return;
        if (!pageExplorerVisible(probe.status)) return;
        setVisible(true);
        const pagesRes = await fetch(apiUrl(`/api/social/pages/session/${sessionId}`), {
          headers,
        });
        if (!pagesRes.ok) {
          setError(true);
          return;
        }
        const list = explorerPages(explorerPageGroups(await pagesRes.json()));
        if (cancelled) return;
        setPages(list);
        setSelectedKey(list[0] ? pageKey(list[0]) : null);
      } catch {
        if (!cancelled) {
          setVisible(true);
          setError(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (!visible) return null;

  const selected = pages.find((page) => pageKey(page) === selectedKey) ?? null;

  return (
    <section
      aria-label="Pages"
      className="rounded-xl border overflow-hidden"
      style={{ backgroundColor: '#FFFFFF', borderColor: '#E4DFD4' }}
    >
      <div
        className="px-4 py-2.5 border-b text-xs font-semibold tracking-wider uppercase"
        style={{ borderColor: '#E4DFD4', color: '#6B7280' }}
      >
        Pages
      </div>
      <div className="p-4">
        <p className="text-[11px] mb-3" style={{ color: '#64748b' }}>
          Read-only profiles and inboxes for every organisation page, including AI-operated, rival
          and pressure pages. Nothing sent from here is delivered.
        </p>
        {error && (
          <p className="text-xs mb-3" style={{ color: '#B91C1C' }}>
            Could not load organisation pages.
          </p>
        )}
        {pages.length === 0 && !error ? (
          <p className="text-xs text-center py-6" style={{ color: '#64748b' }}>
            No organisation pages in this session.
          </p>
        ) : (
          <div className="grid gap-4" style={{ gridTemplateColumns: '220px 1fr' }}>
            <ul className="space-y-1" aria-label="Organisation pages">
              {pages.map((page) => {
                const key = pageKey(page);
                const active = key === selectedKey;
                return (
                  <li key={key}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedKey(key);
                        setPane('profile');
                      }}
                      className="w-full text-left rounded px-2.5 py-2"
                      style={{
                        backgroundColor: active ? 'rgba(30,58,95,0.08)' : 'transparent',
                        color: '#111827',
                      }}
                      aria-pressed={active}
                    >
                      <span className="block text-xs font-semibold">{page.pageName}</span>
                      <span className="block text-[10px]" style={{ color: '#64748b' }}>
                        {platformLabel(page.platform)}
                        {page.role ? ` · ${page.role}` : ''}
                        {page.controlMode ? ` · ${page.controlMode}` : ''}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {selected && (
              <div>
                <div className="flex gap-2 mb-2">
                  <PaneButton
                    label="Profile"
                    active={pane === 'profile'}
                    onClick={() => setPane('profile')}
                  />
                  <PaneButton
                    label="Inbox"
                    active={pane === 'inbox'}
                    onClick={() => setPane('inbox')}
                  />
                </div>
                <div
                  className="rounded-lg border overflow-hidden"
                  style={{ borderColor: '#E4DFD4', height: 560 }}
                >
                  <PageModeProvider>
                    {pane === 'profile' ? (
                      <OrgPageView
                        platform={selected.platform}
                        viewHandle={selected.pageHandle}
                        readOnly
                      />
                    ) : (
                      <FacebookMessengerView
                        sessionId={sessionId}
                        readOnly
                        pageHandle={selected.pageHandle}
                        orgKey={selected.orgKey}
                        platform={selected.platform}
                      />
                    )}
                  </PageModeProvider>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function pageKey(page: ExplorerPage): string {
  return `${page.orgKey}:${page.platform}`;
}

function platformLabel(platform: ExplorerPage['platform']): string {
  return platform === 'x_twitter' ? 'X' : 'Facebook';
}

function PaneButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-[11px] font-semibold px-3 py-1.5 rounded"
      style={{
        backgroundColor: active ? '#1E3A5F' : '#F3F4F6',
        color: active ? '#FFFFFF' : '#374151',
      }}
    >
      {label}
    </button>
  );
}
