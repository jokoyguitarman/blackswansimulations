import React, { createContext, useContext, type ReactNode } from 'react';

const SurfaceReadOnlyContext = createContext(false);

/** The view-as shell sets this. Player shells and the trainer console leave it false. */
export function SurfaceReadOnlyProvider({
  readOnly,
  children,
}: {
  readOnly: boolean;
  children: ReactNode;
}) {
  return React.createElement(SurfaceReadOnlyContext.Provider, { value: readOnly }, children);
}

export function useSurfaceReadOnly(): boolean {
  return useContext(SurfaceReadOnlyContext);
}

/**
 * An explicit `readOnly` prop or the view-as shell. A passed `false` does not
 * turn composing back on inside that shell.
 */
export function useSurfaceIsReadOnly(prop?: boolean): boolean {
  return prop === true || useSurfaceReadOnly();
}

/** No extra element when the surface is writable, so player markup stays as it is. */
export function WhenWritable({ children }: { children: ReactNode }) {
  if (useSurfaceReadOnly()) return null;
  return children;
}
