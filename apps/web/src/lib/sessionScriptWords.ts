// Plain words for a session script's stored codes (audit finding F-078). Pure, and safe to import
// from a client component: the plan page, the live screen and the server's template-to-script
// step all use it, so a word on screen and a word written to a block cannot drift.

import { listItems, NOT_WRITTEN_YET } from '@/src/lib/drillPresentation';
import type { SessionScriptRenderingFormat } from '@/src/server/pilot/sessionScripts';

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
 * The linked drill's text, as a coach screen holds it while a plan line falls back to it (lane
 * U2-6e). `drafts` is per field: true = still an AI draft, null = draft status not checked.
 */
export type LinkedDrillText =
  | { readonly state: 'loading' }
  | { readonly state: 'failed' }
  | {
      readonly state: 'loaded';
      readonly cues: readonly string[];
      readonly good: string;
      readonly bad: string;
      readonly corrections: string;
      readonly drafts: {
        readonly cues: boolean | null;
        readonly good: boolean | null;
        readonly bad: boolean | null;
        readonly corrections: boolean | null;
      };
    };

/** One line of a block's coaching text, as the plan page and the live console show it. */
export interface CoachingLine {
  label: string;
  value: string;
  /** Lane U2-6e: the text is the linked drill's, not the plan's. */
  fromDrill: boolean;
  /** On a drill line only: true = AI draft (marked), null = draft status not checked, false = no mark. */
  draft?: boolean | null;
}

/** Lane U2-6e wording (Overwatch Q2 = A, 2026-11-19). */
export const FROM_THE_DRILL = 'From the drill';
export const DRILL_TEXT_LOADING = "Loading the drill's text...";
export const DRILL_TEXT_FAILED = `${NOT_WRITTEN_YET}. The drill's text could not be loaded.`;
/** The mark /coach/drills already shows on a drafted KPI (app/coach/drills/page.tsx). */
export const AI_DRAFT_MARK = 'DRAFT, FOR COACH REVIEW';
export const DRAFT_NOT_CHECKED = 'Draft status not checked';

/** A drill field held as one line: its own lines joined with " · ", as the cues are. */
function oneLine(items: readonly string[]): string {
  return items.join(' · ');
}

type CoachingBlock = {
  what_to_say: string | null;
  what_to_explain: string | null;
  what_to_watch: string | null;
  what_to_fix: string | null;
};

/**
 * A block's four authored coaching fields, in the order a coach reads them mid-session.
 *
 * A field the plan wrote is shown as written and the drill is not consulted for it. A field the
 * plan left empty falls back to the block's linked drill (lane U2-6e, Overwatch option A): Say to
 * the drill's cues, Watch to what good looks like with what bad looks like as a second line, Fix to
 * its corrections -- each labelled "From the drill" and carrying the drill field's draft state.
 * Explain has no drill counterpart and is unchanged. Nothing is ever a blank line: an empty field
 * with no drill text says "Not written yet", while the drill loads it says so, and a drill that
 * could not be read says that too. `drill` is null when the block links no drill.
 */
export function blockCoachingLines(block: CoachingBlock, drill: LinkedDrillText | null): CoachingLine[] {
  const own = (label: string, text: string | null): CoachingLine | null =>
    (text ?? '').trim() === '' ? null : { label, value: text as string, fromDrill: false };
  const notWritten = (label: string): CoachingLine => ({ label, value: NOT_WRITTEN_YET, fromDrill: false });
  const pending = (label: string): CoachingLine | null => {
    if (drill === null) return notWritten(label);
    if (drill.state === 'loading') return { label, value: DRILL_TEXT_LOADING, fromDrill: false };
    if (drill.state === 'failed') return { label, value: DRILL_TEXT_FAILED, fromDrill: false };
    return null;
  };
  const fromDrill = (label: string, items: readonly string[], draft: boolean | null): CoachingLine | null =>
    items.length === 0 ? null : { label: `${label} (${FROM_THE_DRILL})`, value: oneLine(items), fromDrill: true, draft };

  const say = own('Say', block.what_to_say)
    ?? pending('Say')
    ?? (drill?.state === 'loaded' ? fromDrill('Say', drill.cues.map((cue) => cue.trim()).filter(Boolean), drill.drafts.cues) : null)
    ?? notWritten('Say');

  const explained = explainLine(block.what_to_explain ?? '');
  const explain: CoachingLine = explained.value.trim() === ''
    ? notWritten(explained.label === 'From the template' ? 'Explain' : explained.label)
    : { ...explained, fromDrill: false };

  const watchOwn = own('Watch', block.what_to_watch);
  const watch: CoachingLine[] = watchOwn
    ? [watchOwn]
    : (() => {
        const waiting = pending('Watch');
        if (waiting) return [waiting];
        if (drill?.state !== 'loaded') return [notWritten('Watch')];
        const good = fromDrill('Watch', listItems(drill.good), drill.drafts.good) ?? notWritten('Watch');
        const bad = fromDrill('What to avoid', listItems(drill.bad), drill.drafts.bad);
        return bad ? [good, bad] : [good];
      })();

  const fix = own('Fix', block.what_to_fix)
    ?? pending('Fix')
    ?? (drill?.state === 'loaded' ? fromDrill('Fix', listItems(drill.corrections), drill.drafts.corrections) : null)
    ?? notWritten('Fix');

  return [say, explain, ...watch, fix];
}

/** Whether any of the block's Say, Watch or Fix lines is empty, so its linked drill is worth reading. */
export function blockNeedsDrillText(block: CoachingBlock & { drill_id: string | null }): boolean {
  return block.drill_id !== null
    && [block.what_to_say, block.what_to_watch, block.what_to_fix].some((text) => (text ?? '').trim() === '');
}

/**
 * The coach formats a plan re-renders from its blocks when it is edited (audit 2026-10-17 item 8,
 * Overwatch Q8 "A"). Never a family format: a block's title is the coach's free text, withheld from
 * families (Jason, 2026-10-12: "strip them").
 */
export const BLOCK_RENDERED_FORMATS: readonly string[] = [
  'cheat_sheet',
  'class_plan',
  'instructor_script',
  'class_flow',
] satisfies readonly SessionScriptRenderingFormat[];

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
