import { useCallback, useEffect, useState } from 'react';
import type { MyAgreementResponse } from '@shared/trainerAgreements';
import { api } from '../lib/api';

/** The signed-in user's Consultant Agreement state. Pass enabled=false to skip the request. */
export function useMyAgreement(enabled = true) {
  const [mine, setMine] = useState<MyAgreementResponse | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setMine((await api.trainerAgreements.mine()).data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your agreement');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) void reload();
    else setLoading(false);
  }, [enabled, reload]);

  return { mine, setMine, loading, error, reload };
}
