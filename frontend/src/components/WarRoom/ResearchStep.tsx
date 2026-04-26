import { useState, useCallback } from 'react';
import { api } from '../../lib/api';

// ── Types ─────────────────────────────────────────────────────────────────

interface DoctrineFinding {
  domain: string;
  source: string;
  key_points: string[];
  decision_thresholds?: string;
}

interface TeamWorkflow {
  endgame: string;
  steps: string[];
  personnel_ratios?: Record<string, string>;
  sop_checklist?: string[];
}

interface ResearchData {
  draft_id: string;
  phase1Preview: {
    scenario: { title: string; description: string; briefing: string };
    teams: Array<{ team_name: string; team_description?: string }>;
    objectives: Array<Record<string, unknown>>;
  };
  doctrines: {
    standardsFindings: DoctrineFinding[];
    perTeamDoctrines: Record<string, DoctrineFinding[]>;
    teamWorkflows: Record<string, TeamWorkflow>;
  };
  enrichment: {
    hazardAnalysis: Array<Record<string, unknown>>;
    sceneSynthesis: Record<string, unknown>;
    overallAssessment: string;
    generatedCasualties: Array<Record<string, unknown>>;
  } | null;
  geocode: { lat: number; lng: number; display_name: string } | null;
  areaSummary: string | null;
}

interface ResearchStepProps {
  wizardDraftId: string | null;
  onComplete: (data: Record<string, unknown>) => void;
}

// ── Collapsible Section ──────────────────────────────────────────────────

function Section({
  title,
  badge,
  color,
  defaultOpen,
  children,
}: {
  title: string;
  badge?: string | number;
  color?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  return (
    <div className="border border-robotic-gray-200 rounded mb-3">
      <button
        onClick={() => setOpen(!open)}
        className="w-full text-left px-4 py-3 flex justify-between items-center hover:bg-robotic-gray-200/20"
      >
        <span className="text-xs terminal-text uppercase" style={{ color: color || '#d4a017' }}>
          {title}
        </span>
        <div className="flex items-center gap-2">
          {badge !== undefined && (
            <span className="text-[10px] terminal-text text-robotic-yellow/30 bg-robotic-gray-200/50 px-1.5 py-0.5 rounded">
              {badge}
            </span>
          )}
          <span className="text-robotic-yellow/40 text-sm">{open ? '−' : '+'}</span>
        </div>
      </button>
      {open && <div className="px-4 pb-4 border-t border-robotic-gray-200">{children}</div>}
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────

export function ResearchStep({ wizardDraftId, onComplete }: ResearchStepProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ResearchData | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const startResearch = useCallback(async () => {
    if (!wizardDraftId) {
      setError('No wizard draft available. Go back and complete previous steps.');
      return;
    }
    setLoading(true);
    setError(null);
    setElapsed(0);

    const timer = setInterval(() => setElapsed((e) => e + 1), 1000);

    try {
      const { data: result } = await api.warroom.wizardDraftResearchDoctrines(wizardDraftId);
      setData(result as unknown as ResearchData);
      onComplete(result as unknown as Record<string, unknown>);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Research failed. Try again.');
    } finally {
      clearInterval(timer);
      setLoading(false);
    }
  }, [wizardDraftId, onComplete]);

  // Loading state with progress phases
  if (loading) {
    const phases = [
      { time: 0, label: 'Generating scenario narrative and teams...' },
      { time: 8, label: 'Researching per-team standards and doctrines...' },
      { time: 20, label: 'Analyzing hazard physics and blast effects...' },
      { time: 35, label: 'Generating casualties and enrichment data...' },
      { time: 50, label: 'Researching team workflows and SOPs...' },
      { time: 70, label: 'Compiling results...' },
    ];
    const currentPhase = [...phases].reverse().find((p) => elapsed >= p.time) ?? phases[0];

    return (
      <div className="flex flex-col items-center justify-center h-[400px]">
        <div className="text-lg terminal-text text-cyan-400 animate-pulse mb-4">
          AI RESEARCH IN PROGRESS
        </div>
        <div className="text-xs terminal-text text-robotic-yellow/50 mb-2">
          {currentPhase.label}
        </div>
        <div className="text-[10px] terminal-text text-robotic-yellow/30 mb-6">
          {elapsed}s elapsed
        </div>
        <div className="w-64 h-1.5 bg-robotic-gray-200 rounded overflow-hidden">
          <div
            className="h-full bg-cyan-500 transition-all duration-1000"
            style={{ width: `${Math.min((elapsed / 90) * 100, 95)}%` }}
          />
        </div>
        <div className="mt-8 text-[10px] terminal-text text-robotic-yellow/20 max-w-md text-center">
          This may take 1-2 minutes. The AI is researching real-world incident data, team doctrines,
          and analyzing blast physics for your scene.
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-[300px]">
        <div className="text-lg terminal-text text-red-400 mb-4">RESEARCH FAILED</div>
        <div className="text-xs terminal-text text-red-300/70 max-w-md text-center mb-6">
          {error}
        </div>
        <button onClick={startResearch} className="military-button px-6 py-2 text-xs">
          Retry Research
        </button>
      </div>
    );
  }

  // Pre-research state
  if (!data) {
    return (
      <div className="flex flex-col items-center justify-center h-[300px]">
        <div className="text-sm terminal-text text-robotic-yellow/60 mb-6 max-w-lg text-center">
          The AI will research similar real-world incidents, generate a scenario narrative, analyze
          hazard physics, and produce per-team doctrines and workflows.
        </div>
        <button
          onClick={startResearch}
          disabled={!wizardDraftId}
          className="military-button px-8 py-3 text-sm disabled:opacity-30"
        >
          START RESEARCH
        </button>
        {!wizardDraftId && (
          <div className="text-[10px] terminal-text text-red-400/50 mt-2">
            Draft not available -- complete previous steps first.
          </div>
        )}
      </div>
    );
  }

  // Results display
  const { phase1Preview, doctrines, enrichment, areaSummary } = data;
  const scenario = phase1Preview?.scenario;
  const teams = phase1Preview?.teams ?? [];
  const objectives = phase1Preview?.objectives ?? [];
  const teamNames = Object.keys(doctrines?.perTeamDoctrines ?? {});

  return (
    <div className="space-y-2 max-h-[calc(100vh-380px)] overflow-y-auto pr-2">
      {/* Scenario Overview */}
      <Section title="Scenario Overview" color="#22d3ee" defaultOpen>
        {scenario && (
          <div className="space-y-3 pt-3">
            <div>
              <div className="text-sm terminal-text text-cyan-300 font-bold">{scenario.title}</div>
            </div>
            <div>
              <div className="text-[10px] terminal-text text-robotic-yellow/40 uppercase mb-1">
                Synopsis
              </div>
              <div className="text-xs terminal-text text-robotic-yellow/70 whitespace-pre-wrap">
                {scenario.description}
              </div>
            </div>
            <div>
              <div className="text-[10px] terminal-text text-robotic-yellow/40 uppercase mb-1">
                Briefing
              </div>
              <div className="text-xs terminal-text text-robotic-yellow/60 whitespace-pre-wrap">
                {scenario.briefing}
              </div>
            </div>
          </div>
        )}
      </Section>

      {/* Teams & Objectives */}
      <Section title="Teams & Objectives" badge={teams.length} color="#a855f7">
        <div className="pt-3 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {teams.map((t, i) => (
              <div key={i} className="border border-robotic-gray-200 rounded px-3 py-2">
                <div className="text-xs terminal-text text-purple-400 font-bold">{t.team_name}</div>
                {t.team_description && (
                  <div className="text-[10px] terminal-text text-robotic-yellow/40 mt-1">
                    {t.team_description}
                  </div>
                )}
              </div>
            ))}
          </div>
          {objectives.length > 0 && (
            <div>
              <div className="text-[10px] terminal-text text-robotic-yellow/40 uppercase mb-1">
                Objectives ({objectives.length})
              </div>
              <div className="space-y-1">
                {objectives.map((obj, i) => (
                  <div key={i} className="text-xs terminal-text text-robotic-yellow/60 flex gap-2">
                    <span className="text-robotic-yellow/30">{i + 1}.</span>
                    <span>
                      {((obj as Record<string, unknown>).description as string) ||
                        JSON.stringify(obj)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </Section>

      {/* Per-Team Doctrines */}
      {teamNames.length > 0 && (
        <Section title="Per-Team Doctrines & Standards" badge={teamNames.length} color="#f97316">
          <div className="pt-3 space-y-4">
            {teamNames.map((teamName) => {
              const findings = doctrines.perTeamDoctrines[teamName] ?? [];
              const workflow = doctrines.teamWorkflows?.[teamName];
              return (
                <div key={teamName} className="border border-robotic-gray-200 rounded p-3">
                  <div className="text-xs terminal-text text-orange-400 font-bold mb-2">
                    {teamName}
                  </div>

                  {/* Doctrine findings */}
                  {findings.map((f, i) => (
                    <div key={i} className="mb-2">
                      <div className="text-[10px] terminal-text text-robotic-yellow/40">
                        {f.domain} — <span className="italic">{f.source}</span>
                      </div>
                      <ul className="mt-1 space-y-0.5">
                        {f.key_points.map((kp, j) => (
                          <li
                            key={j}
                            className="text-[10px] terminal-text text-robotic-yellow/60 flex gap-1"
                          >
                            <span className="text-robotic-yellow/30">-</span>
                            <span>{kp}</span>
                          </li>
                        ))}
                      </ul>
                      {f.decision_thresholds && (
                        <div className="text-[10px] terminal-text text-yellow-500/60 mt-1">
                          Threshold: {f.decision_thresholds}
                        </div>
                      )}
                    </div>
                  ))}

                  {/* Workflow */}
                  {workflow && (
                    <div className="border-t border-robotic-gray-200 pt-2 mt-2">
                      <div className="text-[10px] terminal-text text-robotic-yellow/40 uppercase mb-1">
                        Workflow
                      </div>
                      <div className="text-[10px] terminal-text text-cyan-400/70 mb-1">
                        Endgame: {workflow.endgame}
                      </div>
                      <ol className="space-y-0.5">
                        {workflow.steps.map((step, j) => (
                          <li
                            key={j}
                            className="text-[10px] terminal-text text-robotic-yellow/50 flex gap-1"
                          >
                            <span className="text-robotic-yellow/30 w-4">{j + 1}.</span>
                            <span>{step}</span>
                          </li>
                        ))}
                      </ol>
                      {workflow.sop_checklist && workflow.sop_checklist.length > 0 && (
                        <div className="mt-1">
                          <div className="text-[10px] terminal-text text-robotic-yellow/30">
                            SOP Checklist:
                          </div>
                          {workflow.sop_checklist.map((item, j) => (
                            <div
                              key={j}
                              className="text-[10px] terminal-text text-robotic-yellow/40 ml-2"
                            >
                              - {item}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {/* General Standards */}
      {doctrines?.standardsFindings && doctrines.standardsFindings.length > 0 && (
        <Section title="General Standards & References" badge={doctrines.standardsFindings.length}>
          <div className="pt-3 space-y-2">
            {doctrines.standardsFindings.map((f, i) => (
              <div key={i} className="border-b border-robotic-gray-200 pb-2 last:border-b-0">
                <div className="text-[10px] terminal-text text-robotic-yellow/50 font-bold">
                  {f.domain}
                </div>
                <div className="text-[10px] terminal-text text-robotic-yellow/30 italic">
                  {f.source}
                </div>
                <ul className="mt-1 space-y-0.5">
                  {f.key_points.map((kp, j) => (
                    <li key={j} className="text-[10px] terminal-text text-robotic-yellow/50">
                      - {kp}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Hazard Enrichment */}
      {enrichment && (
        <Section title="Hazard & Environmental Analysis" color="#ef4444">
          <div className="pt-3 space-y-3">
            <div>
              <div className="text-[10px] terminal-text text-robotic-yellow/40 uppercase mb-1">
                Overall Assessment
              </div>
              <div className="text-xs terminal-text text-robotic-yellow/60 whitespace-pre-wrap">
                {enrichment.overallAssessment}
              </div>
            </div>
            {enrichment.hazardAnalysis.length > 0 && (
              <div>
                <div className="text-[10px] terminal-text text-robotic-yellow/40 uppercase mb-1">
                  Hazard Analyses ({enrichment.hazardAnalysis.length})
                </div>
                {enrichment.hazardAnalysis.map((ha, i) => (
                  <div
                    key={i}
                    className="border border-robotic-gray-200 rounded p-2 mb-1 text-[10px] terminal-text text-robotic-yellow/50"
                  >
                    <div className="font-bold text-red-400">
                      {(ha.hazardType as string) || `Hazard ${i + 1}`}
                    </div>
                    {(ha.analysisNarrative as string) && (
                      <div className="mt-1 whitespace-pre-wrap">
                        {ha.analysisNarrative as string}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            {enrichment.generatedCasualties && enrichment.generatedCasualties.length > 0 && (
              <div className="text-xs terminal-text text-robotic-yellow/50">
                Generated {enrichment.generatedCasualties.length} casualties from blast analysis.
              </div>
            )}
          </div>
        </Section>
      )}

      {/* Area Summary */}
      {areaSummary && (
        <Section title="Area Research Summary">
          <div className="pt-3 text-xs terminal-text text-robotic-yellow/50 whitespace-pre-wrap max-h-48 overflow-y-auto">
            {areaSummary}
          </div>
        </Section>
      )}

      {/* Completion indicator */}
      <div className="text-center py-4">
        <div className="text-xs terminal-text text-green-500/70">
          Research complete. Click [NEXT] to proceed.
        </div>
      </div>
    </div>
  );
}
