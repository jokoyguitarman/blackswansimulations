import React, { useState, useEffect } from 'react';
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
    <div className="h-full flex flex-col bg-white text-gray-900">
      <div className="flex items-center gap-3 px-4 py-3 border-b bg-purple-50">
        <button
          onClick={() => navigate(`/sim/${sessionId}/device/home`)}
          className="text-purple-600 text-sm"
        >
          ← Home
        </button>
        <span className="font-bold text-purple-900">FactCheck</span>
      </div>

      <div className="px-4 py-3">
        <input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search facts..."
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
        />
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-4">
        <div>
          <h3 className="text-sm font-bold text-green-700 mb-2 flex items-center gap-1">
            Confirmed Facts
          </h3>
          {filteredConfirmed.length === 0 ? (
            <p className="text-xs text-gray-400">No confirmed facts loaded</p>
          ) : (
            filteredConfirmed.map((fact, i) => (
              <div key={i} className="bg-green-50 border border-green-200 rounded-lg p-3 mb-2">
                <p className="text-xs">{fact}</p>
              </div>
            ))
          )}
        </div>

        <div>
          <h3 className="text-sm font-bold text-red-700 mb-2 flex items-center gap-1">
            Unverified / False Claims
          </h3>
          {filteredUnconfirmed.length === 0 ? (
            <p className="text-xs text-gray-400">No claims to check</p>
          ) : (
            filteredUnconfirmed.map((entry, i) => (
              <div key={i} className="bg-red-50 border border-red-200 rounded-lg p-3 mb-2">
                <div className="flex items-center gap-2 mb-1">
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${entry.status === 'FALSE' ? 'bg-red-600 text-white' : 'bg-yellow-500 text-black'}`}
                  >
                    {entry.status}
                  </span>
                </div>
                <p className="text-xs font-medium">Claim: {entry.claim}</p>
                <p className="text-xs text-gray-600 mt-1">Truth: {entry.truth}</p>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
