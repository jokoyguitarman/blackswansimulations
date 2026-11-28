import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../../lib/api';
import { peaceCardVisible } from '../../lib/peacePeriodCard';
import { WrSection } from '../UI/Collapsible';

interface PeacePost {
  ref?: string;
  content?: string;
  offset_seconds?: number;
  platform?: string;
  author?: { kind?: string; org_key?: string; handle?: string; platform?: string };
  comments?: Array<{ author_handle?: string; content?: string; offset_seconds?: number }>;
}

interface PeacePeriod {
  seconds: number;
  enabled: boolean;
  leak_terms: string[];
  posts: PeacePost[];
}

function readPeace(value: Record<string, unknown> | null): PeacePeriod | null {
  if (!value || !Array.isArray(value.posts)) return null;
  return {
    seconds: typeof value.seconds === 'number' ? value.seconds : 300,
    enabled: value.enabled !== false,
    leak_terms: Array.isArray(value.leak_terms) ? value.leak_terms.map(String) : [],
    posts: value.posts as PeacePost[],
  };
}

function authorLabel(post: PeacePost): string {
  const author = post.author;
  if (author?.kind === 'page') return `${author.org_key ?? 'page'} · ${author.platform ?? post.platform ?? ''}`;
  return author?.handle || 'Persona';
}

interface Props {
  scenarioId: string;
  locked: boolean;
  onPeacePeriod: (peace: Record<string, unknown> | null) => void;
}

/**
 * Editor card for the pre-crisis feed. Hidden when the server answers 404
 * (ENABLE_PEACE_PERIOD off, or the scenario is not a social crisis).
 */
export function PeacePeriodCard({ scenarioId, locked, onPeacePeriod }: Props) {
  const [visible, setVisible] = useState(false);
  const [feed, setFeed] = useState<PeacePeriod | null>(null);
  const [seconds, setSeconds] = useState('300');
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const onPeacePeriodRef = useRef(onPeacePeriod);
  onPeacePeriodRef.current = onPeacePeriod;

  const apply = useCallback((value: Record<string, unknown> | null) => {
    const next = readPeace(value);
    setFeed(next);
    if (next) {
      setSeconds(String(next.seconds));
      setEnabled(next.enabled);
    }
    onPeacePeriodRef.current(value);
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.scenarios
      .getPeaceFeed(scenarioId)
      .then((res) => {
        if (cancelled) return;
        setVisible(peaceCardVisible(200));
        apply(res.data.peace_period);
        setMessage(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const status = err instanceof ApiError ? err.status : 0;
        if (!peaceCardVisible(status)) {
          setVisible(false);
          return;
        }
        setVisible(true);
        setError(true);
        setMessage(err instanceof Error ? err.message : 'Could not load the peace feed');
      });
    return () => {
      cancelled = true;
    };
  }, [scenarioId, apply]);

  if (!visible) return null;

  const generate = async () => {
    setBusy(true);
    setMessage(null);
    setError(false);
    try {
      const res = await api.scenarios.generatePeaceFeed(scenarioId);
      apply(res.data.peace_period);
      setError(Boolean(res.data.warning));
      setMessage(res.data.warning ?? (res.data.generated ? 'Peace feed saved' : null));
    } catch (err) {
      setError(true);
      setMessage(err instanceof Error ? err.message : 'Could not generate the peace feed');
    } finally {
      setBusy(false);
    }
  };

  const saveSettings = async () => {
    const parsed = Number(seconds);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 900) {
      setError(true);
      setMessage('Seconds must be a whole number from 0 to 900');
      return;
    }
    setBusy(true);
    setMessage(null);
    setError(false);
    try {
      const res = await api.scenarios.updatePeaceFeed(scenarioId, {
        seconds: parsed,
        enabled,
      });
      apply(res.data.peace_period);
      setMessage('Saved');
    } catch (err) {
      setError(true);
      setMessage(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  const posts = feed?.posts ?? [];
  return (
    <WrSection
      id="peace-period"
      title="Peace period"
      icon="sparkle"
      family="var(--f-ai)"
      count={posts.length > 0 ? posts.length : undefined}
      subtitle="Ordinary posts before the crisis. Nothing here is generated until you ask."
      defaultOpen={posts.length > 0}
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-[11px] text-muted font-medium">
            Seconds
            <input
              type="number"
              min={0}
              max={900}
              value={seconds}
              disabled={locked || busy || !feed}
              onChange={(event) => setSeconds(event.target.value)}
              className="mt-0.5 block w-24 text-xs bg-surface border border-border rounded px-2 py-1.5 text-ink disabled:opacity-60"
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-ink pb-1.5">
            <input
              type="checkbox"
              checked={enabled}
              disabled={locked || busy || !feed}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            Peace period on
          </label>
          <button
            type="button"
            disabled={locked || busy || !feed}
            onClick={() => void saveSettings()}
            className="text-xs border border-border rounded px-2 py-1.5 text-ink disabled:opacity-40"
          >
            Save
          </button>
          <button
            type="button"
            disabled={locked || busy}
            onClick={() => void generate()}
            className="text-xs bg-brand text-white rounded px-2 py-1.5 disabled:opacity-40"
          >
            {busy ? 'Working…' : posts.length > 0 ? 'Regenerate' : 'Generate'}
          </button>
          {message && (
            <span className={`text-xs pb-1.5 ${error ? 'text-danger' : 'text-success'}`}>{message}</span>
          )}
        </div>
        {feed && feed.leak_terms.length > 0 && (
          <p className="text-[11px] text-muted">
            Hidden from the peace feed: {feed.leak_terms.join(', ')}
          </p>
        )}
        {posts.length === 0 ? (
          <p className="text-xs text-muted">No peace feed yet. Generate one to give this scenario a quiet start.</p>
        ) : (
          <ol className="space-y-2">
            {posts.map((post, index) => (
              <li key={post.ref || index} className="text-xs border border-border rounded px-2 py-1.5">
                <div className="text-[11px] text-muted">
                  {post.ref || `P${index + 1}`} · {authorLabel(post)} · {post.offset_seconds ?? 0}s
                </div>
                <div className="text-ink mt-0.5">{post.content}</div>
                {(post.comments ?? []).map((comment, commentIndex) => (
                  <div key={commentIndex} className="text-muted mt-1 pl-3">
                    {comment.author_handle}: {comment.content}
                  </div>
                ))}
              </li>
            ))}
          </ol>
        )}
      </div>
    </WrSection>
  );
}
