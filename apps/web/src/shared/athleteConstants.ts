/**
 * Shared constants for athlete records.
 *
 * pilot.athletes.gym_status is plain `text` with no database constraint, so the
 * vocabulary is held together by this list alone: the seed importer documents
 * these values, the gate scripts write them, the roster forms offer them, and
 * the coach workspace displays gym_status verbatim as an athlete's track. The
 * server validator rejects anything outside GYM_STATUS_OPTIONS, so a second
 * copy of this list drifting out of sync would lock an operator out of saving.
 */

export const GYM_STATUS_OPTIONS = ['active', 'training', 'inactive'] as const;

export type GymStatus = (typeof GYM_STATUS_OPTIONS)[number];

/**
 * The same vocabulary with operator-facing copy. Kept beside the allow-list so
 * a value can never be offered in a picker that the server would then refuse.
 */
export const GYM_STATUS_CHOICES: ReadonlyArray<{ value: GymStatus; label: string }> = [
  { value: 'active', label: 'Active — training and competing' },
  { value: 'training', label: 'Training — in the gym, not competing yet' },
  { value: 'inactive', label: 'Inactive — on the roster but not attending' },
];

export function isGymStatus(value: unknown): value is GymStatus {
  return typeof value === 'string' && (GYM_STATUS_OPTIONS as readonly string[]).includes(value);
}
