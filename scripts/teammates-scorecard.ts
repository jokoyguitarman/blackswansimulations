import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

/**
 * Scorecard for AI teammate bots in one session (docs/ai-teammate-bots-plan.md §13, Phase 6).
 *
 *   npx tsx scripts/teammates-scorecard.ts --session <uuid> [--out scorecard.json]
 *
 * Reads the database with the service role (no server required) and prints, per bot:
 * actions by type, average content grade, and for the session: team composites, time to
 * first official statement, share of harmful posts countered within 5 minutes, and the
 * final gauges. Use scripts/teammates-compare.ts to diff two runs (e.g. two intellect
 * settings on the same scenario).
 */

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const sessionId = arg('session');
if (!sessionId) {
  console.error('Usage: npx tsx scripts/teammates-scorecard.ts --session <uuid> [--out file.json]');
  process.exit(1);
}
const outPath = arg('out');

const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

interface BotCard {
  user_id: string;
  display_name: string;
  team_name: string | null;
  actions: Record<string, number>;
  graded_items: number;
  avg_overall: number | null;
  official_statements: number;
}

export interface Scorecard {
  session_id: string;
  scenario_title: string | null;
  bot_intellect: number | null;
  status: string;
  elapsed_minutes: number | null;
  bots: BotCard[];
  team_scores: Array<{
    team_name: string;
    member_count: number;
    composite_score: number | null;
    content_quality: number | null;
    task_completion: number | null;
    role_fit: number | null;
    tasks_done: number;
    tasks_total: number;
  }>;
  time_to_first_statement_minutes: number | null;
  harmful_posts: number;
  harmful_countered_within_5m: number;
  gauges: Record<string, number | null>;
  generated_at: string;
}

const HARMFUL_KEYS = [
  'is_misinformation',
  'misinformation',
  'is_false_claim',
  'is_hate_speech',
  'hate_speech',
  'is_incitement',
  'incites_violence',
  'is_harmful_narrative',
  'is_inflammatory',
  'inflammatory',
  'is_racist',
  'is_organized_pressure',
];

async function main(): Promise<void> {
  const { data: session } = await admin
    .from('sessions')
    .select(
      'id, status, start_time, end_time, bot_intellect, current_state, scenario:scenarios(title)',
    )
    .eq('id', sessionId!)
    .maybeSingle();
  if (!session) throw new Error('session not found');
  const s = session as Record<string, unknown>;
  const scenario = s.scenario as { title?: string } | Array<{ title?: string }> | null;
  const scenarioTitle = Array.isArray(scenario)
    ? (scenario[0]?.title ?? null)
    : (scenario?.title ?? null);
  const start = s.start_time ? new Date(String(s.start_time)).getTime() : null;
  const end = s.end_time ? new Date(String(s.end_time)).getTime() : Date.now();

  const [
    { data: participants },
    { data: teams },
    { data: actions },
    { data: posts },
    { data: emails },
  ] = await Promise.all([
    admin
      .from('session_participants')
      .select('user_id, user:user_profiles!inner(full_name, is_bot)')
      .eq('session_id', sessionId!)
      .eq('user.is_bot', true),
    admin.from('session_teams').select('user_id, team_name').eq('session_id', sessionId!),
    admin
      .from('player_actions')
      .select('player_id, action_type, created_at')
      .eq('session_id', sessionId!),
    admin
      .from('social_posts')
      .select(
        'id, user_id, posted_by_user_id, author_type, post_format, content_flags, reply_to_post_id, created_at, sop_compliance_score',
      )
      .eq('session_id', sessionId!),
    admin
      .from('sim_emails')
      .select('sent_by_player_id, sop_compliance_score')
      .eq('session_id', sessionId!)
      .eq('direction', 'outbound'),
  ]);

  const teamByUser = new Map<string, string>();
  for (const t of teams ?? []) {
    const r = t as { user_id: string; team_name: string };
    if (!teamByUser.has(r.user_id)) teamByUser.set(r.user_id, r.team_name);
  }
  const allMembers = new Set((teams ?? []).map((t) => (t as { user_id: string }).user_id));

  const bots: BotCard[] = (participants ?? []).map((p) => {
    const row = p as {
      user_id: string;
      user: { full_name: string } | Array<{ full_name: string }>;
    };
    const user = Array.isArray(row.user) ? row.user[0] : row.user;
    const mine = (actions ?? []).filter(
      (a) => (a as { player_id: string }).player_id === row.user_id,
    );
    const counts: Record<string, number> = {};
    for (const a of mine) {
      const k = (a as { action_type: string }).action_type;
      counts[k] = (counts[k] ?? 0) + 1;
    }
    const myPosts = (posts ?? []).filter(
      (x) => (x as { user_id: string | null }).user_id === row.user_id,
    ) as Array<{
      sop_compliance_score: { overall?: number } | null;
      author_type: string;
      post_format: string | null;
    }>;
    const myEmails = (emails ?? []).filter(
      (x) => (x as { sent_by_player_id: string | null }).sent_by_player_id === row.user_id,
    ) as Array<{ sop_compliance_score: { overall?: number } | null }>;
    const grades = [...myPosts, ...myEmails]
      .map((x) => x.sop_compliance_score?.overall)
      .filter((g): g is number => typeof g === 'number');
    return {
      user_id: row.user_id,
      display_name: user?.full_name ?? 'AI Teammate',
      team_name: teamByUser.get(row.user_id) ?? null,
      actions: counts,
      graded_items: grades.length,
      avg_overall: grades.length
        ? Math.round(grades.reduce((a, b) => a + b, 0) / grades.length)
        : null,
      official_statements: myPosts.filter(
        (x) => x.author_type === 'official_account' && x.post_format === 'official_statement',
      ).length,
    };
  });

  // Team scores via the server's own service (pure DB rollup).
  let teamScores: Scorecard['team_scores'] = [];
  try {
    const { computeTeamScores } = await import('../server/services/teamScoreService.js');
    const report = await computeTeamScores(sessionId!);
    teamScores = report.teams.map((t) => ({
      team_name: t.team_name,
      member_count: t.member_count,
      composite_score: t.composite_score,
      content_quality: t.content_quality,
      task_completion: t.task_completion,
      role_fit: t.role_fit,
      tasks_done: t.tasks_done,
      tasks_total: t.tasks_total,
    }));
  } catch (err) {
    console.error(`team scores unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Time to first official statement by anyone on the response side.
  const statements = (posts ?? [])
    .filter(
      (x) =>
        (x as { author_type: string }).author_type === 'official_account' &&
        (x as { post_format: string | null }).post_format === 'official_statement' &&
        (x as { posted_by_user_id: string | null }).posted_by_user_id,
    )
    .map((x) => new Date((x as { created_at: string }).created_at).getTime())
    .sort((a, b) => a - b);
  const ttfs = start && statements[0] ? Math.round((statements[0] - start) / 60_000) : null;

  // Harmful posts and whether the response side countered them within 5 minutes.
  const harmful = (posts ?? []).filter((x) => {
    const p = x as {
      content_flags: Record<string, unknown> | null;
      reply_to_post_id: string | null;
    };
    if (p.reply_to_post_id) return false;
    const f = p.content_flags ?? {};
    return HARMFUL_KEYS.some((k) => Boolean(f[k]));
  }) as Array<{ id: string; created_at: string }>;
  const flagActions = (actions ?? []).filter((a) => {
    const r = a as { action_type: string; player_id: string };
    return (
      ['post_flagged', 'misinfo_flagged', 'post_reported', 'dispute_filed'].includes(
        r.action_type,
      ) && allMembers.has(r.player_id)
    );
  }) as Array<{ created_at: string }>;
  let countered = 0;
  for (const h of harmful) {
    const t0 = new Date(h.created_at).getTime();
    const reply = (posts ?? []).find((x) => {
      const p = x as {
        reply_to_post_id: string | null;
        user_id: string | null;
        created_at: string;
      };
      return (
        p.reply_to_post_id === h.id &&
        p.user_id &&
        allMembers.has(p.user_id) &&
        new Date(p.created_at).getTime() - t0 <= 5 * 60_000
      );
    });
    // Flags carry no target in this select; approximate with a flag inside the window.
    const flagged = flagActions.some((f) => {
      const t = new Date(f.created_at).getTime();
      return t >= t0 && t - t0 <= 5 * 60_000;
    });
    if (reply || flagged) countered++;
  }

  const social = ((s.current_state as Record<string, unknown> | null)?.social_state ??
    {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' ? v : null);

  const card: Scorecard = {
    session_id: sessionId!,
    scenario_title: scenarioTitle,
    bot_intellect: num(s.bot_intellect),
    status: String(s.status),
    elapsed_minutes: start ? Math.round((end - start) / 60_000) : null,
    bots,
    team_scores: teamScores,
    time_to_first_statement_minutes: ttfs,
    harmful_posts: harmful.length,
    harmful_countered_within_5m: countered,
    gauges: {
      public_trust: num(social.public_trust),
      community_safety: num(social.community_safety),
      narrative_control: num(social.narrative_control),
      escalation_risk: num(social.escalation_risk),
      sentiment_score: num(social.sentiment_score),
    },
    generated_at: new Date().toISOString(),
  };

  console.log(
    `Scorecard for ${card.scenario_title ?? sessionId} (${card.status}, T+${card.elapsed_minutes ?? '?'}m, intellect ${card.bot_intellect ?? '-'})`,
  );
  for (const b of card.bots) {
    const acts = Object.entries(b.actions)
      .sort((a, z) => z[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    console.log(
      `  ${b.display_name} [${b.team_name ?? '-'}] grade ${b.avg_overall ?? '-'} (${b.graded_items}) statements ${b.official_statements} | ${acts}`,
    );
  }
  for (const t of card.team_scores) {
    console.log(
      `  team ${t.team_name}: composite ${t.composite_score ?? 'null'} content ${t.content_quality ?? '-'} tasks ${t.tasks_done}/${t.tasks_total} role-fit ${t.role_fit ?? '-'} (${t.member_count} members)`,
    );
  }
  console.log(
    `  first statement: ${card.time_to_first_statement_minutes ?? 'none'} min; harmful countered <=5m: ${card.harmful_countered_within_5m}/${card.harmful_posts}`,
  );
  console.log(`  gauges: ${JSON.stringify(card.gauges)}`);
  if (outPath) {
    writeFileSync(outPath, JSON.stringify(card, null, 2));
    console.log(`  written to ${outPath}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
