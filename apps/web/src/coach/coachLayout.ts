/**
 * WHICH LAYOUT THE COACH IS LOOKING AT.
 *
 * The coach board renders the same facts two ways. BOARD is one hand-built
 * panel carrying every instrument. ROOM is the same facts as separate gym
 * objects -- a wall clock, a peg board with hanging tags, clipboards on nails.
 * Neither computes anything: both read the glance model, which is the whole
 * point of it existing.
 *
 * WHY THE KEY IS SCOPED PER ACCOUNT.
 *
 * A gym tablet is not one person's device. With a plain global key, Coach A
 * picks ROOM, signs out, and Coach B arrives inside somebody else's choice. So
 * the preference is keyed by the authenticated account, which CoachWorkspace
 * already holds: it reads `account_id` from POST /api/pilot/auth/session and
 * keeps it in `coachAccountId`.
 *
 * THE GAP THAT LEAVES, stated rather than hidden. That read is asynchronous, so
 * for the first moments after mount the account id is the empty string and this
 * falls back to the anonymous key. A coach therefore sees BOARD briefly before
 * their remembered choice arrives. That is a preference applied late, not a
 * wrong answer shown, and it settles the moment the session read returns.
 * Writing under the anonymous key is avoided by the caller, which does not
 * persist a choice until it knows who is choosing.
 *
 * If cross-device memory ever matters, this becomes a real stored user
 * preference on the server and the local key goes away.
 *
 * STORAGE IS BEST-EFFORT, matching the house pattern in milestoneCeremony.ts:
 * localStorage throws in private mode and in some embedded webviews, and a
 * tablet that cannot store anything must still render a board. Every read and
 * write is guarded, and a failure means the coach sees the default -- never a
 * blank screen and never a thrown error.
 */

export type CoachLayoutId = 'board' | 'room';

/**
 * BOARD is the default on a tablet: one recognizable control station with a
 * predictable scan path, which is the less demanding thing to read while
 * actually coaching. ROOM is one tap away.
 */
export const DEFAULT_COACH_LAYOUT: CoachLayoutId = 'board';

const STORAGE_PREFIX = 'ppbf:coach-layout:v1';

/** Versioned on purpose. If the layouts are ever renamed or a third is added,
 *  the prefix changes and every stored value from the old world is ignored
 *  rather than silently reinterpreted as something it never meant.
 *
 *  An empty account id becomes `anon` rather than an empty segment, so the
 *  not-yet-known case is a visibly distinct key instead of one that looks like
 *  a real account whose id happens to be nothing. */
export function coachLayoutStorageKey(accountId: string): string {
  const id = accountId.trim();
  return `${STORAGE_PREFIX}:${id === '' ? 'anon' : id}`;
}

export function isCoachLayoutId(value: unknown): value is CoachLayoutId {
  return value === 'board' || value === 'room';
}

/**
 * The stored preference, or the default.
 *
 * A stored value that is not one of the two known layouts is discarded rather
 * than trusted. That is not paranoia about our own writes: the key is a string
 * in a shared browser store, an older build may have written something else
 * under a similar name, and a layout id read straight into a renderer decides
 * which component mounts.
 */
export function readCoachLayout(accountId: string): CoachLayoutId {
  try {
    const raw = globalThis.localStorage?.getItem(coachLayoutStorageKey(accountId));
    return isCoachLayoutId(raw) ? raw : DEFAULT_COACH_LAYOUT;
  } catch {
    return DEFAULT_COACH_LAYOUT;
  }
}

/**
 * Remember the choice, and never let failing to remember it break anything.
 *
 * Returns whether the write actually landed, so a caller that wants to tell the
 * coach "this tablet will not remember" can. Nothing does that yet; the return
 * exists so the answer is available rather than swallowed.
 */
export function writeCoachLayout(accountId: string, layout: CoachLayoutId): boolean {
  /* Never persist a choice under the anonymous key. Doing so would write one
     coach's preference into the slot every not-yet-identified session reads
     from, which is the shared-tablet bleed this file exists to prevent, wearing
     a different hat. The choice still APPLIES for this render; it is only the
     remembering that waits until we know whose it is. */
  if (accountId.trim() === '') return false;
  try {
    globalThis.localStorage?.setItem(coachLayoutStorageKey(accountId), layout);
    return true;
  } catch {
    return false;
  }
}

/** The other one. A toggle with two positions does not need a menu. */
export function otherCoachLayout(layout: CoachLayoutId): CoachLayoutId {
  return layout === 'board' ? 'room' : 'board';
}
