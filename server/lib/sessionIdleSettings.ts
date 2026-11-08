import { readIntSetting } from './fieldOps/jobSettings.js';

/** The three idle-session settings, read once at boot (01-prerequisites.md section 6.15). */
export function readSessionIdleSettings(source: Record<string, string | undefined>): {
  idleEndMinutes: number;
  idleWarnMinutes: number;
  maxHours: number;
} {
  return {
    idleEndMinutes: readIntSetting(source.SESSION_IDLE_END_MINUTES, {
      fallback: 30,
      min: 0,
      max: 1_440,
    }),
    idleWarnMinutes: readIntSetting(source.SESSION_IDLE_WARN_MINUTES, {
      fallback: 5,
      min: 0,
      max: 60,
    }),
    maxHours: readIntSetting(source.SESSION_MAX_HOURS, {
      fallback: 12,
      min: 0,
      max: 72,
    }),
  };
}
