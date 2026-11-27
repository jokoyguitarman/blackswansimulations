import os from 'node:os';

/** This process, for lease ownership. Render sets RENDER_INSTANCE_ID. */
export const instanceId =
  process.env.RENDER_INSTANCE_ID ?? `${os.hostname()}:${process.pid}`;
