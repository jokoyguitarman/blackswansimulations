/**
 * Gate for the Decision 9 scene runs. `npm run test:slow` and the nightly
 * workflow set RUN_SLOW_TESTS=1. A per-PR `npm test` leaves these skipped.
 */
export const slowScene: false | string =
  !process.env.RUN_SLOW_TESTS && 'slow scene run: nightly, or npm run test:slow';
