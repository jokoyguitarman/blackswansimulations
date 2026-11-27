/**
 * Which cancellation gate a conditional inject uses. Social sessions follow the
 * timed-inject branch: the social gate, or none in a booth world and when
 * SOCIAL_INJECT_CANCEL_GATE is off. The war-room gate is never used for them.
 */

export type CancellationGate = 'none' | 'social' | 'warroom';

export function cancellationGateFor(input: {
  simMode: string | null | undefined;
  boothWorld: boolean;
  socialInjectCancelGate: boolean;
  stakeholderPublishAsIs: boolean;
}): CancellationGate {
  if (input.stakeholderPublishAsIs) return 'none';
  if (input.simMode === 'social_media') {
    if (input.boothWorld || !input.socialInjectCancelGate) return 'none';
    return 'social';
  }
  if (input.boothWorld) return 'none';
  return 'warroom';
}

/** Adversary-adaptation field_update injects are a war-room behaviour. */
export function adversaryAdaptationAllowed(simMode: string | null | undefined): boolean {
  return simMode !== 'social_media';
}
