import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import type {
  TeamBestPractice,
  ResearchGuidelines,
  StrategicActionBenchmark,
  TeamDef,
} from './socialCrisisGeneratorService.js';

function normalizeRole(teamName: string): string {
  return teamName
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '_')
    .trim();
}

export async function getCachedTeamDoctrines(
  teamName: string,
  crisisCategory = 'social_media_crisis',
): Promise<TeamBestPractice | null> {
  try {
    const roleType = normalizeRole(teamName);
    const { data } = await supabaseAdmin
      .from('social_crisis_doctrines')
      .select('team_role_type, guidelines')
      .eq('team_role_type', roleType)
      .eq('crisis_category', crisisCategory)
      .single();

    if (!data) return null;

    return {
      team_name: teamName,
      guidelines: data.guidelines as TeamBestPractice['guidelines'],
    };
  } catch {
    return null;
  }
}

export async function cacheTeamDoctrines(
  teamName: string,
  guidelines: TeamBestPractice['guidelines'],
  crisisCategory = 'social_media_crisis',
): Promise<void> {
  const roleType = normalizeRole(teamName);
  const sources = guidelines.map((g) => g.source_basis).filter(Boolean);

  try {
    await supabaseAdmin.from('social_crisis_doctrines').upsert(
      {
        team_role_type: roleType,
        crisis_category: crisisCategory,
        guidelines,
        source_basis: sources,
      },
      { onConflict: 'team_role_type,crisis_category' },
    );
    logger.info({ roleType, guidelineCount: guidelines.length }, 'Cached team doctrines');
  } catch (err) {
    logger.warn({ err, roleType }, 'Failed to cache team doctrines');
  }
}

export async function getCachedGroupDoctrines(
  crisisCategory = 'social_media_crisis',
): Promise<ResearchGuidelines['group_wide'] | null> {
  try {
    const { data } = await supabaseAdmin
      .from('social_crisis_group_doctrines')
      .select('*')
      .eq('crisis_category', crisisCategory)
      .single();

    if (!data) return null;

    return {
      coordination_guidelines: (data.coordination_guidelines || []) as string[],
      escalation_protocols: (data.escalation_protocols || []) as string[],
      timing_benchmarks: (data.timing_benchmarks || {}) as Record<string, number>,
      case_studies: (data.case_studies || []) as Array<{
        name: string;
        summary: string;
        lessons: string[];
      }>,
    };
  } catch {
    return null;
  }
}

export async function cacheGroupDoctrines(
  groupWide: ResearchGuidelines['group_wide'],
  crisisCategory = 'social_media_crisis',
): Promise<void> {
  try {
    await supabaseAdmin.from('social_crisis_group_doctrines').upsert(
      {
        crisis_category: crisisCategory,
        coordination_guidelines: groupWide.coordination_guidelines,
        escalation_protocols: groupWide.escalation_protocols,
        timing_benchmarks: groupWide.timing_benchmarks,
        case_studies: groupWide.case_studies,
      },
      { onConflict: 'crisis_category' },
    );
    logger.info('Cached group doctrines');
  } catch (err) {
    logger.warn({ err }, 'Failed to cache group doctrines');
  }
}

export async function getCachedBenchmarks(
  crisisCategory = 'social_media_crisis',
): Promise<StrategicActionBenchmark[] | null> {
  try {
    const { data } = await supabaseAdmin
      .from('social_crisis_benchmarks_cache')
      .select('benchmarks')
      .eq('crisis_category', crisisCategory)
      .single();

    if (!data) return null;
    return data.benchmarks as StrategicActionBenchmark[];
  } catch {
    return null;
  }
}

export async function cacheBenchmarks(
  benchmarks: StrategicActionBenchmark[],
  crisisCategory = 'social_media_crisis',
): Promise<void> {
  try {
    await supabaseAdmin.from('social_crisis_benchmarks_cache').upsert(
      {
        crisis_category: crisisCategory,
        benchmarks,
      },
      { onConflict: 'crisis_category' },
    );
    logger.info({ count: benchmarks.length }, 'Cached strategic benchmarks');
  } catch (err) {
    logger.warn({ err }, 'Failed to cache benchmarks');
  }
}

export async function getOrResearchTeamDoctrines(
  teams: TeamDef[],
  crisisType: string,
  context: string,
  teamStorylines: Record<string, Array<Record<string, unknown>>>,
  researchFn: (
    crisisType: string,
    context: string,
    teams: TeamDef[],
    storylines: Record<string, Array<Record<string, unknown>>>,
    onTeamComplete?: (teamName: string) => void,
  ) => Promise<ResearchGuidelines>,
  onTeamComplete?: (teamName: string) => void,
): Promise<ResearchGuidelines> {
  const cachedPerTeam: TeamBestPractice[] = [];
  const uncachedTeams: TeamDef[] = [];

  for (const team of teams) {
    const cached = await getCachedTeamDoctrines(team.team_name);
    if (cached && cached.guidelines.length > 0) {
      cachedPerTeam.push(cached);
      logger.info({ team: team.team_name }, 'Using cached doctrines');
      onTeamComplete?.(team.team_name);
    } else {
      uncachedTeams.push(team);
    }
  }

  const cachedGroupWide = await getCachedGroupDoctrines();

  if (uncachedTeams.length === 0 && cachedGroupWide) {
    logger.info({ cachedTeams: cachedPerTeam.length }, 'All doctrines from cache');
    return { per_team: cachedPerTeam, group_wide: cachedGroupWide };
  }

  const freshResult = await researchFn(
    crisisType,
    context,
    uncachedTeams.length > 0 ? uncachedTeams : teams,
    teamStorylines,
    onTeamComplete,
  );

  for (const teamRes of freshResult.per_team) {
    if (teamRes.guidelines.length > 0) {
      await cacheTeamDoctrines(teamRes.team_name, teamRes.guidelines);
    }
  }

  if (!cachedGroupWide) {
    await cacheGroupDoctrines(freshResult.group_wide);
  }

  return {
    per_team: [...cachedPerTeam, ...freshResult.per_team],
    group_wide: cachedGroupWide || freshResult.group_wide,
  };
}
