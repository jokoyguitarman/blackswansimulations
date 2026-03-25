import { useState, useCallback } from 'react';

export interface DraggableAssetDef {
  asset_type: string;
  icon: string;
  geometry_type: 'point' | 'polygon' | 'line';
  label: string;
  max_count?: number;
}

interface AssetPaletteProps {
  assets: DraggableAssetDef[];
  teamName: string;
  placedCounts: Record<string, number>;
  onAssetDragStart: (asset: DraggableAssetDef) => void;
  onStartDraw?: (asset: DraggableAssetDef) => void;
  drawingAssetType?: string | null;
  disabled?: boolean;
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
  drawingAssetType,
  disabled,
}: AssetPaletteProps) => {
  const [isExpanded, setIsExpanded] = useState(true);

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
      {isDrawing && (
        <div className="px-3 py-2 bg-amber-900/95 border border-amber-500/70 rounded-t text-xs terminal-text text-amber-300 space-y-1">
          <div className="font-medium">Drawing mode</div>
          <div className="text-amber-300/70 leading-relaxed">
            Click the map to place vertices. Double-click or press Enter to finish. Backspace
            removes the last point. Escape or right-click to cancel.
          </div>
        </div>
      )}

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
        <div className="bg-black/90 border border-t-0 border-robotic-yellow/50 rounded-b p-2 grid grid-cols-2 gap-1.5">
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
    </div>
  );
};
