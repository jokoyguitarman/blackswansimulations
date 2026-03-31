import { useState, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import type { DraggableAssetDef } from './AssetPalette';
import type { PlacedAsset } from './PlacedAssetMarker';
import type { ScenarioLocationPin } from './ScenarioLocationMarker';
import { api } from '../../lib/api';
import { VoiceMicButton } from '../VoiceMicButton';
import { svg } from './mapIcons';
import { getTeamActions } from './teamResponseActions';

export interface MapElementTarget {
  elementType: 'hazard' | 'casualty' | 'crowd' | 'entry_exit';
  elementId: string;
  title: string;
  subtitle?: string;
  description?: string;
  imageUrl?: string | null;
  status?: string;
  details: Array<{ label: string; value: string }>;
  /** Casualty lat/lng for proximity checks */
  lat?: number;
  lng?: number;
}

interface DeployedAsset {
  assetType: string;
  label: string;
  icon: string;
  quantity: number;
}

interface MapElementResponsePanelProps {
  element: MapElementTarget;
  availableAssets: DraggableAssetDef[];
  sessionId: string;
  teamName: string;
  onClose: () => void;
  onSuccess?: () => void;
  /** All placed assets in the session — used for medic proximity check */
  placedAssets?: PlacedAsset[];
  /** All scenario locations — used for hospital transport destinations */
  scenarioLocations?: ScenarioLocationPin[];
  /** Callback to update triage tag on the casualty after successful submit */
  onTriageAssess?: (casualtyId: string, triageColor: string) => Promise<void>;
  /** Scenario type for context-aware team actions */
  scenarioType?: string;
}

const ICON_MAP: Record<string, string> = {
  barrier: svg('barrier', 14),
  person: svg('person', 14),
  marshal: svg('marshal', 14),
  triage_officer: svg('triage_officer', 14),
  media_officer: svg('media_officer', 14),
  firefighter: svg('firefighter', 14),
  tent: svg('tent', 14),
  medical: svg('medical_cross', 14),
  ambulance: svg('ambulance', 14),
  hazmat: svg('chemical', 14),
  camera: svg('camera', 14),
  podium: svg('broadcast', 14),
  flag: svg('flag', 14),
  command: svg('command', 14),
  fire_truck: svg('fire_truck', 14),
  helicopter: svg('helicopter', 14),
  shield: svg('police', 14),
  search: svg('eye', 14),
  radio: svg('radio', 14),
  water: svg('water', 14),
  area: svg('hexagon', 14),
  stretcher: svg('stretcher', 14),
  splint: svg('splint', 14),
  syringe: svg('syringe', 14),
  bandage: svg('bandage', 14),
  heart: svg('heartbeat', 14),
  oxygen: svg('oxygen_mask', 14),
  wrench: svg('supply', 14),
  extinguisher: svg('extinguisher', 14),
  clipboard: svg('clipboard', 14),
  mask: svg('mask', 14),
  sniper: svg('sniper', 14),
  k9: svg('k9', 14),
  tactical_unit: svg('tactical_unit', 14),
  arrest_team: svg('arrest_team', 14),
  armored_vehicle: svg('armored_vehicle', 14),
  negotiation_post: svg('negotiation_post', 14),
  listening_post: svg('listening_post', 14),
  drone: svg('drone', 14),
  intel_hub: svg('intel_hub', 14),
  covert: svg('covert', 14),
  safe_room: svg('safe_room', 14),
  protection_detail: svg('protection_detail', 14),
  vip_extract: svg('vip_extract', 14),
  checkpoint: svg('checkpoint', 14),
  cctv: svg('cctv', 14),
  steward: svg('steward', 14),
  search_point: svg('search_point', 14),
  crush_barrier: svg('crush_barrier', 14),
  pa_system: svg('pa_system', 14),
  capacity_monitor: svg('capacity_monitor', 14),
  platform_barrier: svg('platform_barrier', 14),
  service_control: svg('service_control', 14),
  emergency_light: svg('emergency_light', 14),
};

function getEmoji(icon: string): string {
  return ICON_MAP[icon] ?? svg('pin', 14);
}

const ELEMENT_TYPE_LABELS: Record<string, string> = {
  hazard: 'Hazard',
  casualty: 'Casualty',
  crowd: 'Crowd',
  entry_exit: 'Location',
};

/* ── Triage constants ── */

const MEDIC_TYPES = [
  'medic',
  'paramedic',
  'doctor',
  'nurse',
  'emt',
  'first_aider',
  'triage_officer',
];
const MEDIC_PROXIMITY_M = 80;

const TRIAGE_OPTIONS: Array<{
  color: string;
  label: string;
  bg: string;
  border: string;
  activeBg: string;
}> = [
  {
    color: 'green',
    label: 'GREEN',
    bg: 'bg-green-900/20',
    border: 'border-green-600',
    activeBg: 'bg-green-800/60',
  },
  {
    color: 'yellow',
    label: 'YELLOW',
    bg: 'bg-yellow-900/20',
    border: 'border-yellow-600',
    activeBg: 'bg-yellow-800/60',
  },
  {
    color: 'red',
    label: 'RED',
    bg: 'bg-red-900/20',
    border: 'border-red-600',
    activeBg: 'bg-red-800/60',
  },
  {
    color: 'black',
    label: 'BLACK',
    bg: 'bg-gray-900/40',
    border: 'border-gray-500',
    activeBg: 'bg-gray-700/60',
  },
];

/* ── Destination logic ── */

const DESTINATION_ASSET_TYPES: Record<string, { icon: string; label: string }> = {
  decon_zone: { icon: svg('chemical', 14), label: 'Decon Zone' },
  assembly_point: { icon: svg('flag', 14), label: 'Assembly Point' },
  triage_tent: { icon: svg('tent', 14), label: 'Triage Tent' },
  field_hospital: { icon: svg('hospital', 14), label: 'Field Hospital' },
  holding_area: { icon: svg('staging', 14), label: 'Holding Area' },
  evacuation_point: { icon: svg('door', 14), label: 'Evacuation Point' },
};

interface DestinationOption {
  id: string;
  label: string;
  icon: string;
  type: 'placed_asset' | 'hospital';
}

function getNextDestinations(
  status: string | undefined,
  placedAssets: PlacedAsset[],
  scenarioLocations: ScenarioLocationPin[],
): DestinationOption[] {
  const destinations: DestinationOption[] = [];

  const statusLower = (status ?? 'identified').replace(/ /g, '_').toLowerCase();

  const relevantAssetTypes: string[] = [];
  switch (statusLower) {
    case 'undiscovered':
    case 'identified':
      relevantAssetTypes.push(
        'decon_zone',
        'assembly_point',
        'triage_tent',
        'field_hospital',
        'holding_area',
      );
      break;
    case 'being_evacuated':
      relevantAssetTypes.push('decon_zone', 'assembly_point', 'triage_tent', 'holding_area');
      break;
    case 'awaiting_triage':
    case 'endorsed_to_triage':
      relevantAssetTypes.push('triage_tent', 'field_hospital');
      break;
    case 'in_treatment':
      relevantAssetTypes.push('field_hospital');
      break;
    case 'endorsed_to_transport':
    case 'in_treatment':
      break;
    default:
      relevantAssetTypes.push(
        'decon_zone',
        'assembly_point',
        'triage_tent',
        'field_hospital',
        'holding_area',
      );
  }

  const seenLabels = new Set<string>();
  for (const asset of placedAssets) {
    if (asset.status !== 'active') continue;
    if (!relevantAssetTypes.includes(asset.asset_type)) continue;
    const key = `${asset.asset_type}:${asset.label}`;
    if (seenLabels.has(key)) continue;
    seenLabels.add(key);
    const meta = DESTINATION_ASSET_TYPES[asset.asset_type];
    destinations.push({
      id: asset.id,
      label: asset.label || meta?.label || asset.asset_type.replace(/_/g, ' '),
      icon: meta?.icon ?? svg('pin', 14),
      type: 'placed_asset',
    });
  }

  const showHospitals =
    statusLower === 'endorsed_to_transport' ||
    statusLower === 'in_treatment' ||
    statusLower === 'identified' ||
    statusLower === 'awaiting_triage' ||
    statusLower === 'endorsed_to_triage';

  if (showHospitals) {
    for (const loc of scenarioLocations) {
      const cat = loc.pin_category ?? loc.location_type ?? '';
      if (!cat.toLowerCase().includes('hospital')) continue;
      destinations.push({
        id: loc.id,
        label: loc.label,
        icon: svg('hospital', 14),
        type: 'hospital',
      });
    }
  }

  return destinations;
}

function getCrowdDestinations(
  placedAssets: PlacedAsset[],
  scenarioLocations: ScenarioLocationPin[],
): DestinationOption[] {
  const destinations: DestinationOption[] = [];
  const crowdAssetTypes = ['assembly_point', 'holding_area', 'evacuation_point', 'decon_zone'];

  const seenLabels = new Set<string>();
  for (const asset of placedAssets) {
    if (asset.status !== 'active') continue;
    if (!crowdAssetTypes.includes(asset.asset_type)) continue;
    const key = `${asset.asset_type}:${asset.label}`;
    if (seenLabels.has(key)) continue;
    seenLabels.add(key);
    const meta = DESTINATION_ASSET_TYPES[asset.asset_type];
    destinations.push({
      id: asset.id,
      label: asset.label || meta?.label || asset.asset_type.replace(/_/g, ' '),
      icon: meta?.icon ?? svg('pin', 14),
      type: 'placed_asset',
    });
  }

  for (const loc of scenarioLocations) {
    const cat = (loc.pin_category ?? loc.location_type ?? '').toLowerCase();
    if (cat.includes('entry_exit') || cat.includes('exit') || cat.includes('entry')) {
      destinations.push({
        id: loc.id,
        label: loc.label,
        icon: svg('door', 14),
        type: 'placed_asset',
      });
    }
  }

  return destinations;
}

/* ── Haversine ── */

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function hasMedicNearby(lat: number, lng: number, placedAssets: PlacedAsset[]): boolean {
  for (const asset of placedAssets) {
    const assetLower = asset.asset_type.toLowerCase();
    if (!MEDIC_TYPES.some((t) => assetLower.includes(t))) continue;
    if (asset.status !== 'active') continue;
    const geom = asset.geometry;
    if (geom.type !== 'Point') continue;
    const coords = geom.coordinates as [number, number];
    const dist = haversineM(lat, lng, coords[1], coords[0]);
    if (dist < MEDIC_PROXIMITY_M) return true;
  }
  return false;
}

/* ── Component ── */

export const MapElementResponsePanel = ({
  element,
  availableAssets,
  sessionId,
  teamName,
  onClose,
  onSuccess,
  placedAssets = [],
  scenarioLocations = [],
  onTriageAssess,
  scenarioType,
}: MapElementResponsePanelProps) => {
  const [deployed, setDeployed] = useState<DeployedAsset[]>([]);
  const [description, setDescription] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [triageColor, setTriageColor] = useState<string | null>(null);
  const [selectedDestination, setSelectedDestination] = useState<DestinationOption | null>(null);
  const [selectedActions, setSelectedActions] = useState<Set<string>>(new Set());
  const dropZoneRef = useRef<HTMLDivElement>(null);

  const isCasualty = element.elementType === 'casualty';
  const isTriageTeam = /triage/i.test(teamName);
  const medicNearby =
    isCasualty && element.lat != null && element.lng != null
      ? hasMedicNearby(element.lat, element.lng, placedAssets)
      : false;
  const triageEnabled = isCasualty && isTriageTeam && medicNearby;

  const isCrowd = element.elementType === 'crowd';

  const teamActions = useMemo(
    () => getTeamActions(teamName, element.elementType),
    [teamName, element.elementType],
  );

  const toggleAction = useCallback((actionId: string) => {
    setSelectedActions((prev) => {
      const next = new Set(prev);
      if (next.has(actionId)) next.delete(actionId);
      else next.add(actionId);
      return next;
    });
  }, []);

  const destinations = useMemo(() => {
    if (isCasualty) return getNextDestinations(element.status, placedAssets, scenarioLocations);
    if (isCrowd) return getCrowdDestinations(placedAssets, scenarioLocations);
    return [];
  }, [isCasualty, isCrowd, element.status, placedAssets, scenarioLocations]);

  const pointAssets = availableAssets.filter((a) => a.geometry_type === 'point');

  const addAsset = useCallback((asset: DraggableAssetDef) => {
    setDeployed((prev) => {
      const existing = prev.find((d) => d.assetType === asset.asset_type);
      if (existing) {
        return prev.map((d) =>
          d.assetType === asset.asset_type ? { ...d, quantity: d.quantity + 1 } : d,
        );
      }
      return [
        ...prev,
        { assetType: asset.asset_type, label: asset.label, icon: asset.icon, quantity: 1 },
      ];
    });
  }, []);

  const removeAsset = useCallback((assetType: string) => {
    setDeployed((prev) => {
      const existing = prev.find((d) => d.assetType === assetType);
      if (existing && existing.quantity > 1) {
        return prev.map((d) =>
          d.assetType === assetType ? { ...d, quantity: d.quantity - 1 } : d,
        );
      }
      return prev.filter((d) => d.assetType !== assetType);
    });
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      try {
        const data = JSON.parse(e.dataTransfer.getData('application/json'));
        if (data.asset_type) {
          addAsset(data as DraggableAssetDef);
        }
      } catch {
        /* ignore invalid drops */
      }
    },
    [addAsset],
  );

  const hasContent =
    deployed.length > 0 ||
    description.trim() ||
    triageColor ||
    selectedDestination ||
    selectedActions.size > 0;

  const handleSubmit = async () => {
    if (!hasContent) return;
    setIsSubmitting(true);
    setResult(null);

    const parts: string[] = [];
    if (selectedActions.size > 0) {
      const actionLabels = teamActions.filter((a) => selectedActions.has(a.id)).map((a) => a.label);
      parts.push(`Actions taken: ${actionLabels.join(', ')}`);
    }
    if (deployed.length > 0) {
      const resourceList = deployed.map((d) => `${d.quantity}x ${d.label}`).join(', ');
      parts.push(`Resources deployed: ${resourceList}`);
    }
    if (triageColor) {
      parts.push(`Triage tag: ${triageColor.toUpperCase()}`);
    }
    if (selectedDestination) {
      const moveVerb = element.elementType === 'crowd' ? 'Direct crowd to' : 'Move patient to';
      parts.push(`${moveVerb} ${selectedDestination.label}`);
    }
    if (description.trim()) {
      parts.push(description.trim());
    }

    const typeLabel = ELEMENT_TYPE_LABELS[element.elementType] ?? 'Element';
    const fullDescription = `[${typeLabel} Response: ${element.title}] ${parts.join('. ')}`;
    const title = `Response to ${element.title} by ${teamName}`;

    try {
      const createRes = await api.decisions.create({
        session_id: sessionId,
        description: fullDescription,
        team_name: teamName,
        title,
      });
      const created = (createRes as { data?: { id: string } })?.data;
      if (created?.id) {
        await api.decisions.execute(created.id);

        if (triageColor && onTriageAssess) {
          try {
            await onTriageAssess(element.elementId, triageColor);
          } catch {
            /* triage assess is best-effort alongside the decision */
          }
        }

        setResult({ success: true, message: 'Decision executed — awaiting AI evaluation...' });
        onSuccess?.();
        setTimeout(onClose, 1500);
      } else {
        setResult({ success: false, message: 'Decision created but could not auto-execute.' });
      }
    } catch (err) {
      setResult({
        success: false,
        message: err instanceof Error ? err.message : 'Failed to execute decision.',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="bg-black/95 border border-robotic-yellow/40 rounded-lg max-w-3xl w-full max-h-[92vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-robotic-yellow/20">
          <div>
            <h2 className="text-sm font-semibold terminal-text text-robotic-yellow uppercase">
              {element.title}
            </h2>
            {element.subtitle && (
              <span className="text-xs terminal-text text-robotic-yellow/60 capitalize">
                {element.subtitle}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-robotic-yellow/50 hover:text-robotic-yellow text-lg leading-none"
          >
            ✕
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {/* Image */}
          {element.imageUrl && (
            <div className="w-full bg-gray-900 border-b border-robotic-yellow/20">
              <img
                src={element.imageUrl}
                alt={element.title}
                className="w-full h-48 object-cover"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            </div>
          )}

          {/* Description */}
          {element.description && (
            <div className="px-5 py-2 bg-red-900/20 border-b border-red-500/20">
              <p className="text-xs terminal-text text-red-300 leading-relaxed">
                {element.description}
              </p>
            </div>
          )}

          {/* Situation details */}
          {element.details.length > 0 && (
            <div className="px-5 py-3 border-b border-robotic-yellow/20">
              <h3 className="text-xs font-medium terminal-text text-robotic-yellow/70 mb-2 uppercase">
                Situation Details
              </h3>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                {element.details.map(({ label, value }) => (
                  <div key={label} className="text-xs terminal-text">
                    <span className="text-robotic-yellow/50 capitalize">{label}: </span>
                    <span className="text-robotic-yellow/90">{value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Status */}
          {element.status && (
            <div className="px-5 py-2 border-b border-robotic-yellow/20">
              <span className="text-xs terminal-text text-robotic-yellow/60">Status: </span>
              <span className="text-xs terminal-text text-robotic-yellow capitalize">
                {element.status.replace(/_/g, ' ')}
              </span>
            </div>
          )}

          {/* ── Triage Assessment (casualty only) ── */}
          {isCasualty && (
            <div className="px-5 py-3 border-b border-robotic-yellow/20">
              <h3 className="text-xs font-medium terminal-text text-robotic-yellow/70 mb-2 uppercase flex items-center gap-2">
                Triage Assessment
                {!triageEnabled && (
                  <span className="text-[10px] font-normal text-robotic-yellow/40 normal-case">
                    {!isTriageTeam
                      ? '— only triage personnel can assess'
                      : '— deploy a triage officer near this patient'}
                  </span>
                )}
              </h3>
              <div className="flex gap-2">
                {TRIAGE_OPTIONS.map((opt) => {
                  const isSelected = triageColor === opt.color;
                  return (
                    <button
                      key={opt.color}
                      disabled={!triageEnabled}
                      onClick={() => setTriageColor(isSelected ? null : opt.color)}
                      className={`flex-1 py-2 rounded border-2 text-xs font-bold terminal-text uppercase transition-all ${
                        !triageEnabled
                          ? 'opacity-25 cursor-not-allowed border-transparent bg-white/5 text-robotic-yellow/30'
                          : isSelected
                            ? `${opt.activeBg} ${opt.border} text-white shadow-lg`
                            : `${opt.bg} border-transparent text-robotic-yellow/70 hover:border-robotic-yellow/30`
                      }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Destination Picker (casualty + crowd) ── */}
          {(isCasualty || isCrowd) && destinations.length > 0 && (
            <div className="px-5 py-3 border-b border-robotic-yellow/20">
              <h3 className="text-xs font-medium terminal-text text-robotic-yellow/70 mb-2 uppercase">
                {isCrowd ? 'Direct Crowd To' : 'Move Patient To'}
              </h3>
              <div className="flex flex-wrap gap-2">
                {destinations.map((dest) => {
                  const isSelected = selectedDestination?.id === dest.id;
                  return (
                    <button
                      key={dest.id}
                      onClick={() => setSelectedDestination(isSelected ? null : dest)}
                      className={`px-3 py-2 rounded border text-xs terminal-text transition-all flex items-center gap-1.5 ${
                        isSelected
                          ? 'border-robotic-yellow bg-robotic-yellow/20 text-robotic-yellow shadow-lg'
                          : 'border-robotic-yellow/20 bg-robotic-yellow/5 text-robotic-yellow/70 hover:border-robotic-yellow/40 hover:bg-robotic-yellow/10'
                      }`}
                    >
                      <span
                        className="text-base inline-flex"
                        dangerouslySetInnerHTML={{ __html: dest.icon }}
                      />
                      <span className="truncate max-w-[140px]">{dest.label}</span>
                      {dest.type === 'hospital' && (
                        <span className="text-[9px] text-robotic-yellow/40 ml-0.5">HOSPITAL</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Team Actions (contextual per team) ── */}
          {teamActions.length > 0 && (
            <div className="px-5 py-3 border-b border-robotic-yellow/20">
              <h3 className="text-xs font-medium terminal-text text-robotic-yellow/70 mb-2 uppercase">
                Team Actions — {teamName}
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {teamActions.map((action) => {
                  const isSelected = selectedActions.has(action.id);
                  return (
                    <button
                      key={action.id}
                      onClick={() => toggleAction(action.id)}
                      title={action.description}
                      className={`px-2.5 py-1.5 rounded border text-xs terminal-text transition-all flex items-center gap-1.5 ${
                        isSelected
                          ? 'border-robotic-yellow bg-robotic-yellow/20 text-robotic-yellow shadow-lg'
                          : 'border-robotic-yellow/20 bg-robotic-yellow/5 text-robotic-yellow/70 hover:border-robotic-yellow/40 hover:bg-robotic-yellow/10'
                      }`}
                    >
                      <span
                        className="inline-flex"
                        dangerouslySetInnerHTML={{
                          __html: ICON_MAP[action.icon] ?? svg('pin', 14),
                        }}
                      />
                      <span className="truncate max-w-[140px]">{action.label}</span>
                    </button>
                  );
                })}
              </div>
              {selectedActions.size > 0 && (
                <div className="mt-2 text-[10px] terminal-text text-robotic-yellow/50">
                  {selectedActions.size} action{selectedActions.size !== 1 ? 's' : ''} selected
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Response section (fixed at bottom) ── */}
        <div className="px-5 py-4 shrink-0 border-t border-robotic-yellow/20 space-y-3">
          <h3 className="text-xs font-medium terminal-text text-robotic-yellow/70 uppercase">
            Deploy Resources
          </h3>

          {/* Available assets grid — taller */}
          {pointAssets.length > 0 && (
            <div>
              <div className="text-[11px] terminal-text text-robotic-yellow/50 mb-1.5">
                Drag to the deploy zone below, or click to add:
              </div>
              <div className="flex flex-wrap gap-1.5 max-h-[120px] overflow-y-auto">
                {pointAssets.map((asset) => (
                  <div
                    key={asset.asset_type}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('application/json', JSON.stringify(asset));
                      e.dataTransfer.effectAllowed = 'copy';
                    }}
                    onClick={() => addAsset(asset)}
                    className="px-2 py-1.5 rounded border border-robotic-yellow/20 bg-robotic-yellow/5 text-xs terminal-text text-robotic-yellow/80 cursor-grab active:cursor-grabbing hover:border-robotic-yellow/40 hover:bg-robotic-yellow/10 transition-colors select-none flex items-center gap-1"
                    title={`Click or drag to deploy ${asset.label}`}
                  >
                    <span
                      className="inline-flex"
                      dangerouslySetInnerHTML={{ __html: getEmoji(asset.icon) }}
                    />
                    <span className="truncate max-w-[120px]">{asset.label}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Drop zone + deployed assets */}
          <div
            ref={dropZoneRef}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`min-h-[64px] rounded border-2 border-dashed p-2 transition-colors ${
              isDragOver
                ? 'border-robotic-yellow/60 bg-robotic-yellow/10'
                : deployed.length > 0
                  ? 'border-robotic-yellow/30 bg-robotic-yellow/5'
                  : 'border-robotic-yellow/15 bg-transparent'
            }`}
          >
            {deployed.length === 0 ? (
              <div className="text-center text-[11px] terminal-text text-robotic-yellow/30 py-3">
                {isDragOver ? 'Drop here to deploy' : 'Drop resources here or click above to add'}
              </div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {deployed.map((d) => (
                  <div
                    key={d.assetType}
                    className="flex items-center gap-1 px-2 py-1 rounded bg-robotic-yellow/15 border border-robotic-yellow/30 text-xs terminal-text text-robotic-yellow"
                  >
                    <span
                      className="inline-flex"
                      dangerouslySetInnerHTML={{ __html: getEmoji(d.icon) }}
                    />
                    <span className="font-medium">{d.quantity}×</span>
                    <span className="truncate max-w-[100px]">{d.label}</span>
                    <div className="flex items-center gap-0.5 ml-1">
                      <button
                        onClick={() =>
                          addAsset({
                            asset_type: d.assetType,
                            icon: d.icon,
                            geometry_type: 'point',
                            label: d.label,
                          })
                        }
                        className="w-4 h-4 flex items-center justify-center rounded bg-robotic-yellow/20 hover:bg-robotic-yellow/40 text-[10px] leading-none"
                      >
                        +
                      </button>
                      <button
                        onClick={() => removeAsset(d.assetType)}
                        className="w-4 h-4 flex items-center justify-center rounded bg-red-900/40 hover:bg-red-900/60 text-red-400 text-[10px] leading-none"
                      >
                        −
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Tactical description */}
          <div className="relative">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe your approach, tactics, or instructions..."
              className="w-full h-20 px-3 py-2 pr-10 bg-black/50 border border-robotic-yellow/30 rounded text-xs terminal-text text-robotic-yellow placeholder-robotic-yellow/30 focus:border-robotic-yellow/60 focus:outline-none resize-none"
            />
            <VoiceMicButton
              onTranscript={(text) => setDescription((prev) => (prev ? `${prev} ${text}` : text))}
              disabled={isSubmitting}
              className="absolute bottom-2 right-2"
            />
          </div>

          {result && (
            <div
              className={`p-2 rounded text-xs terminal-text ${
                result.success
                  ? 'bg-green-900/30 text-green-400 border border-green-500/30'
                  : 'bg-red-900/30 text-red-400 border border-red-500/30'
              }`}
            >
              {result.message}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs terminal-text text-robotic-yellow/60 border border-robotic-yellow/20 rounded hover:border-robotic-yellow/40"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={!hasContent || isSubmitting || result?.success === true}
              className="px-5 py-1.5 text-xs font-mono font-medium bg-robotic-yellow rounded hover:bg-robotic-yellow/90 disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ color: '#0f0f0f' }}
            >
              {isSubmitting ? 'Executing...' : 'Execute Response'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
};
