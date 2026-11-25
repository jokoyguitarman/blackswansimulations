// Preloaded by `npm run test:slow` after scripts/test-env.ts. Turns on the scene tests that
// skip themselves unless RUN_SLOW_TESTS is set; they take minutes each, so they run nightly.
process.env.RUN_SLOW_TESTS = '1';
