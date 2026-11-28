/** A read-only page profile or page inbox renders no composer and no action. */
export function showComposer(readOnly: boolean | undefined): boolean {
  return readOnly !== true;
}
