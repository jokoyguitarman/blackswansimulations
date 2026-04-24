import { useState } from 'react';
import { useRoleVisibility } from '../hooks/useRoleVisibility';

interface TeamEntry {
  team_name: string;
  team_description: string;
  min_participants: number;
  max_participants: number;
  is_investigative: boolean;
}

const STEP_LABELS: Record<number, string> = {
  1: 'Incident',
  2: 'Teams',
  3: 'Scene Editor',
  5: 'Location',
  6: 'Research',
  7: 'Hazard Analysis',
  8: 'Casualties',
  9: 'Injects',
  10: 'Doctrines',
  11: 'Review',
};

const VISIBLE_STEPS = [1, 2, 3, 5, 6, 7, 8, 9, 10, 11];

export const WarRoom = () => {
  const { isTrainer } = useRoleVisibility();

  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11>(1);

  // Step 1: Incident selection
  const [incidentType, setIncidentType] = useState<string | null>(null);
  const [customIncidentText, setCustomIncidentText] = useState('');

  // Step 2: Teams
  const [teams, setTeams] = useState<TeamEntry[]>([]);

  // Step 3: Scene editor
  const [rtsSceneId, setRtsSceneId] = useState<string | null>(null);
  const [sceneConfig, setSceneConfig] = useState<Record<string, unknown> | null>(null);
  const [weaponType, setWeaponType] = useState<string | null>(null);

  // Step 5: Location validation
  const [geoResult, setGeoResult] = useState<Record<string, unknown> | null>(null);

  // Step 6: Research
  const [researchResults, setResearchResults] = useState<Record<string, unknown> | null>(null);

  // Step 7: Hazard analysis
  const [hazardAnalysis, setHazardAnalysis] = useState<Record<string, unknown> | null>(null);

  // Step 8: Casualties
  const [casualties, setCasualties] = useState<Array<Record<string, unknown>>>([]);

  // Step 9: Injects
  const [injects, setInjects] = useState<Array<Record<string, unknown>>>([]);

  // Step 10: Doctrines
  const [doctrines, setDoctrines] = useState<Record<string, unknown> | null>(null);

  // Suppress unused-var warnings until steps are implemented
  void setIncidentType;
  void setCustomIncidentText;
  void setTeams;
  void setRtsSceneId;
  void setSceneConfig;
  void setWeaponType;
  void setGeoResult;
  void setResearchResults;
  void setHazardAnalysis;
  void setCasualties;
  void setInjects;
  void setDoctrines;

  if (!isTrainer) {
    return (
      <div className="min-h-screen scanline flex items-center justify-center">
        <div className="military-border p-8 text-center">
          <h1 className="text-xl terminal-text uppercase mb-4">[ACCESS DENIED]</h1>
          <p className="text-sm terminal-text text-robotic-yellow/70">
            War Room is available to trainers only.
          </p>
        </div>
      </div>
    );
  }

  const currentStepIndex = VISIBLE_STEPS.indexOf(step);
  const canGoBack = currentStepIndex > 0;
  const canGoNext = step < 11;

  const goBack = () => {
    if (canGoBack) {
      const prevStep = VISIBLE_STEPS[currentStepIndex - 1];
      setStep(prevStep as typeof step);
    }
  };

  const goNext = () => {
    if (step === 3) {
      setStep(5);
    } else if (canGoNext) {
      setStep((step + 1) as typeof step);
    }
  };

  return (
    <div className="min-h-screen scanline p-6">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl terminal-text uppercase tracking-wider">[WAR ROOM]</h1>
          <span className="text-xs terminal-text text-robotic-yellow/50">v2.0</span>
        </div>

        {/* Step progress bar */}
        <div className="military-border p-3 mb-6 bg-robotic-gray-300">
          <div className="flex items-center gap-1 overflow-x-auto">
            {VISIBLE_STEPS.map((s, i) => {
              const isCurrent = s === step;
              const isPast = VISIBLE_STEPS.indexOf(step) > i;
              return (
                <div key={s} className="flex items-center">
                  {i > 0 && (
                    <div
                      className={`w-4 h-px mx-1 ${
                        isPast ? 'bg-robotic-yellow' : 'bg-robotic-gray-200'
                      }`}
                    />
                  )}
                  <div
                    className={`flex items-center gap-1.5 px-2 py-1 rounded text-[10px] terminal-text uppercase whitespace-nowrap ${
                      isCurrent
                        ? 'border border-robotic-yellow bg-robotic-yellow/10 text-robotic-yellow'
                        : isPast
                          ? 'text-robotic-yellow/70'
                          : 'text-robotic-yellow/30'
                    }`}
                  >
                    <span
                      className={`w-4 h-4 flex items-center justify-center rounded-full text-[9px] font-bold ${
                        isCurrent
                          ? 'bg-robotic-yellow text-black'
                          : isPast
                            ? 'bg-robotic-yellow/30 text-robotic-yellow'
                            : 'bg-robotic-gray-200 text-robotic-yellow/30'
                      }`}
                    >
                      {isPast ? '\u2713' : VISIBLE_STEPS.indexOf(s) + 1}
                    </span>
                    {STEP_LABELS[s]}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Step content */}
        <div className="military-border p-6 mb-6 min-h-[400px]">
          {step === 1 && (
            <div>
              <h2 className="text-lg terminal-text uppercase mb-4">[STEP 1: INCIDENT SELECTION]</h2>
              <p className="text-xs terminal-text text-robotic-yellow/50">
                Select the type of incident for this training scenario.
              </p>
              <div className="mt-4 text-sm terminal-text text-robotic-yellow/30">
                [Incident selector will be implemented here]
              </div>
              <div className="mt-2 text-[10px] terminal-text text-robotic-yellow/20">
                State: incidentType={incidentType || 'null'}, custom="{customIncidentText}"
              </div>
            </div>
          )}

          {step === 2 && (
            <div>
              <h2 className="text-lg terminal-text uppercase mb-4">[STEP 2: TEAM SELECTION]</h2>
              <p className="text-xs terminal-text text-robotic-yellow/50">
                Configure the response teams for this scenario.
              </p>
              <div className="mt-4 text-sm terminal-text text-robotic-yellow/30">
                [Team selector will be implemented here]
              </div>
              <div className="mt-2 text-[10px] terminal-text text-robotic-yellow/20">
                State: teams={teams.length}
              </div>
            </div>
          )}

          {step === 3 && (
            <div>
              <h2 className="text-lg terminal-text uppercase mb-4">[STEP 3: SCENE EDITOR]</h2>
              <p className="text-xs terminal-text text-robotic-yellow/50">
                Design the physical scene for the exercise. Place buildings, exits, hazards, blast
                zones, and perimeter inspection points.
              </p>
              <div className="mt-4 text-sm terminal-text text-robotic-yellow/30">
                [Scene editor will be implemented here]
              </div>
              <div className="mt-2 text-[10px] terminal-text text-robotic-yellow/20">
                State: rtsSceneId={rtsSceneId || 'null'}, weaponType={weaponType || 'null'}
              </div>
            </div>
          )}

          {step === 5 && (
            <div>
              <h2 className="text-lg terminal-text uppercase mb-4">
                [STEP 5: LOCATION VALIDATION]
              </h2>
              <p className="text-xs terminal-text text-robotic-yellow/50">
                Identify nearby facilities, routes, and points of interest.
              </p>
              <div className="mt-4 text-sm terminal-text text-robotic-yellow/30">
                [Location validation will be implemented here]
              </div>
              <div className="mt-2 text-[10px] terminal-text text-robotic-yellow/20">
                State: geoResult={geoResult ? 'loaded' : 'null'}
              </div>
            </div>
          )}

          {step === 6 && (
            <div>
              <h2 className="text-lg terminal-text uppercase mb-4">[STEP 6: INCIDENT RESEARCH]</h2>
              <p className="text-xs terminal-text text-robotic-yellow/50">
                AI researches similar incidents and analyzes the area. Weapon type inference if not
                specified.
              </p>
              <div className="mt-4 text-sm terminal-text text-robotic-yellow/30">
                [Research results will be implemented here]
              </div>
              <div className="mt-2 text-[10px] terminal-text text-robotic-yellow/20">
                State: researchResults={researchResults ? 'loaded' : 'null'}
              </div>
            </div>
          )}

          {step === 7 && (
            <div>
              <h2 className="text-lg terminal-text uppercase mb-4">
                [STEP 7: HAZARD PHYSICS ANALYSIS]
              </h2>
              <p className="text-xs terminal-text text-robotic-yellow/50">
                AI analyzes blast physics, determines which hazards are affected, and models
                fire/smoke/gas spread across studs.
              </p>
              <div className="mt-4 text-sm terminal-text text-robotic-yellow/30">
                [Hazard analysis visualization will be implemented here]
              </div>
              <div className="mt-2 text-[10px] terminal-text text-robotic-yellow/20">
                State: hazardAnalysis={hazardAnalysis ? 'loaded' : 'null'}, sceneConfig=
                {sceneConfig ? 'loaded' : 'null'}
              </div>
            </div>
          )}

          {step === 8 && (
            <div>
              <h2 className="text-lg terminal-text uppercase mb-4">
                [STEP 8: CASUALTY GENERATION]
              </h2>
              <p className="text-xs terminal-text text-robotic-yellow/50">
                AI places casualties within the blast radius. Review positions, injuries, and
                deterioration timelines.
              </p>
              <div className="mt-4 text-sm terminal-text text-robotic-yellow/30">
                [Casualty generation will be implemented here]
              </div>
              <div className="mt-2 text-[10px] terminal-text text-robotic-yellow/20">
                State: casualties={casualties.length}
              </div>
            </div>
          )}

          {step === 9 && (
            <div>
              <h2 className="text-lg terminal-text uppercase mb-4">[STEP 9: INJECT GENERATION]</h2>
              <p className="text-xs terminal-text text-robotic-yellow/50">
                AI generates time-based injects, media pins, and crowd events. Add custom injects.
              </p>
              <div className="mt-4 text-sm terminal-text text-robotic-yellow/30">
                [Inject editor will be implemented here]
              </div>
              <div className="mt-2 text-[10px] terminal-text text-robotic-yellow/20">
                State: injects={injects.length}
              </div>
            </div>
          )}

          {step === 10 && (
            <div>
              <h2 className="text-lg terminal-text uppercase mb-4">[STEP 10: DOCTRINE RESEARCH]</h2>
              <p className="text-xs terminal-text text-robotic-yellow/50">
                AI researches per-team standards, doctrines, and SOPs. Review and edit.
              </p>
              <div className="mt-4 text-sm terminal-text text-robotic-yellow/30">
                [Doctrine research will be implemented here]
              </div>
              <div className="mt-2 text-[10px] terminal-text text-robotic-yellow/20">
                State: doctrines={doctrines ? 'loaded' : 'null'}
              </div>
            </div>
          )}

          {step === 11 && (
            <div>
              <h2 className="text-lg terminal-text uppercase mb-4">[STEP 11: SCENARIO REVIEW]</h2>
              <p className="text-xs terminal-text text-robotic-yellow/50">
                Review the complete scenario before compilation. All pins include expected player
                approaches for evaluation.
              </p>
              <div className="mt-4 text-sm terminal-text text-robotic-yellow/30">
                [Scenario review will be implemented here]
              </div>
            </div>
          )}
        </div>

        {/* Navigation buttons */}
        <div className="flex justify-between items-center">
          <button
            onClick={goBack}
            disabled={!canGoBack}
            className="px-6 py-3 text-xs terminal-text uppercase border border-robotic-gray-200 text-robotic-yellow/70 hover:border-robotic-yellow/50 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            [BACK]
          </button>
          <span className="text-xs terminal-text text-robotic-yellow/40">
            Step {VISIBLE_STEPS.indexOf(step) + 1} of {VISIBLE_STEPS.length}
          </span>
          {step === 11 ? (
            <button className="military-button px-8 py-3">[COMPILE SCENARIO]</button>
          ) : (
            <button
              onClick={goNext}
              disabled={!canGoNext}
              className="military-button px-8 py-3 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              [NEXT]
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
