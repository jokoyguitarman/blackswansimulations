import { useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { DraggableAssetDef } from './AssetPalette';
import { api } from '../../lib/api';
import { VoiceMicButton } from '../VoiceMicButton';

export interface MapElementTarget {
  elementType: 'hazard' | 'casualty' | 'crowd' | 'entry_exit';
  elementId: string;
  title: string;
  subtitle?: string;
  description?: string;
  imageUrl?: string | null;
  status?: string;
  details: Array<{ label: string; value: string }>;
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
}

const ICON_MAP: Record<string, string> = {
  barrier: '🚧',
  person: '🧑',
  tent: '⛺',
  medical: '⚕️',
  ambulance: '🚑',
  hazmat: '☢️',
  camera: '📷',
  podium: '🎤',
  flag: '🚩',
  command: '🎯',
  fire_truck: '🚒',
  helicopter: '🚁',
  shield: '🛡️',
  search: '🔍',
  radio: '📻',
  water: '💧',
  area: '⬡',
  stretcher: '🛏️',
  splint: '🦴',
  syringe: '💉',
  bandage: '🩹',
  heart: '💓',
  oxygen: '💨',
  wrench: '🔧',
  extinguisher: '🧯',
  clipboard: '📋',
  mask: '😷',
};

function getEmoji(icon: string): string {
  return ICON_MAP[icon] ?? '📍';
}

const ELEMENT_TYPE_LABELS: Record<string, string> = {
  hazard: 'Hazard',
  casualty: 'Casualty',
  crowd: 'Crowd',
  entry_exit: 'Location',
};

export const MapElementResponsePanel = ({
  element,
  availableAssets,
  sessionId,
  teamName,
  onClose,
  onSuccess,
}: MapElementResponsePanelProps) => {
  const [deployed, setDeployed] = useState<DeployedAsset[]>([]);
  const [description, setDescription] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const dropZoneRef = useRef<HTMLDivElement>(null);

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

  const handleSubmit = async () => {
    if (deployed.length === 0 && !description.trim()) return;
    setIsSubmitting(true);
    setResult(null);

    const parts: string[] = [];
    if (deployed.length > 0) {
      const resourceList = deployed.map((d) => `${d.quantity}x ${d.label}`).join(', ');
      parts.push(`Resources deployed: ${resourceList}`);
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
      <div className="bg-black/95 border border-robotic-yellow/40 rounded-lg max-w-xl w-full max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-robotic-yellow/20">
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

        {/* Scrollable info section */}
        <div className="flex-1 overflow-y-auto min-h-0">
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

          {element.description && (
            <div className="px-4 py-2 bg-red-900/20 border-b border-red-500/20">
              <p className="text-xs terminal-text text-red-300 leading-relaxed">
                {element.description}
              </p>
            </div>
          )}

          {element.details.length > 0 && (
            <div className="px-4 py-3 border-b border-robotic-yellow/20">
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

          {element.status && (
            <div className="px-4 py-2 border-b border-robotic-yellow/20">
              <span className="text-xs terminal-text text-robotic-yellow/60">Status: </span>
              <span className="text-xs terminal-text text-robotic-yellow capitalize">
                {element.status.replace(/_/g, ' ')}
              </span>
            </div>
          )}
        </div>

        {/* Response section — fixed at bottom */}
        <div className="px-4 py-3 shrink-0 border-t border-robotic-yellow/20 space-y-3">
          <h3 className="text-xs font-medium terminal-text text-robotic-yellow/70 uppercase">
            Deploy Resources
          </h3>

          {/* Available assets grid */}
          {pointAssets.length > 0 && (
            <div>
              <div className="text-[11px] terminal-text text-robotic-yellow/50 mb-1.5">
                Drag to the deploy zone below, or click to add:
              </div>
              <div className="flex flex-wrap gap-1.5 max-h-[72px] overflow-y-auto">
                {pointAssets.map((asset) => (
                  <div
                    key={asset.asset_type}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('application/json', JSON.stringify(asset));
                      e.dataTransfer.effectAllowed = 'copy';
                    }}
                    onClick={() => addAsset(asset)}
                    className="px-2 py-1 rounded border border-robotic-yellow/20 bg-robotic-yellow/5 text-xs terminal-text text-robotic-yellow/80 cursor-grab active:cursor-grabbing hover:border-robotic-yellow/40 hover:bg-robotic-yellow/10 transition-colors select-none flex items-center gap-1"
                    title={`Click or drag to deploy ${asset.label}`}
                  >
                    <span>{getEmoji(asset.icon)}</span>
                    <span className="truncate max-w-[100px]">{asset.label}</span>
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
            className={`min-h-[56px] rounded border-2 border-dashed p-2 transition-colors ${
              isDragOver
                ? 'border-robotic-yellow/60 bg-robotic-yellow/10'
                : deployed.length > 0
                  ? 'border-robotic-yellow/30 bg-robotic-yellow/5'
                  : 'border-robotic-yellow/15 bg-transparent'
            }`}
          >
            {deployed.length === 0 ? (
              <div className="text-center text-[11px] terminal-text text-robotic-yellow/30 py-2">
                {isDragOver ? 'Drop here to deploy' : 'Drop resources here or click above to add'}
              </div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {deployed.map((d) => (
                  <div
                    key={d.assetType}
                    className="flex items-center gap-1 px-2 py-1 rounded bg-robotic-yellow/15 border border-robotic-yellow/30 text-xs terminal-text text-robotic-yellow"
                  >
                    <span>{getEmoji(d.icon)}</span>
                    <span className="font-medium">{d.quantity}×</span>
                    <span className="truncate max-w-[80px]">{d.label}</span>
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
              disabled={
                (deployed.length === 0 && !description.trim()) ||
                isSubmitting ||
                result?.success === true
              }
              className="px-4 py-1.5 text-xs font-mono font-medium bg-robotic-yellow rounded hover:bg-robotic-yellow/90 disabled:opacity-40 disabled:cursor-not-allowed"
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
