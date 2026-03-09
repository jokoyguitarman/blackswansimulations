/**
 * Trainer-only module: shows environmental truths / conditions (layout, triage candidates,
 * evacuation holding, routes, hospitals, sector standards) that players are evaluated against.
 */

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

interface LayoutGroundTruth {
  evacuee_count?: number;
  exits?: Array<{
    id?: string;
    label?: string;
    flow_per_min?: number;
    status?: string;
  }>;
  zones?: Array<{ id?: string; label?: string; capacity?: number; type?: string }>;
  blast_site?: { description?: string };
}

interface SiteArea {
  label?: string;
  capacity_lying?: number;
  capacity_standing?: number;
  area_m2?: number;
  hazards?: string;
  vehicle_access?: boolean;
  stretcher_route?: boolean;
  water?: boolean;
  power?: boolean;
}

interface OsmVicinity {
  emergency_routes?: Array<{ description?: string; one_way?: boolean }>;
  hospitals?: Array<{ name?: string; address?: string }>;
}

interface InsiderKnowledge {
  layout_ground_truth?: LayoutGroundTruth;
  site_areas?: SiteArea[];
  osm_vicinity?: OsmVicinity;
  sector_standards?: string;
}

interface LocationRow {
  label?: string;
  location_type?: string;
  coordinates?: { lat?: number; lng?: number };
  conditions?: Record<string, unknown> | null;
}

interface EnvArea {
  area_id?: string;
  label?: string;
  type?: string;
  at_capacity?: boolean;
  capacity?: number;
}

interface SessionRoute {
  label?: string;
  problem?: string | null;
  managed?: boolean;
  travel_time_minutes?: number | null;
}

interface TrainerEnvironmentalTruthsProps {
  sessionId: string;
  scenarioId: string;
}

export const TrainerEnvironmentalTruths = ({
  sessionId,
  scenarioId,
}: TrainerEnvironmentalTruthsProps) => {
  const [insiderKnowledge, setInsiderKnowledge] = useState<InsiderKnowledge | null>(null);
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [sessionRoutes, setSessionRoutes] = useState<SessionRoute[]>([]);
  const [envAreas, setEnvAreas] = useState<EnvArea[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!scenarioId || !sessionId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      api.scenarios
        .get(scenarioId)
        .then(
          (r) => (r.data as { insider_knowledge?: InsiderKnowledge })?.insider_knowledge ?? null,
        ),
      api.sessions.getLocations(sessionId).then((r) => (r.data ?? []) as LocationRow[]),
      api.sessions.get(sessionId).then((r) => {
        const data = r.data as {
          current_state?: {
            environmental_state?: {
              routes?: SessionRoute[];
              areas?: EnvArea[];
            };
          };
        };
        const env = data?.current_state?.environmental_state;
        return {
          routes: Array.isArray(env?.routes) ? env.routes : [],
          areas: Array.isArray(env?.areas) ? env.areas : [],
        };
      }),
    ])
      .then(([ik, locs, sessionData]) => {
        if (!cancelled) {
          setInsiderKnowledge((ik as InsiderKnowledge) ?? null);
          setLocations(locs ?? []);
          const { routes, areas } = sessionData as { routes: SessionRoute[]; areas: EnvArea[] };
          setSessionRoutes(routes ?? []);
          setEnvAreas(areas ?? []);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, scenarioId]);

  if (loading) {
    return (
      <div className="p-4 text-sm terminal-text text-robotic-yellow/70">
        Loading environmental truths…
      </div>
    );
  }
  if (error) {
    return <div className="p-4 text-sm terminal-text text-robotic-red">Error: {error}</div>;
  }

  const layout = insiderKnowledge?.layout_ground_truth;
  const siteAreas = insiderKnowledge?.site_areas ?? [];
  const osm = insiderKnowledge?.osm_vicinity;
  const sectorStandards = insiderKnowledge?.sector_standards;
  const triageLocs = locations.filter(
    (l) => l.location_type === 'area' || l.location_type === 'triage_site',
  );
  const evacHoldingLocs = locations.filter((l) => l.location_type === 'evacuation_holding');

  const hospitalAreas = envAreas.filter((a) => a.type === 'hospital');
  const hasHospitalData = hospitalAreas.length > 0 ? hospitalAreas : (osm?.hospitals ?? []);

  return (
    <div className="env-truths-panel terminal-text space-y-4 text-sm overflow-y-auto">
      <h4 className="text-robotic-yellow uppercase text-xs font-semibold border-b border-robotic-yellow/30 pb-1">
        [ENVIRONMENT GROUND TRUTH]
      </h4>

      {layout && (
        <>
          {layout.evacuee_count != null && (
            <div>
              <span className="text-robotic-yellow/80">Evacuees:</span>{' '}
              <span className="text-robotic-gray-50">{layout.evacuee_count}</span>
            </div>
          )}
          {layout.exits && layout.exits.length > 0 && (
            <div>
              <div className="text-robotic-yellow/80 mb-1">Exits</div>
              <ul className="list-disc pl-4 space-y-0.5 text-robotic-gray-50">
                {layout.exits.map((e, i) => (
                  <li key={i}>
                    {e.label ?? e.id} — {e.flow_per_min ?? '?'}/min
                    {e.status ? ` [${e.status}]` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {layout.zones && layout.zones.length > 0 && (
            <div>
              <div className="text-robotic-yellow/80 mb-1">Zones / areas</div>
              <ul className="list-disc pl-4 space-y-0.5 text-robotic-gray-50">
                {layout.zones.map((z, i) => (
                  <li key={i}>
                    {z.label ?? z.id}
                    {z.capacity != null ? ` — capacity ${z.capacity}` : ''}
                    {z.type ? ` (${z.type})` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {layout.blast_site &&
            typeof layout.blast_site === 'object' &&
            layout.blast_site.description && (
              <div>
                <span className="text-robotic-yellow/80">Blast / cordon:</span>{' '}
                <span className="text-robotic-gray-50">{layout.blast_site.description}</span>
              </div>
            )}
        </>
      )}

      {triageLocs.length > 0 && (
        <div>
          <div className="text-robotic-yellow/80 mb-1">Triage zone candidates</div>
          <ul className="list-disc pl-4 space-y-0.5 text-robotic-gray-50">
            {triageLocs.map((loc, i) => {
              const sa = siteAreas[i];
              const cap = sa
                ? [
                    sa.capacity_lying != null && `lying ${sa.capacity_lying}`,
                    sa.capacity_standing != null && `standing ${sa.capacity_standing}`,
                  ]
                    .filter(Boolean)
                    .join(', ')
                : null;
              return (
                <li key={i}>
                  {loc.label ?? `Area ${i + 1}`}
                  {cap ? ` — ${cap}` : ''}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {evacHoldingLocs.length > 0 && (
        <div>
          <div className="text-robotic-yellow/80 mb-1">Evacuation holding areas</div>
          <ul className="list-disc pl-4 space-y-0.5 text-robotic-gray-50">
            {evacHoldingLocs.map((loc, i) => {
              const cond = (loc.conditions ?? {}) as { capacity?: number; suitability?: string };
              const cap = cond.capacity != null ? ` — capacity ${cond.capacity}` : '';
              const suit = cond.suitability ? `, ${cond.suitability}` : '';
              return (
                <li key={i}>
                  {loc.label ?? 'Unknown'}
                  {cap}
                  {suit}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {(sessionRoutes.length > 0 || (osm?.emergency_routes?.length ?? 0) > 0) && (
        <div>
          <div className="text-robotic-yellow/80 mb-1">Routes (managed/unmanaged, traffic)</div>
          <p className="text-robotic-gray-50/80 text-xs mb-1">
            Session data used for consistency checks; affects robustness cap and counter pressure.
          </p>
          <ul className="list-disc pl-4 space-y-0.5 text-robotic-gray-50">
            {sessionRoutes.length > 0
              ? sessionRoutes.map((r, i) => (
                  <li key={i}>
                    {r.label ?? 'Route'} — {r.problem?.trim() || 'clear'},{' '}
                    {r.managed ? 'managed' : 'unmanaged'}
                    {r.travel_time_minutes != null ? `, ${r.travel_time_minutes} min` : ''}
                  </li>
                ))
              : (osm?.emergency_routes ?? []).map((r, i) => (
                  <li key={i}>
                    {r.description ?? 'Route'}
                    {r.one_way ? ' [one-way]' : ''} — (no session status)
                  </li>
                ))}
          </ul>
        </div>
      )}

      {hasHospitalData.length > 0 && (
        <div>
          <div className="text-robotic-yellow/80 mb-1">Nearby hospitals</div>
          <ul className="list-disc pl-4 space-y-0.5 text-robotic-gray-50">
            {hospitalAreas.length > 0
              ? hospitalAreas.map((h, i) => (
                  <li key={i}>
                    {h.label ?? 'Unknown'}
                    {h.at_capacity ? ' — at full capacity' : ''}
                    {h.capacity != null && !h.at_capacity ? ` — capacity ${h.capacity}` : ''}
                  </li>
                ))
              : (osm?.hospitals ?? []).map((h, i) => (
                  <li key={i}>
                    {h.name ?? 'Unknown'}
                    {h.address ? ` — ${h.address}` : ''}
                  </li>
                ))}
          </ul>
        </div>
      )}

      {sectorStandards && (
        <div>
          <div className="text-robotic-yellow/80 mb-1">Sector standards</div>
          <p className="text-robotic-gray-50 text-xs whitespace-pre-wrap break-words">
            {sectorStandards}
          </p>
        </div>
      )}

      {!layout?.exits?.length &&
        !layout?.zones?.length &&
        triageLocs.length === 0 &&
        evacHoldingLocs.length === 0 &&
        !osm?.emergency_routes?.length &&
        hasHospitalData.length === 0 &&
        !sectorStandards &&
        sessionRoutes.length === 0 && (
          <p className="text-robotic-yellow/70">
            No environmental truths configured for this scenario.
          </p>
        )}
    </div>
  );
};
