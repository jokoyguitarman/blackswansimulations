/** The owning runner was asked to stop. The build row is cancelled. */
export class CancelledError extends Error {
  override name = 'CancelledError';
}

/** The lease token no longer matches. Write nothing more. */
export class LeaseLostError extends Error {
  override name = 'LeaseLostError';
}

/** SIGTERM. shutdown() releases the row; the runner must not write. */
export class ShutdownError extends Error {
  override name = 'ShutdownError';
}

export class BuildServiceError extends Error {
  override name = 'BuildServiceError';
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}
