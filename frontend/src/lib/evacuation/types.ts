export interface Vec2 {
  x: number;
  y: number;
}

export interface ExitDef {
  id: string;
  center: Vec2;
  width: number; // meters
}

export interface SimConfig {
  roomWidth: number; // meters
  roomHeight: number; // meters
  pedestrianCount: number;
  pedestrianRadius: number; // meters
  desiredSpeed: number; // m/s
  panicFactor: number; // 0–1, increases speed & reduces order
  dt: number; // physics timestep (seconds)
}

export const DEFAULT_CONFIG: SimConfig = {
  roomWidth: 30,
  roomHeight: 20,
  pedestrianCount: 120,
  pedestrianRadius: 0.25,
  desiredSpeed: 1.4,
  panicFactor: 0,
  dt: 1 / 60,
};
