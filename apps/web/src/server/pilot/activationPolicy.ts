// Split out from activation.ts so client components (e.g. the activation-codes
// admin console) can import these constants without pulling in db.ts's `pg`
// dependency, which is not browser-safe.
export const DEFAULT_ACTIVATION_TTL_HOURS = 14 * 24;
export const MAX_ACTIVATION_TTL_HOURS = 90 * 24;
