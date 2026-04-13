import { useState, useRef, useCallback, useEffect } from 'react';
import { EvacuationEngine } from '../lib/evacuation/engine';
import type { PedSnapshot, EvacMetrics } from '../lib/evacuation/engine';
import type { ExitDef, SimConfig } from '../lib/evacuation/types';
import { DEFAULT_CONFIG } from '../lib/evacuation/types';

type InteractionMode = 'none' | 'place_exit' | 'resize_exit' | 'delete_exit';

function speedColor(speed: number, maxSpeed: number): string {
  const ratio = Math.min(speed / maxSpeed, 1);
  if (ratio < 0.3) return '#ef4444';
  if (ratio < 0.6) return '#f59e0b';
  return '#22c55e';
}

const SCALE = 22; // px per meter
const CANVAS_PAD = 40;

function toCanvas(mx: number, my: number): { cx: number; cy: number } {
  return { cx: mx * SCALE + CANVAS_PAD, cy: my * SCALE + CANVAS_PAD };
}

function toSim(cx: number, cy: number): { mx: number; my: number } {
  return { mx: (cx - CANVAS_PAD) / SCALE, my: (cy - CANVAS_PAD) / SCALE };
}

function nearestWallPoint(
  mx: number,
  my: number,
  w: number,
  h: number,
): { x: number; y: number; side: string } {
  const candidates = [
    { x: mx, y: 0, side: 'top', dist: my },
    { x: mx, y: h, side: 'bottom', dist: Math.abs(my - h) },
    { x: 0, y: my, side: 'left', dist: mx },
    { x: w, y: my, side: 'right', dist: Math.abs(mx - w) },
  ];
  candidates.sort((a, b) => a.dist - b.dist);
  const best = candidates[0];

  if (best.side === 'top' || best.side === 'bottom') {
    best.x = Math.max(2, Math.min(w - 2, best.x));
  } else {
    best.y = Math.max(2, Math.min(h - 2, best.y));
  }

  return best;
}

let exitIdCounter = 0;

export function DebugEvacuationSim() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<EvacuationEngine | null>(null);
  const rafRef = useRef(0);

  const [config, setConfig] = useState<SimConfig>({ ...DEFAULT_CONFIG });
  const [exits, setExits] = useState<ExitDef[]>([
    { id: 'exit-default-1', center: { x: 15, y: 20 }, width: 3 },
  ]);
  const [mode, setMode] = useState<InteractionMode>('none');
  const [running, setRunning] = useState(false);
  const [metrics, setMetrics] = useState<EvacMetrics | null>(null);
  const [snapshots, setSnapshots] = useState<PedSnapshot[]>([]);
  const [selectedExitId, setSelectedExitId] = useState<string | null>(null);
  const [newExitWidth, setNewExitWidth] = useState(3);
  const [simSpeed, setSimSpeed] = useState(1);
  const [hoverInfo, setHoverInfo] = useState<string | null>(null);

  const canvasWidth = config.roomWidth * SCALE + CANVAS_PAD * 2;
  const canvasHeight = config.roomHeight * SCALE + CANVAS_PAD * 2;

  const initEngine = useCallback(() => {
    engineRef.current?.destroy();
    const eng = new EvacuationEngine(config, exits);
    engineRef.current = eng;
    setMetrics(eng.getMetrics());
    setSnapshots(eng.getSnapshots());
    setRunning(false);
  }, [config, exits]);

  useEffect(() => {
    initEngine();
    return () => {
      engineRef.current?.destroy();
      cancelAnimationFrame(rafRef.current);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    draw(ctx, snapshots, exits, config, selectedExitId, mode);
  }, [snapshots, exits, config, selectedExitId, mode]);

  const loop = useCallback(() => {
    const eng = engineRef.current;
    if (!eng) return;

    const stepsPerFrame = Math.max(1, Math.round(simSpeed));
    for (let i = 0; i < stepsPerFrame; i++) {
      eng.step();
    }

    const snaps = eng.getSnapshots();
    const met = eng.getMetrics();
    setSnapshots(snaps);
    setMetrics(met);

    if (met.remaining === 0) {
      setRunning(false);
      return;
    }

    rafRef.current = requestAnimationFrame(loop);
  }, [simSpeed]);

  useEffect(() => {
    if (running) {
      rafRef.current = requestAnimationFrame(loop);
    } else {
      cancelAnimationFrame(rafRef.current);
    }
    return () => cancelAnimationFrame(rafRef.current);
  }, [running, loop]);

  const handleCanvasClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = canvasRef.current!.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const { mx, my } = toSim(cx, cy);

      if (mode === 'place_exit') {
        const snap = nearestWallPoint(mx, my, config.roomWidth, config.roomHeight);
        const id = `exit-${++exitIdCounter}`;
        setExits((prev) => [
          ...prev,
          { id, center: { x: snap.x, y: snap.y }, width: newExitWidth },
        ]);
        setMode('none');
        return;
      }

      if (mode === 'delete_exit') {
        const hitExit = findExitAt(mx, my, exits);
        if (hitExit) {
          setExits((prev) => prev.filter((ex) => ex.id !== hitExit.id));
          if (selectedExitId === hitExit.id) setSelectedExitId(null);
        }
        setMode('none');
        return;
      }

      const hitExit = findExitAt(mx, my, exits);
      if (hitExit) {
        setSelectedExitId(hitExit.id === selectedExitId ? null : hitExit.id);
      } else {
        setSelectedExitId(null);
      }
    },
    [mode, config, exits, newExitWidth, selectedExitId],
  );

  const handleCanvasMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = canvasRef.current!.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const { mx, my } = toSim(cx, cy);

      if (mode === 'place_exit') {
        const snap = nearestWallPoint(mx, my, config.roomWidth, config.roomHeight);
        setHoverInfo(`Exit → ${snap.side} wall (${snap.x.toFixed(1)}, ${snap.y.toFixed(1)})`);
      } else {
        const hitExit = findExitAt(mx, my, exits);
        setHoverInfo(
          hitExit
            ? `Exit "${hitExit.id}" — width: ${hitExit.width.toFixed(1)}m`
            : `(${mx.toFixed(1)}, ${my.toFixed(1)})`,
        );
      }
    },
    [mode, config, exits],
  );

  const updateSelectedExitWidth = useCallback(
    (width: number) => {
      if (!selectedExitId) return;
      setExits((prev) => prev.map((ex) => (ex.id === selectedExitId ? { ...ex, width } : ex)));
    },
    [selectedExitId],
  );

  const handleReset = () => {
    cancelAnimationFrame(rafRef.current);
    initEngine();
  };

  const handleStart = () => {
    if (!engineRef.current || metrics?.remaining === 0) {
      initEngine();
      setTimeout(() => setRunning(true), 50);
    } else {
      setRunning(true);
    }
  };

  const selectedExit = exits.find((e) => e.id === selectedExitId) ?? null;

  return (
    <div className="min-h-screen bg-black text-green-400 font-mono p-4 flex flex-col">
      {/* Header */}
      <div className="border border-green-800 rounded p-3 mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg text-green-400 tracking-wider">
            [EVACUATION PARTICLE SIMULATION]
          </h1>
          <p className="text-xs text-green-700 mt-1">
            Matter.js Social-Force Hybrid — Click walls to place exits, adjust widths, run sim
          </p>
        </div>
        <a
          href="/debug/building-studs"
          className="text-xs text-green-600 hover:text-green-400 border border-green-800 rounded px-2 py-1"
        >
          ← Building Studs
        </a>
      </div>

      <div className="flex gap-4 flex-1 min-h-0">
        {/* Left panel — controls */}
        <div className="w-72 shrink-0 space-y-3 overflow-y-auto max-h-[calc(100vh-8rem)]">
          {/* Sim controls */}
          <div className="bg-gray-900 border border-green-800 rounded p-3">
            <h2 className="text-sm text-green-500 mb-2 border-b border-green-900 pb-1">
              Simulation Controls
            </h2>
            <div className="flex gap-2 mb-3">
              {!running ? (
                <button
                  onClick={handleStart}
                  className="flex-1 px-2 py-1.5 text-xs font-semibold rounded bg-green-700 hover:bg-green-600 text-black"
                >
                  ▶ START
                </button>
              ) : (
                <button
                  onClick={() => setRunning(false)}
                  className="flex-1 px-2 py-1.5 text-xs font-semibold rounded bg-amber-600 hover:bg-amber-500 text-black"
                >
                  ⏸ PAUSE
                </button>
              )}
              <button
                onClick={handleReset}
                className="flex-1 px-2 py-1.5 text-xs font-semibold rounded bg-red-800 hover:bg-red-700 text-white"
              >
                ↺ RESET
              </button>
            </div>

            <label className="block text-xs text-green-600 mb-1">Speed: {simSpeed}x</label>
            <input
              type="range"
              min={1}
              max={10}
              step={1}
              value={simSpeed}
              onChange={(e) => setSimSpeed(Number(e.target.value))}
              className="w-full accent-green-500 mb-2"
            />

            <label className="block text-xs text-green-600 mb-1">
              Pedestrians: {config.pedestrianCount}
            </label>
            <input
              type="range"
              min={10}
              max={500}
              step={10}
              value={config.pedestrianCount}
              onChange={(e) =>
                setConfig((c) => ({ ...c, pedestrianCount: Number(e.target.value) }))
              }
              className="w-full accent-green-500 mb-2"
              disabled={running}
            />

            <label className="block text-xs text-green-600 mb-1">
              Desired Speed: {config.desiredSpeed.toFixed(1)} m/s
            </label>
            <input
              type="range"
              min={0.5}
              max={3}
              step={0.1}
              value={config.desiredSpeed}
              onChange={(e) => setConfig((c) => ({ ...c, desiredSpeed: Number(e.target.value) }))}
              className="w-full accent-green-500 mb-2"
            />

            <label className="block text-xs text-green-600 mb-1">
              Panic Factor: {(config.panicFactor * 100).toFixed(0)}%
            </label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={config.panicFactor}
              onChange={(e) => setConfig((c) => ({ ...c, panicFactor: Number(e.target.value) }))}
              className="w-full accent-green-500 mb-2"
            />

            <label className="block text-xs text-green-600 mb-1">
              Room: {config.roomWidth}×{config.roomHeight}m
            </label>
            <div className="flex gap-2">
              <input
                type="number"
                min={10}
                max={80}
                value={config.roomWidth}
                onChange={(e) => setConfig((c) => ({ ...c, roomWidth: Number(e.target.value) }))}
                className="w-full bg-gray-800 border border-green-900 rounded px-2 py-1 text-xs text-green-300"
                disabled={running}
              />
              <input
                type="number"
                min={10}
                max={60}
                value={config.roomHeight}
                onChange={(e) => setConfig((c) => ({ ...c, roomHeight: Number(e.target.value) }))}
                className="w-full bg-gray-800 border border-green-900 rounded px-2 py-1 text-xs text-green-300"
                disabled={running}
              />
            </div>
          </div>

          {/* Exit placement */}
          <div className="bg-gray-900 border border-green-800 rounded p-3">
            <h2 className="text-sm text-green-500 mb-2 border-b border-green-900 pb-1">
              Exit Placement
            </h2>

            <label className="block text-xs text-green-600 mb-1">
              New Exit Width: {newExitWidth.toFixed(1)}m
            </label>
            <input
              type="range"
              min={1}
              max={8}
              step={0.5}
              value={newExitWidth}
              onChange={(e) => setNewExitWidth(Number(e.target.value))}
              className="w-full accent-green-500 mb-3"
            />

            <div className="flex gap-2 mb-2">
              <button
                onClick={() => setMode(mode === 'place_exit' ? 'none' : 'place_exit')}
                className={`flex-1 px-2 py-1.5 text-xs font-semibold rounded border ${
                  mode === 'place_exit'
                    ? 'bg-green-700 border-green-500 text-black'
                    : 'bg-gray-800 border-green-900 text-green-400 hover:border-green-600'
                }`}
              >
                + Place Exit
              </button>
              <button
                onClick={() => setMode(mode === 'delete_exit' ? 'none' : 'delete_exit')}
                className={`flex-1 px-2 py-1.5 text-xs font-semibold rounded border ${
                  mode === 'delete_exit'
                    ? 'bg-red-700 border-red-500 text-white'
                    : 'bg-gray-800 border-green-900 text-green-400 hover:border-green-600'
                }`}
              >
                ✕ Delete Exit
              </button>
            </div>

            {mode === 'place_exit' && (
              <p className="text-xs text-amber-400 animate-pulse">
                Click on any wall to place an exit...
              </p>
            )}
            {mode === 'delete_exit' && (
              <p className="text-xs text-red-400 animate-pulse">Click on an exit to remove it...</p>
            )}
          </div>

          {/* Exit list */}
          <div className="bg-gray-900 border border-green-800 rounded p-3">
            <h2 className="text-sm text-green-500 mb-2 border-b border-green-900 pb-1">
              Exits ({exits.length})
            </h2>
            {exits.length === 0 && (
              <p className="text-xs text-green-700 italic">No exits. Place at least one.</p>
            )}
            <div className="space-y-2">
              {exits.map((ex) => {
                const isSelected = ex.id === selectedExitId;
                const wallSide = getWallSide(ex, config);
                return (
                  <div
                    key={ex.id}
                    onClick={() => setSelectedExitId(isSelected ? null : ex.id)}
                    className={`p-2 rounded border cursor-pointer transition-colors ${
                      isSelected
                        ? 'border-cyan-500 bg-cyan-900/20'
                        : 'border-green-900 bg-gray-800 hover:border-green-700'
                    }`}
                  >
                    <div className="flex justify-between items-center text-xs">
                      <span className="text-green-300 font-semibold">
                        {wallSide.toUpperCase()} wall
                      </span>
                      <span className="text-green-600">{ex.width.toFixed(1)}m</span>
                    </div>
                    <div className="text-xs text-green-700 mt-0.5">
                      ({ex.center.x.toFixed(1)}, {ex.center.y.toFixed(1)})
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Selected exit edit */}
          {selectedExit && (
            <div className="bg-gray-900 border border-cyan-800 rounded p-3">
              <h2 className="text-sm text-cyan-400 mb-2 border-b border-cyan-900 pb-1">
                Edit Exit
              </h2>
              <label className="block text-xs text-cyan-600 mb-1">
                Width: {selectedExit.width.toFixed(1)}m
              </label>
              <input
                type="range"
                min={0.5}
                max={12}
                step={0.5}
                value={selectedExit.width}
                onChange={(e) => updateSelectedExitWidth(Number(e.target.value))}
                className="w-full accent-cyan-500 mb-2"
              />
              <button
                onClick={() => {
                  setExits((prev) => prev.filter((ex) => ex.id !== selectedExitId));
                  setSelectedExitId(null);
                }}
                className="w-full px-2 py-1 text-xs rounded bg-red-800 hover:bg-red-700 text-white"
              >
                Remove This Exit
              </button>
            </div>
          )}
        </div>

        {/* Center — canvas */}
        <div className="flex-1 flex flex-col items-center min-w-0">
          <div className="border border-green-800 rounded p-2 bg-gray-950 overflow-auto max-w-full">
            <canvas
              ref={canvasRef}
              width={canvasWidth}
              height={canvasHeight}
              onClick={handleCanvasClick}
              onMouseMove={handleCanvasMove}
              className={`block ${
                mode === 'place_exit'
                  ? 'cursor-crosshair'
                  : mode === 'delete_exit'
                    ? 'cursor-not-allowed'
                    : 'cursor-default'
              }`}
            />
          </div>
          {hoverInfo && <div className="text-xs text-green-700 mt-1">{hoverInfo}</div>}
        </div>

        {/* Right panel — metrics */}
        <div className="w-64 shrink-0 space-y-3 overflow-y-auto max-h-[calc(100vh-8rem)]">
          {metrics && (
            <>
              <div className="bg-gray-900 border border-green-800 rounded p-3">
                <h2 className="text-sm text-green-500 mb-2 border-b border-green-900 pb-1">
                  Live Metrics
                </h2>
                <div className="grid grid-cols-2 gap-y-1 text-xs">
                  <span className="text-green-600">Elapsed:</span>
                  <span className="text-green-300">{metrics.elapsed.toFixed(1)}s</span>

                  <span className="text-green-600">Total:</span>
                  <span className="text-green-300">{metrics.totalPedestrians}</span>

                  <span className="text-green-600">Evacuated:</span>
                  <span className="text-emerald-400">{metrics.evacuated}</span>

                  <span className="text-green-600">Remaining:</span>
                  <span className={metrics.remaining > 0 ? 'text-amber-400' : 'text-green-300'}>
                    {metrics.remaining}
                  </span>

                  <span className="text-green-600">Avg Speed:</span>
                  <span className="text-green-300">{metrics.avgSpeed.toFixed(2)} m/s</span>
                </div>

                {/* Progress bar */}
                <div className="mt-3">
                  <div className="flex justify-between text-xs text-green-600 mb-1">
                    <span>Evacuation Progress</span>
                    <span>
                      {metrics.totalPedestrians > 0
                        ? ((metrics.evacuated / metrics.totalPedestrians) * 100).toFixed(0)
                        : 0}
                      %
                    </span>
                  </div>
                  <div className="w-full h-2 bg-gray-800 rounded overflow-hidden">
                    <div
                      className="h-full bg-green-500 transition-all duration-200"
                      style={{
                        width: `${
                          metrics.totalPedestrians > 0
                            ? (metrics.evacuated / metrics.totalPedestrians) * 100
                            : 0
                        }%`,
                      }}
                    />
                  </div>
                </div>

                {metrics.remaining === 0 && metrics.evacuated > 0 && (
                  <div className="mt-3 p-2 bg-green-900/30 border border-green-700 rounded text-center">
                    <span className="text-xs text-green-400 font-semibold">
                      EVACUATION COMPLETE — {metrics.elapsed.toFixed(1)}s
                    </span>
                  </div>
                )}
              </div>

              {/* Per-exit flow */}
              <div className="bg-gray-900 border border-green-800 rounded p-3">
                <h2 className="text-sm text-green-500 mb-2 border-b border-green-900 pb-1">
                  Exit Flow
                </h2>
                {metrics.exitFlows.map((ef) => {
                  const exit = exits.find((e) => e.id === ef.exitId);
                  const wallSide = exit ? getWallSide(exit, config) : '?';
                  const pct =
                    metrics!.totalPedestrians > 0
                      ? ((ef.count / metrics!.totalPedestrians) * 100).toFixed(0)
                      : '0';
                  return (
                    <div key={ef.exitId} className="mb-2">
                      <div className="flex justify-between text-xs">
                        <span className="text-green-400">{wallSide.toUpperCase()}</span>
                        <span className="text-green-300">
                          {ef.count} ({pct}%)
                        </span>
                      </div>
                      <div className="w-full h-1.5 bg-gray-800 rounded overflow-hidden mt-0.5">
                        <div
                          className="h-full bg-cyan-500 transition-all"
                          style={{
                            width: `${
                              metrics!.totalPedestrians > 0
                                ? (ef.count / metrics!.totalPedestrians) * 100
                                : 0
                            }%`,
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Density legend */}
              <div className="bg-gray-900 border border-green-800 rounded p-3">
                <h2 className="text-sm text-green-500 mb-2 border-b border-green-900 pb-1">
                  Speed Legend
                </h2>
                <div className="space-y-1 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="inline-block w-3 h-3 rounded-full bg-green-500" />
                    <span className="text-green-400">Moving freely</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="inline-block w-3 h-3 rounded-full bg-amber-500" />
                    <span className="text-green-400">Slowing / congested</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="inline-block w-3 h-3 rounded-full bg-red-500" />
                    <span className="text-green-400">Jammed / crushed</span>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function getWallSide(exit: ExitDef, config: SimConfig): string {
  const { x, y } = exit.center;
  if (y <= 0.5) return 'top';
  if (y >= config.roomHeight - 0.5) return 'bottom';
  if (x <= 0.5) return 'left';
  if (x >= config.roomWidth - 0.5) return 'right';
  return 'interior';
}

function findExitAt(mx: number, my: number, exits: ExitDef[]): ExitDef | null {
  for (const ex of exits) {
    const dx = Math.abs(mx - ex.center.x);
    const dy = Math.abs(my - ex.center.y);
    if (dx < ex.width / 2 + 0.8 && dy < ex.width / 2 + 0.8) {
      return ex;
    }
  }
  return null;
}

function draw(
  ctx: CanvasRenderingContext2D,
  snapshots: PedSnapshot[],
  exits: ExitDef[],
  config: SimConfig,
  selectedExitId: string | null,
  mode: InteractionMode,
) {
  const { roomWidth: w, roomHeight: h, desiredSpeed, panicFactor } = config;
  const maxSpeed = desiredSpeed * (1 + panicFactor * 0.6) * 1.3;

  const cw = w * SCALE + CANVAS_PAD * 2;
  const ch = h * SCALE + CANVAS_PAD * 2;
  ctx.clearRect(0, 0, cw, ch);

  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, cw, ch);

  // Room floor
  const tl = toCanvas(0, 0);
  const br = toCanvas(w, h);
  ctx.fillStyle = '#111827';
  ctx.fillRect(tl.cx, tl.cy, br.cx - tl.cx, br.cy - tl.cy);

  // Grid lines
  ctx.strokeStyle = '#1f2937';
  ctx.lineWidth = 0.5;
  for (let x = 0; x <= w; x += 5) {
    const p = toCanvas(x, 0);
    const p2 = toCanvas(x, h);
    ctx.beginPath();
    ctx.moveTo(p.cx, p.cy);
    ctx.lineTo(p2.cx, p2.cy);
    ctx.stroke();
  }
  for (let y = 0; y <= h; y += 5) {
    const p = toCanvas(0, y);
    const p2 = toCanvas(w, y);
    ctx.beginPath();
    ctx.moveTo(p.cx, p.cy);
    ctx.lineTo(p2.cx, p2.cy);
    ctx.stroke();
  }

  // Scale labels
  ctx.fillStyle = '#374151';
  ctx.font = '9px monospace';
  ctx.textAlign = 'center';
  for (let x = 0; x <= w; x += 5) {
    const p = toCanvas(x, h);
    ctx.fillText(`${x}m`, p.cx, p.cy + 14);
  }
  ctx.textAlign = 'right';
  for (let y = 0; y <= h; y += 5) {
    const p = toCanvas(0, y);
    ctx.fillText(`${y}m`, p.cx - 6, p.cy + 3);
  }

  // Walls
  ctx.strokeStyle = '#4ade80';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(tl.cx, tl.cy);
  ctx.lineTo(br.cx, tl.cy);
  ctx.lineTo(br.cx, br.cy);
  ctx.lineTo(tl.cx, br.cy);
  ctx.closePath();
  ctx.stroke();

  // Exits (draw gaps over walls)
  for (const exit of exits) {
    const isSelected = exit.id === selectedExitId;
    const ec = toCanvas(exit.center.x, exit.center.y);
    const halfPx = (exit.width / 2) * SCALE;

    ctx.strokeStyle = '#0a0a0a';
    ctx.lineWidth = 5;

    const side = getWallSide(exit, config);
    ctx.beginPath();
    if (side === 'top' || side === 'bottom') {
      ctx.moveTo(ec.cx - halfPx, ec.cy);
      ctx.lineTo(ec.cx + halfPx, ec.cy);
    } else {
      ctx.moveTo(ec.cx, ec.cy - halfPx);
      ctx.lineTo(ec.cx, ec.cy + halfPx);
    }
    ctx.stroke();

    // Exit highlight
    ctx.strokeStyle = isSelected ? '#06b6d4' : '#22d3ee';
    ctx.lineWidth = isSelected ? 3 : 2;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    if (side === 'top' || side === 'bottom') {
      ctx.moveTo(ec.cx - halfPx, ec.cy);
      ctx.lineTo(ec.cx + halfPx, ec.cy);
    } else {
      ctx.moveTo(ec.cx, ec.cy - halfPx);
      ctx.lineTo(ec.cx, ec.cy + halfPx);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Exit arrow
    ctx.fillStyle = isSelected ? '#06b6d4' : '#22d3ee';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    const arrowOffset = 12;
    if (side === 'top') {
      ctx.fillText('EXIT ↑', ec.cx, ec.cy - arrowOffset);
    } else if (side === 'bottom') {
      ctx.fillText('EXIT ↓', ec.cx, ec.cy + arrowOffset + 8);
    } else if (side === 'left') {
      ctx.fillText('← EXIT', ec.cx - arrowOffset - 16, ec.cy + 3);
    } else if (side === 'right') {
      ctx.fillText('EXIT →', ec.cx + arrowOffset + 16, ec.cy + 3);
    }
  }

  // Pedestrians
  const r = config.pedestrianRadius * SCALE;
  for (const ped of snapshots) {
    if (ped.evacuated) continue;
    const p = toCanvas(ped.x, ped.y);
    const color = speedColor(ped.speed, maxSpeed);

    ctx.beginPath();
    ctx.arc(p.cx, p.cy, Math.max(r, 2.5), 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Mode indicator
  if (mode !== 'none') {
    ctx.fillStyle = mode === 'place_exit' ? 'rgba(34, 211, 238, 0.15)' : 'rgba(239, 68, 68, 0.1)';
    ctx.fillRect(tl.cx, tl.cy, br.cx - tl.cx, br.cy - tl.cy);
  }
}
