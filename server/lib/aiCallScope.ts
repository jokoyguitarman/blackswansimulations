import { AsyncLocalStorage } from 'node:async_hooks';

const scope = new AsyncLocalStorage<{ count: number }>();

/** Count one provider chat invocation while a stage scope is active. */
export function noteAiCall(): void {
  const box = scope.getStore();
  if (box) box.count += 1;
}

export async function withAiCallCount<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; calls: number }> {
  const box = { count: 0 };
  const result = await scope.run(box, fn);
  return { result, calls: box.count };
}
