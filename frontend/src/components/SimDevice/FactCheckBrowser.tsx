import { useState, useEffect } from 'react';
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

interface FactEntry {
  claim: string;
  status: string;
  truth: string;
}

export default function FactCheckBrowser() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const [facts, setFacts] = useState<{ confirmed: string[]; unconfirmed: FactEntry[] }>({
    confirmed: [],
    unconfirmed: [],
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'confirmed' | 'claims'>('confirmed');

  useEffect(() => {
    loadFacts();
  }, [sessionId]);

  async function loadFacts() {
    if (!sessionId) return;
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(apiUrl(`/api/sessions/${sessionId}`), { headers });
      const result = await res.json();
      const scenario = result?.data?.scenario;
      const initialState = scenario?.initial_state || {};
      const factSheet = initialState.fact_sheet || {};
      setFacts({
        confirmed: factSheet.confirmed_facts || [],
        unconfirmed: factSheet.unconfirmed_claims || [],
      });
    } catch {
      /* ignore */
    }
  }

  const filteredConfirmed = facts.confirmed.filter((f) =>
    f.toLowerCase().includes(searchQuery.toLowerCase()),
  );
  const filteredUnconfirmed = facts.unconfirmed.filter(
    (f) =>
      f.claim.toLowerCase().includes(searchQuery.toLowerCase()) ||
      f.truth.toLowerCase().includes(searchQuery.toLowerCase()),
  );

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
            style={{ color: '#5856D6' }}
          >
            <svg width="10" height="16" viewBox="0 0 10 16" fill="none">
              <path
                d="M9 1L2 8l7 7"
                stroke="#5856D6"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="text-[17px]">Home</span>
          </button>
          <div style={{ width: 44 }} />
        </div>
        <div className="px-4 pb-2">
          <h1 className="ios-large-title" style={{ color: '#000000' }}>
            FactCheck
          </h1>
        </div>
      </div>

      {/* Search */}
      <div className="px-4 py-2">
        <div
          className="flex items-center gap-2 px-3 py-2 rounded-xl"
          style={{ backgroundColor: '#E5E5EA' }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#8E8E93"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search facts and claims..."
            className="flex-1 text-[15px] bg-transparent outline-none"
            style={{ color: '#000000' }}
          />
          {searchQuery && (
            <button onClick={() => setSearchQuery('')} className="ios-btn-bounce">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="#8E8E93">
                <circle cx="12" cy="12" r="10" />
                <path d="M15 9l-6 6M9 9l6 6" stroke="white" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Segment Control */}
      <div className="px-4 pb-2">
        <div className="flex rounded-lg p-0.5" style={{ backgroundColor: '#E5E5EA' }}>
          <button
            onClick={() => setActiveTab('confirmed')}
            className="flex-1 py-1.5 rounded-md text-[13px] font-semibold text-center transition-all"
            style={{
              backgroundColor: activeTab === 'confirmed' ? '#FFFFFF' : 'transparent',
              color: activeTab === 'confirmed' ? '#000000' : '#8E8E93',
              boxShadow: activeTab === 'confirmed' ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
            }}
          >
            Confirmed ({filteredConfirmed.length})
          </button>
          <button
            onClick={() => setActiveTab('claims')}
            className="flex-1 py-1.5 rounded-md text-[13px] font-semibold text-center transition-all"
            style={{
              backgroundColor: activeTab === 'claims' ? '#FFFFFF' : 'transparent',
              color: activeTab === 'claims' ? '#000000' : '#8E8E93',
              boxShadow: activeTab === 'claims' ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
            }}
          >
            Claims ({filteredUnconfirmed.length})
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {activeTab === 'confirmed' ? (
          filteredConfirmed.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-32 gap-1">
              <svg
                width="36"
                height="36"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#C7C7CC"
                strokeWidth="1.2"
              >
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
              <p className="text-[15px]" style={{ color: '#8E8E93' }}>
                No confirmed facts loaded
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {filteredConfirmed.map((fact, i) => (
                <div key={i} className="rounded-xl p-4" style={{ backgroundColor: '#FFFFFF' }}>
                  <div className="flex items-start gap-3">
                    <div
                      className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5"
                      style={{ backgroundColor: '#E8F5E9' }}
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="#34C759"
                        strokeWidth="3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    </div>
                    <p className="text-[14px] leading-relaxed" style={{ color: '#1C1C1E' }}>
                      {fact}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )
        ) : filteredUnconfirmed.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 gap-1">
            <svg
              width="36"
              height="36"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#C7C7CC"
              strokeWidth="1.2"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="15" y1="9" x2="9" y2="15" />
              <line x1="9" y1="9" x2="15" y2="15" />
            </svg>
            <p className="text-[15px]" style={{ color: '#8E8E93' }}>
              No claims to check
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {filteredUnconfirmed.map((entry, i) => (
              <div
                key={i}
                className="rounded-xl overflow-hidden"
                style={{ backgroundColor: '#FFFFFF' }}
              >
                <div className="p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <span
                      className="text-[11px] px-2 py-0.5 rounded-full font-bold"
                      style={{
                        backgroundColor: entry.status === 'FALSE' ? '#FFE5E5' : '#FFF8E1',
                        color: entry.status === 'FALSE' ? '#FF3B30' : '#FF9500',
                      }}
                    >
                      {entry.status}
                    </span>
                  </div>
                  <p
                    className="text-[14px] font-semibold leading-snug"
                    style={{ color: '#1C1C1E' }}
                  >
                    {entry.claim}
                  </p>
                  <div className="mt-2 pt-2" style={{ borderTop: '0.5px solid #E5E5EA' }}>
                    <div className="flex items-start gap-2">
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="#34C759"
                        strokeWidth="2"
                        strokeLinecap="round"
                        className="flex-shrink-0 mt-0.5"
                      >
                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                      </svg>
                      <p className="text-[13px]" style={{ color: '#6C6C70' }}>
                        {entry.truth}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
