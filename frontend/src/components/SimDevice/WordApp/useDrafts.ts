import { useCallback, useEffect, useRef, useState } from 'react';
import * as draftApi from './api';
import type { DraftDocument, SaveState } from './types';

export function useDrafts(sessionId: string | undefined) {
  const [drafts, setDrafts] = useState<DraftDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    try {
      const next = await draftApi.listDrafts(sessionId);
      setDrafts(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load documents');
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    setLoading(true);
    void refresh();
    const id = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const put = useCallback((document: DraftDocument) => {
    setDrafts((current) =>
      [document, ...current.filter((item) => item.id !== document.id)].sort(
        (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
      ),
    );
    return document;
  }, []);

  const create = useCallback(
    async (title?: string) => {
      if (!sessionId) throw new Error('Session not found');
      return put(await draftApi.createDraft(sessionId, title));
    },
    [put, sessionId],
  );

  const save = useCallback(
    async (id: string, patch: { title?: string; content_html?: string }) =>
      put(await draftApi.updateDraft(id, patch)),
    [put],
  );

  const submit = useCallback(async (id: string) => put(await draftApi.submitDraft(id)), [put]);

  const review = useCallback(
    async (id: string, verdict: 'approve' | 'request_changes', note?: string) =>
      put(await draftApi.reviewDraft(id, verdict, note)),
    [put],
  );

  const grade = useCallback(async (id: string) => {
    const result = await draftApi.gradeDraft(id);
    setDrafts((current) =>
      current.map((item) => (item.id === id ? { ...item, last_grade: result } : item)),
    );
    return result;
  }, []);

  const remove = useCallback(async (id: string) => {
    await draftApi.deleteDraft(id);
    setDrafts((current) => current.filter((item) => item.id !== id));
  }, []);

  return {
    drafts,
    loading,
    error,
    refresh,
    create,
    save,
    submit,
    review,
    grade,
    remove,
    put,
  };
}

interface PendingSave {
  id: string;
  patch: { title?: string; content_html?: string };
}

export function useDraftAutosave(
  saveDraft: (
    id: string,
    patch: { title?: string; content_html?: string },
  ) => Promise<DraftDocument>,
  onSaved: (document: DraftDocument) => void,
) {
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const timerRef = useRef<number | null>(null);
  const pendingRef = useRef<PendingSave | null>(null);
  const mountedRef = useRef(true);
  const saveRef = useRef(saveDraft);
  const onSavedRef = useRef(onSaved);

  saveRef.current = saveDraft;
  onSavedRef.current = onSaved;

  const flush = useCallback(async () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (!pending) return null;

    try {
      const saved = await saveRef.current(pending.id, pending.patch);
      onSavedRef.current(saved);
      if (mountedRef.current) setSaveState('saved');
      return saved;
    } catch (err) {
      const newer = pendingRef.current;
      pendingRef.current = {
        id: pending.id,
        patch: newer?.id === pending.id ? { ...pending.patch, ...newer.patch } : pending.patch,
      };
      if (mountedRef.current) setSaveState('error');
      throw err;
    }
  }, []);

  const queue = useCallback(
    (id: string, patch: { title?: string; content_html?: string }) => {
      const existing = pendingRef.current;
      pendingRef.current = {
        id,
        patch: existing?.id === id ? { ...existing.patch, ...patch } : patch,
      };
      setSaveState('saving');
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => void flush().catch(() => {}), 800);
    },
    [flush],
  );

  useEffect(
    () => () => {
      mountedRef.current = false;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      if (pendingRef.current) void flush().catch(() => {});
    },
    [flush],
  );

  return { saveState, queue, flush };
}
