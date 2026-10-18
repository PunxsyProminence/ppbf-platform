// Plain words for a session script's stored codes (audit finding F-078). Pure, and safe to import
// from a client component: the plan page, the live screen and the server's template-to-script
// step all use it, so a word on screen and a word written to a block cannot drift.

const STATE_WORDS: Readonly<Record<string, string>> = {
  draft: 'Draft',
  coach_reviewed: 'Coach reviewed',
  in_use: 'In use',
  retired: 'Retired',
};

// Section names a template may run together, which a tidy alone would leave as one word.
const SECTION_WORDS: Readonly<Record<string, string>> = {
  warmup: 'Warm-up',
  cooldown: 'Cool-down',
};

/** The words for an authoring_state; an unknown one is tidied, never hidden. */
export function authoringStateWords(state: string): string {
  return STATE_WORDS[state] ?? tidy(state);
}

/** A template section ('warmup', 'skill_work') as a coach would say it. */
export function templateSectionWords(section: string): string {
  // "warmup", "warm-up", "warm_up" and "Warm Up" are one section.
  const key = section.trim().toLowerCase().replace(/[\s_-]+/g, '');
  return SECTION_WORDS[key] ?? tidy(section);
}

function tidy(code: string): string {
  const words = code.trim().replace(/_+/g, ' ').replace(/\s+/g, ' ');
  return words === '' ? words : words.charAt(0).toUpperCase() + words.slice(1);
}

/** How a block made from a template states where its facts came from. */
export const FROM_TEMPLATE = 'From the template: ';
// The wording before F-078; blocks already stored with it are read the same way.
const FROM_TEMPLATE_BEFORE = 'From workout template: ';

// A section code as the template-to-script step stored it before F-078, with or without its reps:
// "warmup", "warm-up", "skill_work - 3 reps". A coach rarely writes an explanation in that shape;
// if one does, the label stays "Explain" and only the first letter and the underscores change.
const STORED_SECTION = /^([a-z]+(?:[_-][a-z]+)*)(?: - (\d+) reps)?$/;

/**
 * The block's what_to_explain line as the screens show it. A line the template step wrote is
 * labelled as the template's, not as something to explain; a bare section code stored before
 * F-078 is shown in words; anything else is the coach's text, unchanged, under "Explain".
 */
export function explainLine(explain: string): { label: string; value: string } {
  for (const prefix of [FROM_TEMPLATE, FROM_TEMPLATE_BEFORE]) {
    if (explain.startsWith(prefix)) return { label: 'From the template', value: explain.slice(prefix.length) };
  }
  const stored = STORED_SECTION.exec(explain.trim());
  if (stored) {
    const section = templateSectionWords(stored[1]);
    return { label: 'Explain', value: stored[2] ? `${section}, ${stored[2]} reps` : section };
  }
  return { label: 'Explain', value: explain };
}

/**
 * The coach formats a plan re-renders from its blocks when it is edited (audit 2026-10-17 item 8,
 * Overwatch Q8 "A"). Never a family format: a block's title is the coach's free text, withheld from
 * families (Jason, 2026-10-12: "strip them").
 */
export const BLOCK_RENDERED_FORMATS: readonly string[] = ['cheat_sheet', 'class_plan', 'instructor_script', 'class_flow'];

/** A rendering's format as a coach would say it: 'cheat_sheet' is "Cheat sheet". */
export function renderingFormatWords(format: string): string {
  return tidy(format);
}

/** Whether a rendering follows edits to the plan's blocks, as the plan page says it. */
export function renderingOriginWords(format: string, generatedFromBlocks: boolean): string {
  if (!generatedFromBlocks) return 'Written by hand. Edits to the blocks do not change it.';
  return BLOCK_RENDERED_FORMATS.includes(format)
    ? 'Made from the blocks.'
    : 'Made from the blocks when it was written. Edits to the blocks do not change it.';
}
