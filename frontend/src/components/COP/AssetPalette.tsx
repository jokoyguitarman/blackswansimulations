import { useState, useCallback } from 'react';

export interface DraggableAssetDef {
  asset_type: string;
  icon: string;
  geometry_type: 'point' | 'polygon' | 'line';
  label: string;
  max_count?: number;
}

interface ActionRecordingState {
  active: boolean;
  incidentId?: string;
  incidentTitle?: string;
  actions: Array<{ placementId: string; label: string; assetType: string }>;
}

interface AssetPaletteProps {
  assets: DraggableAssetDef[];
  teamName: string;
  placedCounts: Record<string, number>;
  onAssetDragStart: (asset: DraggableAssetDef) => void;
  onStartDraw?: (asset: DraggableAssetDef) => void;
  onFinishDraw?: () => void;
  onCancelDraw?: () => void;
  drawingAssetType?: string | null;
  /** Current vertex count while drawing — enables/disables the Finish button. */
  drawVertexCount?: number;
  disabled?: boolean;
  /** Action recording state (null = not recording). */
  actionRecording?: ActionRecordingState | null;
  onSubmitActions?: (description: string) => void;
  onCancelRecording?: () => void;
  onStartRecording?: () => void;
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
};

function getAssetEmoji(icon: string): string {
  return ICON_MAP[icon] ?? '📍';
}

export const AssetPalette = ({
  assets,
  teamName,
  placedCounts,
  onAssetDragStart,
  onStartDraw,
  onFinishDraw,
  onCancelDraw,
  drawingAssetType,
  drawVertexCount = 0,
  disabled,
  actionRecording,
  onSubmitActions,
  onCancelRecording,
  onStartRecording,
}: AssetPaletteProps) => {
  const [isExpanded, setIsExpanded] = useState(true);
  const [submitDescription, setSubmitDescription] = useState('');

  const handleDragStart = useCallback(
    (e: React.DragEvent, asset: DraggableAssetDef) => {
      e.dataTransfer.setData('application/json', JSON.stringify(asset));
      e.dataTransfer.effectAllowed = 'copy';
      onAssetDragStart(asset);
    },
    [onAssetDragStart],
  );

  if (!assets.length) return null;

  const isDrawing = !!drawingAssetType;

  return (
    <div className="absolute bottom-3 left-3 z-[1000] select-none" style={{ maxWidth: '280px' }}>
      {/* Drawing-mode banner */}
      {isDrawing &&
        (() => {
          const drawingDef = assets.find((a) => a.asset_type === drawingAssetType);
          const isPolyMode = drawingDef?.geometry_type === 'polygon';
          const minPts = isPolyMode ? 3 : 2;
          const canFinish = drawVertexCount >= minPts;

          return (
            <div className="px-3 py-2 bg-amber-900/95 border border-amber-500/70 rounded-t text-xs terminal-text text-amber-300 space-y-2">
              <div className="font-medium flex items-center justify-between">
                <span>
                  Drawing — {drawVertexCount} point{drawVertexCount !== 1 ? 's' : ''}
                </span>
                {!canFinish && (
                  <span className="text-amber-300/50 font-normal">
                    need {minPts - drawVertexCount} more
                  </span>
                )}
              </div>
              <div className="text-amber-300/60 leading-relaxed">
                Click on the map to add points.{' '}
                {canFinish
                  ? 'Click the green start point or press Finish to complete.'
                  : `Place at least ${minPts} points to finish.`}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={onFinishDraw}
                  disabled={!canFinish}
                  className={`flex-1 px-2 py-1 rounded border text-xs font-medium transition-colors ${
                    canFinish
                      ? 'border-green-500/70 text-green-300 bg-green-900/50 hover:bg-green-800/60'
                      : 'border-gray-600 text-gray-500 cursor-not-allowed opacity-50'
                  }`}
                >
                  Finish
                </button>
                <button
                  onClick={onCancelDraw}
                  className="flex-1 px-2 py-1 rounded border border-red-500/50 text-red-300 bg-red-900/40 hover:bg-red-800/50 text-xs font-medium transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          );
        })()}

      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={`w-full px-3 py-1.5 bg-black/90 border border-robotic-yellow/50 text-xs terminal-text text-robotic-yellow hover:bg-black/95 transition-colors flex items-center justify-between ${
          isDrawing ? '' : 'rounded-t'
        }`}
      >
        <span className="font-medium">Assets — {teamName}</span>
        <span className="text-robotic-yellow/50">{isExpanded ? '▼' : '▶'}</span>
      </button>

      {isExpanded && (
        <div className="bg-black/90 border border-t-0 border-robotic-yellow/50 p-2 grid grid-cols-2 gap-1.5">
          {assets.map((asset) => {
            const count = placedCounts[asset.asset_type] ?? 0;
            const atMax = asset.max_count != null && count >= asset.max_count;
            const isDrawable = asset.geometry_type === 'line' || asset.geometry_type === 'polygon';
            const isActiveDrawing = drawingAssetType === asset.asset_type;
            const isDisabled = disabled || atMax || (isDrawing && !isActiveDrawing);

            if (isDrawable) {
              return (
                <button
                  key={asset.asset_type}
                  onClick={() => {
                    if (isDisabled) return;
                    if (isActiveDrawing) return;
                    onStartDraw?.(asset);
                  }}
                  disabled={isDisabled}
                  className={`
                    px-2 py-1.5 rounded border text-xs terminal-text text-left
                    transition-all duration-150
                    ${
                      isActiveDrawing
                        ? 'border-amber-500 text-amber-300 bg-amber-500/20 ring-1 ring-amber-500/50'
                        : isDisabled
                          ? 'border-gray-700 text-gray-600 cursor-not-allowed opacity-50'
                          : 'border-robotic-yellow/30 text-robotic-yellow hover:border-robotic-yellow/60 hover:bg-robotic-yellow/10 cursor-pointer'
                    }
                  `}
                  title={
                    isActiveDrawing
                      ? 'Currently drawing...'
                      : atMax
                        ? `Maximum ${asset.max_count} reached`
                        : `Click to draw ${asset.label}`
                  }
                >
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm">{getAssetEmoji(asset.icon)}</span>
                    <span className="truncate">{asset.label}</span>
                  </div>
                  <div className="flex items-center justify-between mt-0.5">
                    {asset.max_count != null && (
                      <span className="text-[10px] text-robotic-yellow/40">
                        {count}/{asset.max_count}
                      </span>
                    )}
                    <span className="text-[10px] text-robotic-yellow/50 ml-auto">
                      {isActiveDrawing ? '● drawing' : '✏ draw'}
                    </span>
                  </div>
                </button>
              );
            }

            return (
              <div
                key={asset.asset_type}
                draggable={!isDisabled}
                onDragStart={(e) => handleDragStart(e, asset)}
                className={`
                  px-2 py-1.5 rounded border text-xs terminal-text cursor-grab active:cursor-grabbing
                  transition-all duration-150
                  ${
                    isDisabled
                      ? 'border-gray-700 text-gray-600 cursor-not-allowed opacity-50'
                      : 'border-robotic-yellow/30 text-robotic-yellow hover:border-robotic-yellow/60 hover:bg-robotic-yellow/10'
                  }
                `}
                title={
                  atMax ? `Maximum ${asset.max_count} reached` : `Drag to place ${asset.label}`
                }
              >
                <div className="flex items-center gap-1.5">
                  <span className="text-sm">{getAssetEmoji(asset.icon)}</span>
                  <span className="truncate">{asset.label}</span>
                </div>
                {asset.max_count != null && (
                  <div className="text-[10px] text-robotic-yellow/40 mt-0.5">
                    {count}/{asset.max_count}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Action Recording Controls */}
      {actionRecording?.active ? (
        <div className="bg-black/95 border border-t-0 border-robotic-yellow/50 rounded-b px-3 py-2 space-y-2">
          {/* Response banner — shows which incident this responds to */}
          {actionRecording.incidentTitle && (
            <div className="px-2 py-1.5 bg-cyan-900/40 border border-cyan-500/40 rounded text-[11px] terminal-text text-cyan-300 leading-snug">
              <span className="text-cyan-400 font-medium">RESPONDING TO:</span>{' '}
              {actionRecording.incidentTitle}
            </div>
          )}

          {/* Recording indicator + action count */}
          <div className="flex items-center gap-2 text-xs terminal-text">
            <span className="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            <span className="text-red-300 font-medium">RECORDING</span>
            <span className="text-robotic-yellow/60 ml-auto">
              {actionRecording.actions.length} action
              {actionRecording.actions.length !== 1 ? 's' : ''}
            </span>
          </div>

          {/* List of recorded actions */}
          {actionRecording.actions.length > 0 && (
            <div className="space-y-0.5 max-h-20 overflow-y-auto">
              {actionRecording.actions.map((a, i) => (
                <div key={i} className="text-[10px] terminal-text text-robotic-yellow/50 truncate">
                  {i + 1}. {a.label}
                </div>
              ))}
            </div>
          )}

          {/* Optional description before submitting */}
          <textarea
            value={submitDescription}
            onChange={(e) => setSubmitDescription(e.target.value)}
            placeholder="Describe your strategy (optional)..."
            className="w-full bg-black/60 border border-robotic-yellow/30 rounded px-2 py-1 text-xs terminal-text text-robotic-yellow placeholder-robotic-yellow/30 resize-none"
            rows={2}
          />

          {/* Submit / Cancel */}
          <div className="flex gap-2">
            <button
              onClick={() => {
                onSubmitActions?.(submitDescription.trim());
                setSubmitDescription('');
              }}
              disabled={actionRecording.actions.length === 0}
              className={`flex-1 px-2 py-1.5 rounded border text-xs terminal-text font-medium transition-colors ${
                actionRecording.actions.length > 0
                  ? 'border-green-500/70 text-green-300 bg-green-900/50 hover:bg-green-800/60'
                  : 'border-gray-600 text-gray-500 cursor-not-allowed opacity-50'
              }`}
            >
              Submit Actions
            </button>
            <button
              onClick={() => {
                onCancelRecording?.();
                setSubmitDescription('');
              }}
              className="flex-1 px-2 py-1.5 rounded border border-red-500/50 text-red-300 bg-red-900/40 hover:bg-red-800/50 text-xs terminal-text font-medium transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        /* Start recording button when not currently recording */
        onStartRecording && (
          <div className="bg-black/90 border border-t-0 border-robotic-yellow/50 rounded-b px-3 py-2">
            <button
              onClick={onStartRecording}
              disabled={isDrawing}
              className={`w-full px-2 py-1.5 rounded border text-xs terminal-text font-medium transition-colors ${
                isDrawing
                  ? 'border-gray-600 text-gray-500 cursor-not-allowed opacity-50'
                  : 'border-robotic-yellow/40 text-robotic-yellow/80 hover:bg-robotic-yellow/10 hover:border-robotic-yellow/60'
              }`}
            >
              Record Actions as Decision
            </button>
          </div>
        )
      )}
    </div>
  );
};
