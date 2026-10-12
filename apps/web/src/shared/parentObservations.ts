/* What a guardian records about their child at home (WO-PH-04), as the
   parent observations route stores it and the parent hub draws it. Pure and
   client-safe: the categories, and the one text grammar the route writes into
   pilot.coach_observations.note_text and reads back. The table has no rating
   or category column; the words are the record, and a coach reads them as
   written. */

export const OBSERVATION_CATEGORIES = {
  energy: 'Energy',
  motivation: 'Motivation',
  sleep_recovery: 'Sleep & recovery',
  general_development: 'General development',
} as const;

export type ObservationCategory = keyof typeof OBSERVATION_CATEGORIES;

const LABEL_TO_CATEGORY = new Map<string, ObservationCategory>(
  (Object.entries(OBSERVATION_CATEGORIES) as Array<[ObservationCategory, string]>).map(([key, label]) => [label, key]),
);

export interface ParentObservationItem {
  note_id: string;
  category: ObservationCategory;
  rating: number | null;
  notes: string;
  created_at: string;
}

export function isObservationCategory(value: unknown): value is ObservationCategory {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(OBSERVATION_CATEGORIES, value);
}

/** The note text a coach reads. The one grammar parseObservationText reads back. */
export function composeObservationText(category: ObservationCategory, rating: number | null, notes: string): string {
  const head = rating === null
    ? OBSERVATION_CATEGORIES[category]
    : `${OBSERVATION_CATEGORIES[category]} · ${rating} out of 10`;
  return `${head}\n\n${notes}`;
}

export function parseObservationText(text: string): Pick<ParentObservationItem, 'category' | 'rating' | 'notes'> {
  const split = text.indexOf('\n\n');
  if (split > 0) {
    const head = text.slice(0, split);
    const notes = text.slice(split + 2);
    const match = /^(.+?)(?: · (10|[1-9]) out of 10)?$/.exec(head);
    const category = match ? LABEL_TO_CATEGORY.get(match[1]) : undefined;
    if (match && category) {
      return { category, rating: match[2] ? Number(match[2]) : null, notes };
    }
  }
  return { category: 'general_development', rating: null, notes: text };
}
