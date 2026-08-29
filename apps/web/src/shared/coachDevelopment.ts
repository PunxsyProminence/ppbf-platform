/**
 * The words the coach-development feature uses, in one place.
 *
 * THIS EXISTS BECAUSE THE SAME VOCABULARY WAS WRITTEN DOWN THREE TIMES: the
 * status union, the goal and activity shapes, and the topic list were each
 * declared separately in src/server/pilot/coachDevelopment.ts, in
 * app/coach/development/page.tsx and in components/CoachWorkspace.tsx. Three
 * copies of a union do not disagree loudly. They disagree silently: a fifth
 * status added server-side compiles clean on both client surfaces and renders
 * as a crash or a blank badge only once a coach has one, which is exactly the
 * failure the guarded lookups downstream had to be written to survive.
 *
 * IT CARRIES NO DATABASE ACCESS AND NO DESIGN SYSTEM. The server module owns
 * the SQL; the two client surfaces own their own badge palettes, because they
 * are different palettes -- the standalone page paints CSS classes and the hub
 * paints design-system tones. What they share is the vocabulary itself: which
 * states exist, what each one is called in English, and what a row looks like.
 *
 * NOTHING HERE MEASURES ANYTHING. There is no progress figure, no score and no
 * completion ratio in these shapes, and their absence is deliberate and
 * documented at both ends -- see the header of src/server/pilot/coachDevelopment.ts.
 */

/** Every state a coach's own development goal can be in. */
export const COACH_DEVELOPMENT_GOAL_STATUSES = ['draft', 'active', 'completed', 'cancelled'] as const;

export type CoachDevelopmentGoalStatus = (typeof COACH_DEVELOPMENT_GOAL_STATUSES)[number];

/**
 * What each state is CALLED. Shared because a coach who sees "Working on it"
 * in the hub and "Active" on their development page would reasonably think
 * they were looking at two different things.
 *
 * The tone or CSS class each surface paints around these words is NOT shared:
 * see the note above.
 */
export const COACH_DEVELOPMENT_GOAL_STATUS_LABEL: Record<CoachDevelopmentGoalStatus, string> = {
  draft: 'Draft',
  active: 'Working on it',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

/**
 * The label for a status, INCLUDING one this build does not know.
 *
 * A status that arrives from a newer server is shown as itself rather than as
 * a guess or as nothing: the surface says the word it was given, which is the
 * honest rendering of a value it cannot interpret. It never reports an
 * unreadable state as 'Draft', and never as no state at all.
 */
export function coachDevelopmentGoalStatusLabel(status: string): string {
  return (
    COACH_DEVELOPMENT_GOAL_STATUS_LABEL[status as CoachDevelopmentGoalStatus]
    ?? (status || 'Unknown')
  );
}

/**
 * A goal as the table stores it and the API returns it.
 *
 * Snake_case on purpose: these are column names, and renaming them on the way
 * out would mean two vocabularies for one row. Client surfaces that show a
 * subset take a `Pick` of this rather than redeclaring the fields, so a column
 * renamed server-side breaks the build instead of the page.
 */
export interface CoachDevelopmentGoalRow {
  organization_id: string;
  goal_id: string;
  coach_account_id: string;
  title: string;
  development_focus: string;
  /** Null is the ordinary case: plenty of real development has no deadline. */
  target_on: string | null;
  status: CoachDevelopmentGoalStatus;
  created_at: string;
  updated_at: string;
}

/** Development work a coach recorded doing. SELF-ENTERED AND UNVERIFIED. */
export interface CoachDevelopmentActivityRow {
  organization_id: string;
  activity_id: string;
  coach_account_id: string;
  /** The goal this served, or null -- which is the ordinary case. */
  goal_id: string | null;
  title: string;
  /** Empty means nobody recorded a provider. Never a provider named ''. */
  provider: string;
  occurred_on: string;
  /** Minutes for this one activity, or null. NOTHING SUMS THIS. */
  duration_minutes: number | null;
  notes: string;
  created_at: string;
  updated_at: string;
}

/**
 * The reference list the Coach Development tab has carried since it was built.
 * It is a PROMPT, not a curriculum and not a vocabulary: clicking one fills the
 * title box in, and a coach can type anything else instead. Making these a
 * database vocabulary would make this platform the author of a coaching
 * syllabus it does not possess -- the same refusal the athlete development
 * block makes about periodization taxonomies.
 *
 * Shared because the hub used to recite the same five topics as hand-typed
 * prose. Two copies of a list that is explicitly "not a syllabus" is how one
 * of them quietly becomes the authoritative one.
 */
export const COACH_DEVELOPMENT_TOPIC_PROMPTS = [
  'Boxing Technique Instruction',
  'Youth Development Psychology',
  'Injury Prevention Basics',
  'Class Management Skills',
  'Adaptive Coaching',
] as const;
