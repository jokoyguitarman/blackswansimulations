import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useWebSocket } from '../../hooks/useWebSocket';
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SocialState {
  sentiment_score: number;
  public_trust: number;
  community_safety: number;
  narrative_control: number;
  escalation_risk: number;
  unaddressed_hate_count: number;
  unaddressed_misinfo_count: number;
  oldest_unaddressed_hate_minutes: number;
  player_post_count: number;
  total_posts: number;
  counter_narratives_published: number;
  misinformation_flagged_count: number;
  community_leader_contacted: boolean;
  official_statement_published: boolean;
  rally_call_active: boolean;
  tier1_reactive_actions: number;
  tier2_strategic_actions: number;
  tier3_advanced_actions: number;
  strategic_ratio: number;
  sop_monitor_completed: boolean;
  sop_assess_completed: boolean;
  sop_fact_check_completed: boolean;
  sop_escalate_completed: boolean;
  sop_draft_completed: boolean;
  sop_publish_completed: boolean;
  sop_monitor_overdue: boolean;
  sop_assess_overdue: boolean;
  sop_draft_overdue: boolean;
  sop_publish_overdue: boolean;
  dimension_labels?: {
    public_trust: string;
    community_safety: string;
    narrative_control: string;
    escalation_risk: string;
  };
}

interface GradedReply {
  id: string;
  author_display_name: string;
  content: string;
  reply_to_post_id: string;
  parent_content?: string;
  sop_compliance_score: {
    accuracy: number;
    tone: number;
    cultural_sensitivity: number;
    persuasiveness: number;
    overall: number;
    feedback: string;
  };
  created_at: string;
}

interface ConsequenceEvent {
  id: string;
  description: string;
  metadata: {
    trigger_id: string;
    is_positive: boolean;
    post_content?: string;
  };
  created_at: string;
}

interface FeedPost {
  id: string;
  author_handle: string;
  author_display_name: string;
  author_type: string;
  content: string;
  content_flags: Record<string, unknown>;
  requires_response: boolean;
  responded_at: string | null;
  created_at: string;
  sentiment: string;
  sop_compliance_score?: {
    accuracy: number;
    tone: number;
    cultural_sensitivity: number;
    persuasiveness: number;
    overall: number;
    feedback: string;
  } | null;
  reply_to_post_id: string | null;
  is_flagged_by_player?: boolean;
  target_player_ids?: string[];
  posted_by_display_name?: string;
}

interface OrchestrationInject {
  id: string;
  title: string;
  severity: string;
  status: 'published' | 'cancelled' | 'eligible' | 'waiting';
  published_at?: string;
  conditions: Array<{ key: string; met: boolean }>;
  met_count: number;
  total_count: number;
  mode: 'all' | 'threshold';
  threshold?: number;
}

const CONDITION_LABELS: Record<string, string> = {
  player_acknowledged_victims_and_ongoing_investigation: 'Acknowledged affected parties',
  player_message_includes_no_collective_blame: 'No collective blame',
  player_included_support_resources: 'Included actionable guidance',
  player_avoided_group_targeting_language: 'Avoided harmful amplification',
  player_included_public_safety_guidance: 'Included safety/protective info',
  player_provided_shareable_assets: 'Cited verified sources',
  leader_message_calls_for_unity: 'Stakeholder promotes dialogue',
  leader_message_includes_links_to_sources: 'Stakeholder includes source links',
  leader_has_preexisting_credibility: 'Key stakeholder has credibility',
  player_addressed_fake_news_spiral: 'Addressed false claims',
  player_used_leader_amplification: 'Leader amplification used',
  player_executed_multi_platform_blitz: 'Multi-platform posting (X + Facebook)',
  player_used_strategic_silence: 'Strategic silence (ignoring trolls)',
  player_pinned_verified_update: 'Official statement posted',
  player_is_actively_moderating_hate_speech: 'Actively moderating harmful content',
  player_message_is_consistent_across_channels: 'Consistent messaging across platforms',
  player_message_inconsistent_across_channels: 'Inconsistent messaging across platforms',
  community_leader_contacted: 'Key stakeholder contacted',
  impression_dominance_player: 'Player impressions dominate hostile',
  sentiment_above_60: 'Sentiment above 60',
  sentiment_below_30: 'Sentiment below 30',
  hate_post_unaddressed_count_gt_3: 'Harmful posts unaddressed (>3)',
  misinformation_unaddressed_10min: 'Misinfo unaddressed 10+ min',
  team_published_counter_narrative: 'Counter-narrative published',
  team_flagged_misinformation: 'Misinformation flagged',
  player_post_count_gt_3: 'Player has 3+ posts',
  player_post_count_gt_5: 'Player has 5+ posts',
  official_response_exists: 'Official response exists',
  facts_confirmed: 'Facts confirmed / fact-checked',
  player_posted_creative_format: 'Creative format posted',
  player_posted_official_statement: 'Official statement posted',
  player_posted_infographic: 'Infographic posted',
  player_posted_video_concept: 'Video concept posted',
  player_posted_personal_story: 'Personal story posted',
};

function conditionLabel(key: string): string {
  return CONDITION_LABELS[key] || key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

function gaugeColor(value: number): string {
  if (value > 60) return '#22c55e';
  if (value >= 30) return '#f59e0b';
  return '#ef4444';
}

function riskColor(value: number): string {
  if (value < 30) return '#22c55e';
  if (value <= 60) return '#f59e0b';
  return '#ef4444';
}

function ageColor(minutes: number): string {
  if (minutes < 3) return '#22c55e';
  if (minutes <= 8) return '#f59e0b';
  return '#ef4444';
}

function gradeColor(score: number): string {
  if (score >= 80) return '#22c55e';
  if (score >= 50) return '#f59e0b';
  return '#ef4444';
}

function minutesAgo(iso: string): number {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function timeLabel(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Card({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-xl border overflow-hidden flex flex-col ${className || ''}`}
      style={{ backgroundColor: '#1a1a1a', borderColor: '#2a2a2a' }}
    >
      <div
        className="px-4 py-2.5 border-b text-xs font-semibold tracking-wider uppercase"
        style={{ borderColor: '#2a2a2a', color: '#94a3b8' }}
      >
        {title}
      </div>
      <div className="flex-1 p-4 overflow-y-auto">{children}</div>
    </div>
  );
}

function Gauge({ label, value, invert }: { label: string; value: number; invert?: boolean }) {
  const color = invert ? riskColor(value) : gaugeColor(value);
  return (
    <div className="mb-3 last:mb-0">
      <div className="flex justify-between items-center mb-1">
        <span className="text-xs" style={{ color: '#94a3b8' }}>
          {label}
        </span>
        <span className="text-xs font-bold" style={{ color }}>
          {Math.round(value)}
        </span>
      </div>
      <div className="h-2 rounded-full overflow-hidden" style={{ backgroundColor: '#2a2a2a' }}>
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${Math.min(100, Math.max(0, value))}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}

function Badge({ text, variant }: { text: string; variant: 'red' | 'amber' | 'blue' | 'gray' }) {
  const colors: Record<string, { bg: string; fg: string }> = {
    red: { bg: 'rgba(239,68,68,0.15)', fg: '#ef4444' },
    amber: { bg: 'rgba(245,158,11,0.15)', fg: '#f59e0b' },
    blue: { bg: 'rgba(59,130,246,0.15)', fg: '#3b82f6' },
    gray: { bg: 'rgba(148,163,184,0.15)', fg: '#94a3b8' },
  };
  const c = colors[variant] || colors.gray;
  return (
    <span
      className="inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded"
      style={{ backgroundColor: c.bg, color: c.fg }}
    >
      {text}
    </span>
  );
}

function CheckItem({
  label,
  done,
  details,
}: {
  label: string;
  done: boolean;
  details?: Array<{ content: string; time?: string }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = details && details.length > 0;
  return (
    <div>
      <button
        onClick={() => hasDetails && setExpanded(!expanded)}
        className="flex items-center gap-2 py-1 w-full text-left"
        style={{ cursor: hasDetails ? 'pointer' : 'default' }}
      >
        <span style={{ color: done ? '#22c55e' : '#ef4444' }}>{done ? '✓' : '✗'}</span>
        <span className="text-xs flex-1" style={{ color: done ? '#e5e5e5' : '#64748b' }}>
          {label}
        </span>
        {hasDetails && (
          <span className="text-[10px]" style={{ color: '#475569' }}>
            {expanded ? '▾' : '▸'}
          </span>
        )}
      </button>
      {expanded && details && (
        <div className="ml-6 mb-1 space-y-1">
          {details.map((d, i) => (
            <div
              key={i}
              className="text-[10px] rounded px-2 py-1"
              style={{ backgroundColor: '#141414', color: '#94a3b8' }}
            >
              {d.time && (
                <span className="mr-2" style={{ color: '#475569' }}>
                  {d.time}
                </span>
              )}
              {d.content.substring(0, 150)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SOP Timeline
// ---------------------------------------------------------------------------

interface SopDot {
  label: string;
  status: 'completed' | 'overdue' | 'pending';
}

function SopTimeline({ steps }: { steps: SopDot[] }) {
  if (steps.length === 0) {
    return (
      <p className="text-xs text-center py-4" style={{ color: '#64748b' }}>
        No SOP data yet
      </p>
    );
  }

  const dotColor = (s: SopDot['status']) => {
    if (s === 'completed') return '#22c55e';
    if (s === 'overdue') return '#ef4444';
    return '#475569';
  };

  return (
    <div className="flex items-start gap-0 overflow-x-auto pb-2">
      {steps.map((step, i) => (
        <div key={step.label} className="flex flex-col items-center" style={{ minWidth: 80 }}>
          <div className="flex items-center w-full">
            {i > 0 && <div className="flex-1 h-px" style={{ backgroundColor: '#2a2a2a' }} />}
            <div
              className={`w-4 h-4 rounded-full flex-shrink-0 ${step.status === 'overdue' ? 'animate-pulse' : ''}`}
              style={{ backgroundColor: dotColor(step.status) }}
            />
            {i < steps.length - 1 && (
              <div className="flex-1 h-px" style={{ backgroundColor: '#2a2a2a' }} />
            )}
            {i === 0 && <div className="flex-1" />}
            {i === steps.length - 1 && <div className="flex-1" />}
          </div>
          <span
            className="text-[10px] mt-1.5 text-center leading-tight"
            style={{ color: dotColor(step.status) }}
          >
            {step.label}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Orchestration Ticker
// ---------------------------------------------------------------------------

function orchStatusDot(inj: OrchestrationInject): { color: string; pulse: boolean } {
  if (inj.status === 'published') return { color: '#22c55e', pulse: false };
  if (inj.status === 'cancelled') return { color: '#475569', pulse: false };
  if (inj.status === 'eligible') return { color: '#22c55e', pulse: true };
  if (inj.met_count > 0) return { color: '#f59e0b', pulse: false };
  return { color: '#ef4444', pulse: false };
}

function OrchestrationTicker({ injects }: { injects: OrchestrationInject[] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const publishedCount = injects.filter((i) => i.status === 'published').length;

  if (injects.length === 0) {
    return (
      <p className="text-xs text-center py-6" style={{ color: '#64748b' }}>
        No strategy windows in this scenario
      </p>
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-semibold" style={{ color: '#64748b' }}>
          {publishedCount} of {injects.length} published
        </span>
        <div className="flex items-center gap-3 text-[10px]" style={{ color: '#475569' }}>
          <span className="flex items-center gap-1">
            <span
              className="inline-block w-2 h-2 rounded-full"
              style={{ backgroundColor: '#22c55e' }}
            />
            Published
          </span>
          <span className="flex items-center gap-1">
            <span
              className="inline-block w-2 h-2 rounded-full"
              style={{ backgroundColor: '#f59e0b' }}
            />
            Partial
          </span>
          <span className="flex items-center gap-1">
            <span
              className="inline-block w-2 h-2 rounded-full"
              style={{ backgroundColor: '#ef4444' }}
            />
            Waiting
          </span>
        </div>
      </div>

      {injects.map((inj) => {
        const dot = orchStatusDot(inj);
        const isExpanded = expandedId === inj.id;

        return (
          <div key={inj.id}>
            <button
              onClick={() => setExpandedId(isExpanded ? null : inj.id)}
              className="flex items-center gap-2.5 w-full text-left rounded-lg px-3 py-2 hover:opacity-90 transition-opacity"
              style={{ backgroundColor: '#141414' }}
            >
              <span
                className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${dot.pulse ? 'animate-pulse' : ''}`}
                style={{ backgroundColor: dot.color }}
              />
              <span
                className={`text-xs flex-1 truncate ${inj.status === 'cancelled' ? 'line-through' : ''}`}
                style={{
                  color:
                    inj.status === 'cancelled'
                      ? '#475569'
                      : inj.status === 'published'
                        ? '#e5e5e5'
                        : '#94a3b8',
                }}
              >
                {inj.title}
              </span>
              <span
                className="text-[10px] font-bold flex-shrink-0"
                style={{
                  color:
                    inj.met_count === inj.total_count
                      ? '#22c55e'
                      : inj.met_count > 0
                        ? '#f59e0b'
                        : '#ef4444',
                }}
              >
                {inj.met_count}/{inj.total_count}
              </span>
              {inj.status === 'published' && inj.published_at && (
                <span className="text-[10px] flex-shrink-0" style={{ color: '#22c55e' }}>
                  {new Date(inj.published_at).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              )}
              {inj.status !== 'published' && (
                <span className="text-[10px] flex-shrink-0" style={{ color: '#475569' }}>
                  {inj.mode === 'all' ? 'ALL' : `${inj.threshold} of ${inj.total_count}`}
                </span>
              )}
              <span className="text-[10px]" style={{ color: '#475569' }}>
                {isExpanded ? '▾' : '▸'}
              </span>
            </button>

            {isExpanded && (
              <div
                className="ml-5 mt-1 mb-2 rounded-lg px-3 py-2 space-y-1"
                style={{ backgroundColor: '#0f0f0f', border: '1px solid #2a2a2a' }}
              >
                {inj.conditions.map((c) => (
                  <div key={c.key} className="flex items-center gap-2">
                    <span style={{ color: c.met ? '#22c55e' : '#ef4444', fontSize: 11 }}>
                      {c.met ? '✓' : '✗'}
                    </span>
                    <span className="text-[11px]" style={{ color: c.met ? '#e5e5e5' : '#64748b' }}>
                      {conditionLabel(c.key)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Dashboard
// ---------------------------------------------------------------------------

export default function TrainerSimDashboard() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();

  const [socialState, setSocialState] = useState<SocialState | null>(null);
  const [gradedReplies, setGradedReplies] = useState<GradedReply[]>([]);
  const [consequences, setConsequences] = useState<ConsequenceEvent[]>([]);
  const [showExplainer, setShowExplainer] = useState(false);
  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [orchestration, setOrchestration] = useState<OrchestrationInject[]>([]);
  const [elapsedMinutes, setElapsedMinutes] = useState(0);
  const [sessionInfo, setSessionInfo] = useState<Record<string, unknown> | null>(null);
  const feedEndRef = useRef<HTMLDivElement>(null);

  // ---- Data loaders -------------------------------------------------------

  const loadSocialState = useCallback(async () => {
    if (!sessionId) return;
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(apiUrl(`/api/social/state/session/${sessionId}`), { headers });
      const json = await res.json();
      if (json.data) setSocialState(json.data);
    } catch {
      /* retry on next poll */
    }
  }, [sessionId]);

  const loadPosts = useCallback(async () => {
    if (!sessionId) return;
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(apiUrl(`/api/social/posts/session/${sessionId}`), { headers });
      const json = await res.json();
      if (json.data) setPosts(json.data);
    } catch {
      /* retry on next poll */
    }
  }, [sessionId]);

  const loadGradedReplies = useCallback(async () => {
    if (!sessionId) return;
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(apiUrl(`/api/social/posts/session/${sessionId}?graded=true`), {
        headers,
      });
      const json = await res.json();
      if (Array.isArray(json.data)) {
        const graded = json.data.filter(
          (p: Record<string, unknown>) => p.sop_compliance_score != null,
        );
        setGradedReplies(
          graded.map((p: Record<string, unknown>) => ({
            id: String(p.id ?? ''),
            author_display_name: String(p.author_display_name ?? ''),
            content: String(p.content ?? ''),
            reply_to_post_id: String(p.reply_to_post_id ?? ''),
            parent_content: p.parent_content != null ? String(p.parent_content) : undefined,
            sop_compliance_score: p.sop_compliance_score as GradedReply['sop_compliance_score'],
            created_at: String(p.created_at ?? ''),
          })),
        );
      }
    } catch {
      /* retry */
    }
  }, [sessionId]);

  const loadConsequences = useCallback(async () => {
    if (!sessionId) return;
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(
        apiUrl(`/api/sessions/${sessionId}/events?event_type=consequence_inject`),
        { headers },
      );
      const json = await res.json();
      if (Array.isArray(json.data)) {
        setConsequences(
          json.data.map((e: Record<string, unknown>) => ({
            id: String(e.id ?? ''),
            description: String(e.description ?? ''),
            metadata: (e.metadata ?? {
              trigger_id: '',
              is_positive: false,
            }) as ConsequenceEvent['metadata'],
            created_at: String(e.created_at ?? ''),
          })),
        );
      }
    } catch {
      /* retry */
    }
  }, [sessionId]);

  const loadSessionInfo = useCallback(async () => {
    if (!sessionId) return;
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(apiUrl(`/api/sessions/${sessionId}`), { headers });
      const json = await res.json();
      if (json.data) {
        setSessionInfo(json.data);
        if (typeof json.data.started_at === 'string') {
          setElapsedMinutes(minutesAgo(String(json.data.started_at)));
        }
      }
    } catch {
      /* retry */
    }
  }, [sessionId]);

  const loadOrchestration = useCallback(async () => {
    if (!sessionId) return;
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(apiUrl(`/api/social/orchestration/session/${sessionId}`), {
        headers,
      });
      const json = await res.json();
      if (Array.isArray(json.data)) setOrchestration(json.data);
    } catch {
      /* retry on next poll */
    }
  }, [sessionId]);

  const loadAll = useCallback(() => {
    loadSocialState();
    loadPosts();
    loadGradedReplies();
    loadConsequences();
    loadSessionInfo();
    loadOrchestration();
  }, [
    loadSocialState,
    loadPosts,
    loadGradedReplies,
    loadConsequences,
    loadSessionInfo,
    loadOrchestration,
  ]);

  // ---- Initial load + polling ---------------------------------------------

  useEffect(() => {
    loadAll();
    const id = setInterval(loadAll, 12000);
    return () => clearInterval(id);
  }, [loadAll]);

  // keep elapsed time ticking every 30s
  useEffect(() => {
    const id = setInterval(() => {
      if (sessionInfo && typeof (sessionInfo as Record<string, unknown>).started_at === 'string') {
        setElapsedMinutes(minutesAgo(String((sessionInfo as Record<string, unknown>).started_at)));
      }
    }, 30000);
    return () => clearInterval(id);
  }, [sessionInfo]);

  // ---- WebSocket ----------------------------------------------------------

  useWebSocket({
    sessionId: sessionId || '',
    eventTypes: [
      'social_state.updated',
      'social_post.created',
      'social_post.flagged',
      'social_posts.engagement_update',
    ],
    onEvent: (evt) => {
      if (evt.type === 'social_state.updated' && evt.data) {
        setSocialState(evt.data as unknown as SocialState);
      } else {
        loadPosts();
        loadGradedReplies();
        loadConsequences();
      }
    },
  });

  // ---- Derived data -------------------------------------------------------

  const unattendedPosts = posts.filter((p) => {
    const flags = p.content_flags;
    const isHarmful =
      !!flags &&
      (!!flags.hate_speech ||
        !!flags.is_hate_speech ||
        !!flags.is_harmful_narrative ||
        !!flags.misinformation ||
        !!flags.is_misinformation ||
        !!flags.inflammatory ||
        !!flags.is_inflammatory ||
        !!flags.threatening ||
        !!flags.incites_violence ||
        !!flags.is_organized_pressure);
    return isHarmful && !p.responded_at;
  });

  const recentFeed = [...posts]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 50);

  const sopSteps: SopDot[] = socialState
    ? [
        {
          label: 'Monitor',
          status: socialState.sop_monitor_overdue
            ? 'overdue'
            : socialState.sop_monitor_completed
              ? 'completed'
              : 'pending',
        },
        {
          label: 'Assess',
          status: socialState.sop_assess_overdue
            ? 'overdue'
            : socialState.sop_assess_completed
              ? 'completed'
              : 'pending',
        },
        {
          label: 'Fact-Check',
          status: socialState.sop_fact_check_completed ? 'completed' : 'pending',
        },
        {
          label: 'Escalate',
          status: socialState.sop_escalate_completed ? 'completed' : 'pending',
        },
        {
          label: 'Draft',
          status: socialState.sop_draft_overdue
            ? 'overdue'
            : socialState.sop_draft_completed
              ? 'completed'
              : 'pending',
        },
        {
          label: 'Publish',
          status: socialState.sop_publish_overdue
            ? 'overdue'
            : socialState.sop_publish_completed
              ? 'completed'
              : 'pending',
        },
      ]
    : [];

  const tierTotal =
    (socialState?.tier1_reactive_actions ?? 0) +
    (socialState?.tier2_strategic_actions ?? 0) +
    (socialState?.tier3_advanced_actions ?? 0);

  const tierPcts =
    tierTotal > 0
      ? {
          t1: ((socialState?.tier1_reactive_actions ?? 0) / tierTotal) * 100,
          t2: ((socialState?.tier2_strategic_actions ?? 0) / tierTotal) * 100,
          t3: ((socialState?.tier3_advanced_actions ?? 0) / tierTotal) * 100,
        }
      : { t1: 0, t2: 0, t3: 0 };

  function flagBadges(flags: Record<string, unknown>) {
    const out: { text: string; variant: 'red' | 'amber' | 'blue' | 'gray' }[] = [];
    if (flags.hate_speech || flags.is_hate_speech) out.push({ text: 'Hate', variant: 'red' });
    if (flags.is_harmful_narrative) out.push({ text: 'Harmful', variant: 'red' });
    if (flags.misinformation || flags.is_misinformation)
      out.push({ text: 'Misinfo', variant: 'amber' });
    if (flags.inflammatory || flags.is_inflammatory)
      out.push({ text: 'Inflam.', variant: 'amber' });
    if (flags.threatening || flags.incites_violence) out.push({ text: 'Threat', variant: 'red' });
    if (flags.is_organized_pressure) out.push({ text: 'Pressure', variant: 'amber' });
    if (flags.manipulative) out.push({ text: 'Manip.', variant: 'amber' });
    return out;
  }

  function postBorderStyle(post: FeedPost): string {
    const flags = post.content_flags;
    const isHarmful =
      !!flags &&
      (!!flags.hate_speech ||
        !!flags.is_hate_speech ||
        !!flags.is_harmful_narrative ||
        !!flags.misinformation ||
        !!flags.is_misinformation ||
        !!flags.inflammatory ||
        !!flags.is_inflammatory ||
        !!flags.threatening ||
        !!flags.incites_violence ||
        !!flags.is_organized_pressure);
    if (isHarmful && !post.responded_at) return 'border-l-2 border-red-500 animate-pulse';
    if (post.author_type === 'npc' || post.author_type === 'designed_npc')
      return 'border-l-2 border-amber-400';
    if (post.author_type === 'player') return 'border-l-2 border-blue-500';
    return 'border-l-2 border-transparent';
  }

  // ---- Render -------------------------------------------------------------

  return (
    <div className="min-h-screen w-full" style={{ backgroundColor: '#0f0f0f', color: '#e5e5e5' }}>
      {/* Header */}
      <header
        className="sticky top-0 z-30 flex items-center justify-between px-6 py-3 border-b"
        style={{ backgroundColor: '#0f0f0f', borderColor: '#2a2a2a' }}
      >
        <div className="flex items-center gap-4">
          <button
            onClick={() => navigate(`/sim/${sessionId}/device`)}
            className="text-xs font-medium px-3 py-1.5 rounded-lg hover:opacity-80 transition-opacity"
            style={{ backgroundColor: '#1877F2', color: '#fff' }}
          >
            Player View
          </button>
          <button
            onClick={() => navigate(`/sim/${sessionId}/desktop`)}
            className="text-xs font-medium px-3 py-1.5 rounded-lg hover:opacity-80 transition-opacity"
            style={{ backgroundColor: '#2a2a2a', color: '#94a3b8' }}
          >
            Desktop View
          </button>
          <button
            onClick={() => navigate(`/sessions/${sessionId || ''}`)}
            className="text-xs font-medium px-3 py-1.5 rounded-lg hover:opacity-80 transition-opacity"
            style={{ backgroundColor: '#1a1a1a', color: '#3b82f6', border: '1px solid #2a2a2a' }}
          >
            ← Back
          </button>
          <div>
            <h1 className="text-base font-bold" style={{ color: '#ffffff' }}>
              Crisis Trainer Dashboard
            </h1>
            <p className="text-[11px]" style={{ color: '#64748b' }}>
              Session {sessionId ? truncate(sessionId, 12) : '—'} · {elapsedMinutes}m elapsed
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowExplainer(true)}
            className="text-[11px] font-semibold px-3 py-1.5 rounded-lg hover:opacity-80 transition-opacity"
            style={{ backgroundColor: '#1e293b', color: '#94a3b8', border: '1px solid #334155' }}
          >
            How It Works
          </button>
          <span
            className="text-[11px] px-2 py-1 rounded font-semibold"
            style={{
              backgroundColor: socialState ? 'rgba(34,197,94,0.15)' : 'rgba(100,116,139,0.15)',
              color: socialState ? '#22c55e' : '#64748b',
            }}
          >
            {socialState ? 'LIVE' : 'CONNECTING…'}
          </span>
          <button
            onClick={async () => {
              if (!sessionId) return;
              if (
                !window.confirm(
                  'Are you sure you want to conclude this session? This will end the simulation for all players.',
                )
              )
                return;
              try {
                const headers = await getAuthHeaders();
                const res = await fetch(apiUrl(`/api/sessions/${sessionId}`), {
                  method: 'PATCH',
                  headers,
                  body: JSON.stringify({ status: 'completed' }),
                });
                if (res.ok) {
                  alert('Session concluded successfully.');
                  navigate(`/sessions/${sessionId}`);
                } else {
                  alert('Failed to conclude session.');
                }
              } catch {
                alert('Error concluding session.');
              }
            }}
            className="text-[11px] font-semibold px-3 py-1.5 rounded-lg hover:opacity-80 transition-opacity"
            style={{ backgroundColor: '#ef4444', color: '#fff' }}
          >
            Conclude Session
          </button>
        </div>
      </header>

      {/* Grid */}
      <div
        className="p-4 grid gap-4"
        style={{ gridTemplateRows: 'auto auto auto', minHeight: 'calc(100vh - 56px)' }}
      >
        {/* ============ TOP ROW: 3 columns ============ */}
        <div className="grid grid-cols-3 gap-4" style={{ minHeight: 260 }}>
          {/* Panel 1 — Sentiment Gauges */}
          <Card title="Sentiment Gauges">
            {socialState ? (
              <>
                <div className="flex items-center justify-center mb-4">
                  <div className="text-center">
                    <div
                      className="text-4xl font-black"
                      style={{ color: gaugeColor(socialState.sentiment_score) }}
                    >
                      {Math.round(socialState.sentiment_score)}
                    </div>
                    <div className="text-[10px] mt-0.5" style={{ color: '#64748b' }}>
                      Overall Sentiment
                    </div>
                  </div>
                </div>
                <Gauge
                  label={socialState.dimension_labels?.public_trust || 'Public Trust'}
                  value={socialState.public_trust}
                />
                <Gauge
                  label={socialState.dimension_labels?.community_safety || 'Stakeholder Confidence'}
                  value={socialState.community_safety}
                />
                <Gauge
                  label={socialState.dimension_labels?.narrative_control || 'Narrative Control'}
                  value={socialState.narrative_control}
                />
                <Gauge
                  label={socialState.dimension_labels?.escalation_risk || 'Escalation Risk'}
                  value={socialState.escalation_risk}
                  invert
                />
              </>
            ) : (
              <p className="text-xs text-center py-8" style={{ color: '#64748b' }}>
                Waiting for data…
              </p>
            )}
          </Card>

          {/* Panel 2 — Unattended Posts */}
          <Card title={`Unattended Harmful Posts (${unattendedPosts.length})`}>
            {unattendedPosts.length === 0 ? (
              <p className="text-xs text-center py-8" style={{ color: '#64748b' }}>
                All clear — no unattended harmful posts
              </p>
            ) : (
              <div className="space-y-2">
                {unattendedPosts.map((p) => {
                  const age = minutesAgo(p.created_at);
                  const badges = flagBadges(p.content_flags);
                  return (
                    <div
                      key={p.id}
                      className="rounded-lg p-2.5 border"
                      style={{ backgroundColor: '#141414', borderColor: '#2a2a2a' }}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[11px] font-semibold" style={{ color: '#94a3b8' }}>
                          @{p.author_handle}
                          {p.posted_by_display_name && (
                            <span
                              className="text-[9px] font-normal ml-1"
                              style={{ color: '#64748b' }}
                            >
                              (by {p.posted_by_display_name})
                            </span>
                          )}
                        </span>
                        <span className="text-[10px] font-bold" style={{ color: ageColor(age) }}>
                          {age}m ago
                        </span>
                      </div>
                      <p className="text-xs leading-relaxed mb-1.5" style={{ color: '#cbd5e1' }}>
                        {truncate(p.content, 120)}
                      </p>
                      <div className="flex flex-wrap gap-1">
                        {badges.map((b) => (
                          <Badge key={b.text} text={b.text} variant={b.variant} />
                        ))}
                        {p.target_player_ids && p.target_player_ids.length > 0 && (
                          <span
                            className="text-[9px] px-1.5 py-0.5 rounded font-semibold"
                            style={{ backgroundColor: 'rgba(99,102,241,0.15)', color: '#818cf8' }}
                          >
                            Bubble
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          {/* Panel 3 — Strategic Actions */}
          <Card title="Strategic Actions">
            {socialState ? (
              <>
                {/* Tier bar */}
                <div className="mb-3">
                  <div className="text-[10px] mb-1" style={{ color: '#64748b' }}>
                    Action Tier Breakdown
                  </div>
                  <div
                    className="flex h-4 rounded overflow-hidden"
                    style={{ backgroundColor: '#2a2a2a' }}
                  >
                    {tierPcts.t1 > 0 && (
                      <div
                        style={{ width: `${tierPcts.t1}%`, backgroundColor: '#64748b' }}
                        title={`Tier 1 Reactive: ${socialState.tier1_reactive_actions}`}
                      />
                    )}
                    {tierPcts.t2 > 0 && (
                      <div
                        style={{ width: `${tierPcts.t2}%`, backgroundColor: '#3b82f6' }}
                        title={`Tier 2 Strategic: ${socialState.tier2_strategic_actions}`}
                      />
                    )}
                    {tierPcts.t3 > 0 && (
                      <div
                        style={{ width: `${tierPcts.t3}%`, backgroundColor: '#8b5cf6' }}
                        title={`Tier 3 Advanced: ${socialState.tier3_advanced_actions}`}
                      />
                    )}
                  </div>
                  <div
                    className="flex justify-between text-[10px] mt-1"
                    style={{ color: '#64748b' }}
                  >
                    <span>T1: {socialState.tier1_reactive_actions}</span>
                    <span>T2: {socialState.tier2_strategic_actions}</span>
                    <span>T3: {socialState.tier3_advanced_actions}</span>
                  </div>
                </div>

                {/* Strategic ratio */}
                <div
                  className="rounded-lg px-3 py-2 mb-3 flex items-center justify-between"
                  style={{ backgroundColor: '#141414' }}
                >
                  <span className="text-xs" style={{ color: '#94a3b8' }}>
                    Strategic Ratio
                  </span>
                  <span
                    className="text-sm font-bold"
                    style={{
                      color: socialState.strategic_ratio >= 0.5 ? '#22c55e' : '#f59e0b',
                    }}
                  >
                    {Math.round(socialState.strategic_ratio * 100)}%
                  </span>
                </div>

                {/* Key actions checklist */}
                <div className="space-y-0">
                  <CheckItem
                    label="Official statement published"
                    done={socialState.official_statement_published}
                    details={posts
                      .filter(
                        (p) =>
                          p.author_type === 'player' &&
                          !p.reply_to_post_id &&
                          String((p as unknown as Record<string, unknown>).post_format || '') ===
                            'official_statement',
                      )
                      .map((p) => ({ content: p.content, time: timeLabel(p.created_at) }))}
                  />
                  <CheckItem
                    label="Community leader contacted"
                    done={socialState.community_leader_contacted}
                  />
                  <CheckItem
                    label={`Counter-narratives (${socialState.counter_narratives_published})`}
                    done={socialState.counter_narratives_published > 0}
                    details={posts
                      .filter((p) => p.author_type === 'player' && !p.reply_to_post_id)
                      .map((p) => ({ content: p.content, time: timeLabel(p.created_at) }))}
                  />
                  <CheckItem
                    label={`Misinfo flagged (${socialState.misinformation_flagged_count})`}
                    done={socialState.misinformation_flagged_count > 0}
                    details={posts
                      .filter(
                        (p) =>
                          p.is_flagged_by_player ||
                          (p as unknown as Record<string, unknown>).flagged_by_me,
                      )
                      .map((p) => ({
                        content: `${p.author_handle}: ${p.content}`,
                        time: timeLabel(p.created_at),
                      }))}
                  />
                  <CheckItem label="Rally call active" done={socialState.rally_call_active} />
                </div>
              </>
            ) : (
              <p className="text-xs text-center py-8" style={{ color: '#64748b' }}>
                Waiting for data…
              </p>
            )}
          </Card>
        </div>

        {/* ============ MIDDLE ROW: 2 columns ============ */}
        <div className="grid grid-cols-2 gap-4" style={{ minHeight: 240 }}>
          {/* Panel 4 — Player Response Log */}
          <Card title={`Player Responses (${gradedReplies.length})`}>
            {gradedReplies.length === 0 ? (
              <p className="text-xs text-center py-8" style={{ color: '#64748b' }}>
                No graded player responses yet
              </p>
            ) : (
              <div className="space-y-2">
                {gradedReplies.map((r) => {
                  const score = r.sop_compliance_score;
                  return (
                    <div
                      key={r.id}
                      className="rounded-lg p-2.5 border"
                      style={{ backgroundColor: '#141414', borderColor: '#2a2a2a' }}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[11px] font-semibold" style={{ color: '#94a3b8' }}>
                          {r.author_display_name}
                        </span>
                        <span className="text-[10px]" style={{ color: '#64748b' }}>
                          {timeLabel(r.created_at)}
                        </span>
                      </div>
                      {r.parent_content && (
                        <div
                          className="text-[10px] rounded px-2 py-1 mb-1.5 italic"
                          style={{ backgroundColor: '#1a1a1a', color: '#64748b' }}
                        >
                          Replying to: {truncate(r.parent_content, 80)}
                        </div>
                      )}
                      <p className="text-xs mb-2 leading-relaxed" style={{ color: '#cbd5e1' }}>
                        {truncate(r.content, 160)}
                      </p>
                      <div className="flex flex-wrap gap-2 text-[10px] font-bold">
                        <span style={{ color: gradeColor(score.accuracy) }}>
                          ACC {score.accuracy}
                        </span>
                        <span style={{ color: gradeColor(score.tone) }}>TONE {score.tone}</span>
                        <span style={{ color: gradeColor(score.cultural_sensitivity) }}>
                          SENS {score.cultural_sensitivity}
                        </span>
                        <span style={{ color: gradeColor(score.persuasiveness) }}>
                          PERS {score.persuasiveness}
                        </span>
                        <span className="ml-auto" style={{ color: gradeColor(score.overall) }}>
                          OVERALL {score.overall}
                        </span>
                      </div>
                      {score.feedback && (
                        <p
                          className="text-[10px] mt-1.5 leading-snug italic"
                          style={{ color: '#64748b' }}
                        >
                          {truncate(score.feedback, 200)}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          {/* Panel 5 — Consequence Log */}
          <Card title={`Consequence Log (${consequences.length})`}>
            {consequences.length === 0 ? (
              <p className="text-xs text-center py-8" style={{ color: '#64748b' }}>
                No consequences triggered yet
              </p>
            ) : (
              <div className="space-y-2">
                {consequences.map((c) => {
                  const positive = !!c.metadata?.is_positive;
                  return (
                    <div
                      key={c.id}
                      className="rounded-lg p-2.5 border-l-2"
                      style={{
                        backgroundColor: '#141414',
                        borderColor: positive ? '#22c55e' : '#ef4444',
                      }}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <Badge
                          text={positive ? 'POSITIVE' : 'NEGATIVE'}
                          variant={positive ? 'blue' : 'red'}
                        />
                        <span className="text-[10px]" style={{ color: '#64748b' }}>
                          {timeLabel(c.created_at)}
                        </span>
                      </div>
                      <p className="text-xs leading-relaxed mb-1" style={{ color: '#cbd5e1' }}>
                        {c.description}
                      </p>
                      {c.metadata?.post_content && (
                        <p className="text-[10px] italic leading-snug" style={{ color: '#64748b' }}>
                          Trigger: "{truncate(String(c.metadata.post_content), 100)}"
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </div>

        {/* ============ ORCHESTRATION ROW: full width ============ */}
        <Card
          title={`Strategy Window Orchestration (${orchestration.filter((i) => i.status === 'published').length}/${orchestration.length})`}
        >
          <OrchestrationTicker injects={orchestration} />
        </Card>

        {/* ============ BOTTOM ROW: 2 columns (3fr + 2fr) ============ */}
        <div className="grid gap-4" style={{ gridTemplateColumns: '3fr 2fr', minHeight: 220 }}>
          {/* Panel 6 — Live Feed */}
          <Card title={`Live Feed (${posts.length} posts)`}>
            {recentFeed.length === 0 ? (
              <p className="text-xs text-center py-8" style={{ color: '#64748b' }}>
                No posts yet
              </p>
            ) : (
              <div className="space-y-1.5">
                {recentFeed.map((p) => {
                  const badges = flagBadges(p.content_flags);
                  return (
                    <div
                      key={p.id}
                      className={`rounded px-2.5 py-2 ${postBorderStyle(p)}`}
                      style={{ backgroundColor: '#141414' }}
                    >
                      <div className="flex items-center gap-2 mb-0.5">
                        <span
                          className="text-[11px] font-semibold"
                          style={{
                            color:
                              p.author_type === 'player'
                                ? '#3b82f6'
                                : p.author_type === 'npc' || p.author_type === 'designed_npc'
                                  ? '#f59e0b'
                                  : '#94a3b8',
                          }}
                        >
                          @{p.author_handle}
                        </span>
                        <span className="text-[10px]" style={{ color: '#475569' }}>
                          {timeLabel(p.created_at)}
                        </span>
                        {(badges.length > 0 ||
                          (p.target_player_ids && p.target_player_ids.length > 0)) && (
                          <div className="flex gap-1 ml-auto">
                            {badges.map((b) => (
                              <Badge key={b.text} text={b.text} variant={b.variant} />
                            ))}
                            {p.target_player_ids && p.target_player_ids.length > 0 && (
                              <span
                                className="text-[9px] px-1.5 py-0.5 rounded font-semibold"
                                style={{
                                  backgroundColor: 'rgba(99,102,241,0.15)',
                                  color: '#818cf8',
                                }}
                              >
                                Bubble
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                      <p className="text-xs leading-relaxed" style={{ color: '#cbd5e1' }}>
                        {truncate(p.content, 200)}
                      </p>
                    </div>
                  );
                })}
                <div ref={feedEndRef} />
              </div>
            )}
          </Card>

          {/* Panel 7 — SOP Timeline */}
          <Card title="SOP Timeline">
            <SopTimeline steps={sopSteps} />
            {socialState && (
              <div className="mt-4 space-y-1">
                <div className="flex justify-between text-xs">
                  <span style={{ color: '#64748b' }}>Completed</span>
                  <span style={{ color: '#22c55e' }}>
                    {sopSteps.filter((s) => s.status === 'completed').length}/{sopSteps.length}
                  </span>
                </div>
                <div className="flex justify-between text-xs">
                  <span style={{ color: '#64748b' }}>Overdue</span>
                  <span
                    style={{
                      color: sopSteps.some((s) => s.status === 'overdue') ? '#ef4444' : '#64748b',
                    }}
                  >
                    {sopSteps.filter((s) => s.status === 'overdue').length}
                  </span>
                </div>
                <div className="flex justify-between text-xs">
                  <span style={{ color: '#64748b' }}>Total Posts</span>
                  <span style={{ color: '#e5e5e5' }}>{socialState.total_posts}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span style={{ color: '#64748b' }}>Player Posts</span>
                  <span style={{ color: '#3b82f6' }}>{socialState.player_post_count}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span style={{ color: '#64748b' }}>Unaddressed Harmful</span>
                  <span
                    style={{
                      color: socialState.unaddressed_hate_count > 0 ? '#ef4444' : '#22c55e',
                    }}
                  >
                    {socialState.unaddressed_hate_count}
                  </span>
                </div>
                <div className="flex justify-between text-xs">
                  <span style={{ color: '#64748b' }}>Unaddressed Misinfo</span>
                  <span
                    style={{
                      color: socialState.unaddressed_misinfo_count > 0 ? '#f59e0b' : '#22c55e',
                    }}
                  >
                    {socialState.unaddressed_misinfo_count}
                  </span>
                </div>
                <div className="flex justify-between text-xs">
                  <span style={{ color: '#64748b' }}>Oldest Harmful Post</span>
                  <span
                    style={{
                      color: ageColor(socialState.oldest_unaddressed_hate_minutes),
                    }}
                  >
                    {socialState.oldest_unaddressed_hate_minutes > 0
                      ? `${socialState.oldest_unaddressed_hate_minutes}m`
                      : '—'}
                  </span>
                </div>
              </div>
            )}
          </Card>
        </div>
      </div>

      {/* How It Works Explainer Modal */}
      {showExplainer && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ backgroundColor: 'rgba(0,0,0,0.8)' }}
          onClick={() => setShowExplainer(false)}
        >
          <div
            className="relative w-full max-w-3xl max-h-[85vh] overflow-y-auto rounded-2xl mx-4"
            style={{ backgroundColor: '#111', border: '1px solid #2a2a2a' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="sticky top-0 flex items-center justify-between px-6 py-4 z-10"
              style={{ backgroundColor: '#111', borderBottom: '1px solid #2a2a2a' }}
            >
              <h2 className="text-lg font-bold" style={{ color: '#fff' }}>
                How the Dashboard Works
              </h2>
              <button
                onClick={() => setShowExplainer(false)}
                className="text-[18px]"
                style={{ color: '#64748b' }}
              >
                ✕
              </button>
            </div>
            <div
              className="px-6 py-4 space-y-6 text-[13px] leading-relaxed"
              style={{ color: '#cbd5e1' }}
            >
              <section>
                <h3 className="text-[15px] font-bold mb-2" style={{ color: '#3b82f6' }}>
                  Sentiment Gauges
                </h3>
                <p>
                  Four real-time metrics computed from all posts in the simulation every tick
                  (approximately every 30 seconds):
                </p>
                <ul className="list-disc ml-5 mt-2 space-y-1.5">
                  <li>
                    <strong style={{ color: '#e5e5e5' }}>Overall Sentiment (0-100)</strong> —
                    Weighted average of all post sentiments. Posts by designed NPCs and
                    high-virality posts carry more weight. Drops when hostile/inflammatory posts
                    dominate the feed.
                  </li>
                  <li>
                    <strong style={{ color: '#e5e5e5' }}>Public Trust (0-100)</strong> — Measures
                    whether stakeholders perceive the response team as competent. Increases when
                    players publish official statements and respond to harmful content quickly.
                    Decreases when harmful posts go unaddressed or the team is silent.
                  </li>
                  <li>
                    <strong style={{ color: '#e5e5e5' }}>Stakeholder Confidence (0-100)</strong> —
                    Tracks how safe and confident affected parties feel. Drops when harmful
                    narratives, inflammatory content, or pressure campaigns appear and remain
                    unaddressed. Recovers when counter-narratives are published and key stakeholders
                    are contacted.
                  </li>
                  <li>
                    <strong style={{ color: '#e5e5e5' }}>Narrative Control (0-100)</strong> — Ratio
                    of player-created impressions vs. hostile content impressions. High narrative
                    control means the player's content is getting more engagement than the hostile
                    posts. Penalized by unaddressed harmful posts (weighted by age).
                  </li>
                  <li>
                    <strong style={{ color: '#e5e5e5' }}>Escalation Risk (0-100, inverted)</strong>{' '}
                    — Higher is worse. Increases when harmful content, organized pressure campaigns,
                    and misinformation accumulate without response. Decreases when players flag
                    content, publish statements, and contact key stakeholders.
                  </li>
                </ul>
              </section>

              <section>
                <h3 className="text-[15px] font-bold mb-2" style={{ color: '#ef4444' }}>
                  Unattended Harmful Posts
                </h3>
                <p>
                  Lists NPC posts flagged with harmful narratives, misinformation, inflammatory
                  content, or violence incitement that the player has not yet responded to or
                  flagged.
                </p>
                <ul className="list-disc ml-5 mt-2 space-y-1">
                  <li>
                    Age timer shows how long each post has been unaddressed — turns from green to
                    amber to red as time passes.
                  </li>
                  <li>
                    The system penalizes the player's score progressively: 0-2min = no penalty,
                    2-5min = low, 5-10min = medium, 10-15min = high, 15+ min = severe.
                  </li>
                  <li>
                    After 10+ minutes unaddressed, automated consequence injects fire (e.g.,
                    "stakeholders feel abandoned").
                  </li>
                </ul>
              </section>

              <section>
                <h3 className="text-[15px] font-bold mb-2" style={{ color: '#8b5cf6' }}>
                  Strategic Actions
                </h3>
                <p>Categorizes every player action into three tiers:</p>
                <ul className="list-disc ml-5 mt-2 space-y-1.5">
                  <li>
                    <strong style={{ color: '#64748b' }}>Tier 1 — Reactive</strong> — Basic actions:
                    liking posts, simple text replies, flagging content. Necessary but does not
                    demonstrate strategic thinking.
                  </li>
                  <li>
                    <strong style={{ color: '#3b82f6' }}>Tier 2 — Strategic</strong> — Publishing
                    official statements, creating infographics, posting counter-narratives,
                    contacting community leaders. Shows deliberate communication strategy.
                  </li>
                  <li>
                    <strong style={{ color: '#8b5cf6' }}>Tier 3 — Advanced</strong> — Multi-platform
                    coordination, video concepts, rally calls, creative/humor formats deployed at
                    the right timing. Demonstrates mastery.
                  </li>
                </ul>
                <p className="mt-2">
                  <strong style={{ color: '#e5e5e5' }}>Strategic Ratio</strong> — Percentage of Tier
                  2+3 actions out of total. Above 50% is considered good (green). Below 50% means
                  the player is mostly reactive (amber).
                </p>
                <p className="mt-1">
                  <strong style={{ color: '#e5e5e5' }}>Checklist items</strong> track whether the
                  player has completed key crisis communication actions (official statement,
                  community outreach, counter-narratives, misinfo flagging, rally calls). Click to
                  expand and see the actual posts.
                </p>
              </section>

              <section>
                <h3 className="text-[15px] font-bold mb-2" style={{ color: '#22c55e' }}>
                  Player Response Grading
                </h3>
                <p>
                  Every player post (replies and top-level) is auto-graded by AI against crisis
                  communication best practices. Four dimensions:
                </p>
                <ul className="list-disc ml-5 mt-2 space-y-1">
                  <li>
                    <strong style={{ color: '#e5e5e5' }}>Accuracy (ACC)</strong> — Does the response
                    align with confirmed facts from the fact sheet? Does it avoid speculation?
                  </li>
                  <li>
                    <strong style={{ color: '#e5e5e5' }}>Tone (TONE)</strong> — Is the language
                    appropriate, empathetic, and professional? Does it avoid escalatory rhetoric?
                  </li>
                  <li>
                    <strong style={{ color: '#e5e5e5' }}>Cultural Sensitivity (CULT)</strong> — Does
                    the response show awareness of the affected communities? Does it avoid
                    stereotyping?
                  </li>
                  <li>
                    <strong style={{ color: '#e5e5e5' }}>Persuasiveness (PERS)</strong> — Would this
                    response effectively counter the harmful narrative? Does it provide actionable
                    information?
                  </li>
                </ul>
                <p className="mt-2">
                  Scores above 70 trigger positive consequence injects (community support). Scores
                  below 40 trigger negative consequences (skeptical media reactions).
                </p>
              </section>

              <section>
                <h3 className="text-[15px] font-bold mb-2" style={{ color: '#f59e0b' }}>
                  Consequence Log
                </h3>
                <p>Tracks automated system reactions to player behavior:</p>
                <ul className="list-disc ml-5 mt-2 space-y-1">
                  <li>
                    <strong style={{ color: '#22c55e' }}>Positive</strong> — Triggered when players
                    post high-quality responses, publish official statements on time, or
                    successfully counter misinformation. The system generates supportive NPC
                    reactions.
                  </li>
                  <li>
                    <strong style={{ color: '#ef4444' }}>Negative</strong> — Triggered when harmful
                    posts go unaddressed too long, players post poor-quality responses, or the team
                    stays silent. The system generates critical NPC reactions.
                  </li>
                </ul>
              </section>

              <section>
                <h3 className="text-[15px] font-bold mb-2" style={{ color: '#1d9bf0' }}>
                  Strategy Window Orchestration
                </h3>
                <p>
                  Shows conditional content injects that fire based on player behavior patterns.
                  Each inject has conditions (e.g., "player posted official statement" + "fact check
                  completed") and triggers success or backlash branches.
                </p>
                <p className="mt-1">
                  These represent the simulation's branching narrative — different player strategies
                  unlock different NPC reactions and storyline developments.
                </p>
              </section>

              <section>
                <h3 className="text-[15px] font-bold mb-2" style={{ color: '#e5e5e5' }}>
                  Live Feed
                </h3>
                <p>Real-time stream of all posts in the simulation. Color-coded borders:</p>
                <ul className="list-disc ml-5 mt-2 space-y-1">
                  <li>
                    <span style={{ color: '#3b82f6' }}>Blue border</span> — Player posts
                  </li>
                  <li>
                    <span style={{ color: '#f59e0b' }}>Amber border</span> — NPC posts (both ambient
                    and designed NPCs)
                  </li>
                  <li>
                    <span style={{ color: '#ef4444' }}>Red pulsing border</span> — Harmful posts
                    that have not been addressed yet
                  </li>
                </ul>
              </section>

              <section className="pb-2">
                <h3 className="text-[15px] font-bold mb-2" style={{ color: '#a855f7' }}>
                  SOP Timeline
                </h3>
                <p>
                  Tracks the player's progress through the Standard Operating Procedure for social
                  media crisis response:
                </p>
                <ol className="list-decimal ml-5 mt-2 space-y-1">
                  <li>
                    <strong style={{ color: '#e5e5e5' }}>Monitor</strong> — Player is actively
                    viewing and tracking the feed
                  </li>
                  <li>
                    <strong style={{ color: '#e5e5e5' }}>Assess</strong> — Player has identified the
                    nature and severity of the crisis
                  </li>
                  <li>
                    <strong style={{ color: '#e5e5e5' }}>Fact-Check</strong> — Player has verified
                    claims against the fact sheet before responding
                  </li>
                  <li>
                    <strong style={{ color: '#e5e5e5' }}>Escalate</strong> — Player has flagged
                    content or contacted authorities/community leaders
                  </li>
                  <li>
                    <strong style={{ color: '#e5e5e5' }}>Draft</strong> — Player has composed a
                    strategic response
                  </li>
                  <li>
                    <strong style={{ color: '#e5e5e5' }}>Publish</strong> — Player has posted the
                    response publicly
                  </li>
                </ol>
                <p className="mt-2">
                  Steps turn green when completed, red when overdue (past the recommended response
                  window for that stage).
                </p>
              </section>

              <section className="pb-4">
                <h3 className="text-[15px] font-bold mb-2" style={{ color: '#64748b' }}>
                  Data Sources
                </h3>
                <p>
                  All metrics update in real-time via WebSocket. The social state is recomputed
                  every engine tick (~30s). Post grading happens asynchronously after each player
                  post is submitted. Consequence triggers evaluate continuously against threshold
                  conditions.
                </p>
              </section>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
