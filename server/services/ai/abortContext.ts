/**
 * Caller abort for in-flight AI work (durable scenario builds, §7.1).
 * Chat and image generation read the signal from this async context, so
 * pipeline signatures stay the same and Promise.all keeps the signal.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage<{ signal: AbortSignal }>();

export function runWithAbortSignal<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  return als.run({ signal }, fn);
}

export function currentAbortSignal(): AbortSignal | undefined {
  return als.getStore()?.signal;
}

export class AbortedByCaller extends Error {
  name = 'AbortedByCaller';
}
