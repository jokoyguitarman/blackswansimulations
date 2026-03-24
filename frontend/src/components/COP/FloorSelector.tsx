export interface FloorPlan {
  id: string;
  floor_level: string;
  floor_label: string;
  plan_svg: string | null;
  plan_image_url: string | null;
  bounds: Record<string, unknown> | null;
  features: Array<{
    id: string;
    type: string;
    label: string;
    geometry?: Record<string, unknown>;
    properties?: Record<string, unknown>;
  }>;
  environmental_factors: Array<Record<string, unknown>>;
}

interface FloorSelectorProps {
  floors: FloorPlan[];
  activeFloor: string;
  onFloorChange: (level: string) => void;
  hazardFloors?: Set<string>;
}

function getFloorOrder(level: string): number {
  if (level.startsWith('B')) {
    const n = parseInt(level.slice(1)) || 1;
    return -n;
  }
  if (level === 'G') return 0;
  if (level.startsWith('L')) return parseInt(level.slice(1)) || 1;
  return parseInt(level) || 0;
}

export const FloorSelector = ({
  floors,
  activeFloor,
  onFloorChange,
  hazardFloors,
}: FloorSelectorProps) => {
  if (floors.length <= 1) return null;

  const sorted = [...floors].sort(
    (a, b) => getFloorOrder(b.floor_level) - getFloorOrder(a.floor_level),
  );

  return (
    <div className="absolute right-3 top-1/2 -translate-y-1/2 z-[1000] flex flex-col gap-1">
      {sorted.map((floor) => {
        const isActive = floor.floor_level === activeFloor;
        const hasHazard = hazardFloors?.has(floor.floor_level);

        return (
          <button
            key={floor.floor_level}
            onClick={() => onFloorChange(floor.floor_level)}
            className={`
              relative w-10 h-10 rounded border text-xs terminal-text font-medium
              transition-all duration-150
              ${
                isActive
                  ? 'bg-robotic-yellow text-black border-robotic-yellow'
                  : 'bg-black/85 text-robotic-yellow border-robotic-yellow/40 hover:border-robotic-yellow/70 hover:bg-black/95'
              }
            `}
            title={floor.floor_label}
          >
            {floor.floor_level}
            {hasHazard && !isActive && (
              <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-red-500 rounded-full border border-black animate-pulse" />
            )}
          </button>
        );
      })}
    </div>
  );
};
