import { env } from '../../env.js';
import { BuildService } from './buildService.js';
import { SupabaseBuildStore } from './buildStore.js';
import { instanceId } from './instance.js';
import { createStageRunners } from './stageRunners.js';

/** The process-wide build worker. Routes and shutdown share this instance. */
export const warroomBuildService = new BuildService({
  store: new SupabaseBuildStore(),
  runners: createStageRunners(),
  pool: env.warroomBuildPool,
  instanceId,
  maxConcurrent: env.warroomBuildMaxConcurrent,
  maxActivePerUser: env.warroomBuildMaxActivePerUser,
  leaseSeconds: env.warroomBuildLeaseSeconds,
  unwatchedPauseMin: env.warroomBuildUnwatchedPauseMin,
  maxInterruptions: env.warroomBuildMaxInterruptions,
  retentionDays: env.warroomBuildRetentionDays,
});

/**
 * Start loops after listen. Renewal runs whenever durable builds are on, including
 * when this process is not the claim worker, so a build started here keeps its lease.
 * Claiming and sweeping stay on the worker only.
 */
export function startWarroomBuildLoops(): void {
  if (!env.warroomDurableBuilds) return;
  warroomBuildService.startLeaseRenewal();
  if (!env.warroomBuildWorker) return;
  warroomBuildService.startClaimLoop(env.warroomBuildPollMs);
  warroomBuildService.startSweepLoop();
}
