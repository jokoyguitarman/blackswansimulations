/** Whether the scenario editor shows the Peace period card. 404 is the flag off. */
export function peaceCardVisible(status: number | null): boolean {
  return status != null && status !== 404;
}
