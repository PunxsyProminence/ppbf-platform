// The sparring symptom FLAG (Jason 2026-10-18, "Sparring symptom flag (Rec.)"):
// a short yes/no list an athlete can tick after sparring, and again the next
// day. A FLAG ONLY: the ticks are kept as ticked, never totalled into a score,
// never given a severity from what was ticked, and nothing here says what the
// ticks mean. Any tick sends the athlete one fixed message and their coach a
// flag (Jason: recipient "A: Their coach (Rec.)").
//
// SHARED so the server validates against the same list the athlete taps, and
// matched to pilot_sparring_symptom_reports_symptoms_check in
// pilot_slice_postgres_athlete_self_report_measures_migration.sql. All labels
// and messages are PROPOSED copy.

export const SPARRING_SYMPTOMS = [
  { key: 'headache', label: 'Headache' },
  { key: 'dizzy', label: 'Dizzy or off balance' },
  { key: 'nausea', label: 'Sick to your stomach' },
  { key: 'foggy', label: 'Foggy or slow' },
  { key: 'vision', label: 'Blurry or double vision' },
  { key: 'ringing', label: 'Ringing in your ears' },
  { key: 'hard_head_shot', label: 'Took a hard shot to the head' },
] as const;

export type SparringSymptom = (typeof SPARRING_SYMPTOMS)[number]['key'];

export const SPARRING_SYMPTOM_KEYS: readonly SparringSymptom[] = SPARRING_SYMPTOMS.map((symptom) => symptom.key);

/** after_sparring: asked at check-out of a sparring session. next_day: asked on
 * the next gym day's "How I feel today". */
export const SPARRING_SYMPTOM_CONTEXTS = ['after_sparring', 'next_day'] as const;
export type SparringSymptomContext = (typeof SPARRING_SYMPTOM_CONTEXTS)[number];

export const SPARRING_SYMPTOM_QUESTION: Record<SparringSymptomContext, string> = {
  after_sparring: 'After sparring: do you have any of these right now?',
  next_day: 'You sparred last time. Do you have any of these today?',
};

export const SPARRING_SYMPTOM_NONE = 'None of these';

/** The fixed message (Jason: "tell their coach and follow the gym's rules").
 * Nothing is added to it but the gym's own protocol words, when it has some. */
export const SPARRING_SYMPTOM_MESSAGE = "Tell your coach now, and follow the gym's rules for head knocks.";
/** Who the athlete is told was sent the flag, by the gym's recipient setting. */
export function sparringSymptomSentLine(recipientRole: string): string {
  return recipientRole === 'coach' ? 'Your coach has been sent this.' : 'Gym staff have been sent this.';
}

/** The one severity every symptom escalation carries. Fixed on purpose: a
 * severity derived from what or how much was ticked would be a score. */
export const SPARRING_SYMPTOM_ESCALATION_SEVERITY = 'high' as const;

export function isSparringSymptom(value: unknown): value is SparringSymptom {
  return typeof value === 'string' && (SPARRING_SYMPTOM_KEYS as readonly string[]).includes(value);
}

export function isSparringSymptomContext(value: unknown): value is SparringSymptomContext {
  return typeof value === 'string' && (SPARRING_SYMPTOM_CONTEXTS as readonly string[]).includes(value);
}

export function sparringSymptomLabel(key: SparringSymptom): string {
  return SPARRING_SYMPTOMS.find((symptom) => symptom.key === key)?.label ?? key;
}

/** The ticks in the list's own order, each once. */
export function canonicalSymptoms(symptoms: readonly SparringSymptom[]): SparringSymptom[] {
  return SPARRING_SYMPTOM_KEYS.filter((key) => symptoms.includes(key));
}
