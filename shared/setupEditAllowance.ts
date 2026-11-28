/** Newest setup-edit rows read for one scenario's history. */
export const SETUP_EDIT_HISTORY_LIMIT = 50;

/**
 * How many per-scenario history reads run at once. Each read asks for at most
 * {@link SETUP_EDIT_HISTORY_LIMIT} rows, under PostgREST's default 1000-row cap.
 */
export const SETUP_EDIT_HISTORY_READ_BATCH = 8;

/** Scenario ids accepted by one library allowance read. */
export const SETUP_EDIT_ALLOWANCE_IDS_MAX = 100;
