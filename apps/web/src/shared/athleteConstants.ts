/**
 * Shared constants for athlete records.
 * Ensures consistency between server validation and client UI across all forms.
 */

export const GYM_STATUS_OPTIONS = ['active', 'training', 'inactive'] as const;

export type GymStatus = (typeof GYM_STATUS_OPTIONS)[number];
