import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * READ THE COMPONENT LAYER THE WAY A COLOUR GUARD HAS TO READ IT.
 *
 * A design guard that only reads stylesheets is only half a guard. The app
 * styles itself with Tailwind arbitrary values written into `className`
 * strings -- `border-[color:rgb(var(--brass-400-rgb)_/_.22)]` -- so a rule
 * that decides what a border paints is just as likely to live in a `.tsx`
 * file as in a `.css` file. `src/design/brassAlphaChannel.test.ts` guarded
 * the sheets from its first day and could not see the component layer at all;
 * 299 brass literals sat there behind a green suite.
 *
 * This module is that missing half: the file walk, and a comment stripper
 * that is safe to grep the result of.
 *
 * WHY COMMENTS ARE STRIPPED. A comment is not a rule. This repository's
 * design guards explain themselves at length and quote the literals they ban
 * while doing it, and a guard that failed on its own explanation would teach
 * people to stop explaining.
 *
 * WHY A STATE MACHINE RATHER THAN A REGEX. `source.replace(/\/\/.*$/gm, '')`
 * eats the second slash of a `https://` inside a string literal and takes the
 * rest of the line with it -- the exact bug that discredited an earlier count
 * in `safeguardingRedReservation.test.ts`, which is where this machine comes
 * from and which still carries its own copy. That copy also returns a
 * string-position mask its proximity rule depends on; this one does not need
 * the mask, and unifying them means editing a live guard that belongs to the
 * safeguarding lane. Two readers, one shape, stated here so the next person
 * knows the duplication is deliberate rather than missed.
 *
 * COMMENT CHARACTERS BECOME SPACES, never deleted, so every surviving
 * character keeps its line and column and a violation can be reported at the
 * line a person will find it on.
 */

/** Characters that make a following `/` open a regex literal rather than a
 *  division -- the standard previous-significant-character heuristic. */
const REGEX_PRECEDERS = /[(,=:[!&|?{};+\-*%~^<>]/;

/**
 * Returns `source` with every comment blanked to spaces.
 *
 * `'…'` and `"…"` terminate at a newline: valid JS forbids a raw newline in
 * them, so this bounds the blast radius of a stray apostrophe in JSX prose
 * (don't, athlete's) to one line instead of the rest of the file. Template
 * literals span lines; their `${…}` interpolations are treated as string,
 * which only matters for a comment inside an interpolation -- kept, harmless.
 */
export function stripSourceComments(source: string): string {
  const out = source.split('');
  type State = 'code' | 'line' | 'block' | 'single' | 'double' | 'template' | 'regex';
  let state: State = 'code';
  let previousSignificant = '(';
  let inCharClass = false;

  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    const n = source[i + 1];

    switch (state) {
      case 'code':
        if (c === '/' && n === '/') {
          out[i] = ' ';
          state = 'line';
        } else if (c === '/' && n === '*') {
          out[i] = ' ';
          state = 'block';
        } else if (c === "'") {
          state = 'single';
        } else if (c === '"') {
          state = 'double';
        } else if (c === '`') {
          state = 'template';
        } else if (c === '/' && REGEX_PRECEDERS.test(previousSignificant)) {
          state = 'regex';
          inCharClass = false;
        }
        if (state === 'code' && !/\s/.test(c)) previousSignificant = c;
        break;

      case 'line':
        if (c === '\n') state = 'code';
        else out[i] = ' ';
        break;

      case 'block':
        if (c === '*' && n === '/') {
          out[i] = ' ';
          out[i + 1] = ' ';
          i += 1;
          state = 'code';
        } else if (c !== '\n') {
          out[i] = ' ';
        }
        break;

      case 'single':
      case 'double': {
        const closer = state === 'single' ? "'" : '"';
        if (c === '\n') {
          state = 'code';
        } else if (c === '\\') {
          if (n !== undefined && n !== '\n') i += 1;
        } else if (c === closer) {
          state = 'code';
        }
        break;
      }

      case 'template':
        if (c === '\\') {
          if (n !== undefined) i += 1;
        } else if (c === '`') {
          state = 'code';
        }
        break;

      case 'regex':
        if (c === '\n') {
          state = 'code';
        } else if (c === '\\') {
          i += 1;
        } else if (c === '[') {
          inCharClass = true;
        } else if (c === ']') {
          inCharClass = false;
        } else if (c === '/' && !inCharClass) {
          state = 'code';
          previousSignificant = c;
        }
        break;
    }
  }

  return out.join('');
}

/** `apps/web`, from anywhere under `src/design`. */
export const WEB_ROOT = path.resolve(__dirname, '../..');

/**
 * The directories that hold rendered product source.
 *
 * `src/` is in the list because guards written against `app/` and
 * `components/` alone have already missed it once -- `src/components/` holds
 * real rendered components, and a walk that stops at the two obvious
 * directories reports green on a file it never opened.
 *
 * `e2e/` and `scripts/` are deliberately OUT. Neither ships to a browser as
 * part of a page: an e2e spec asserts against literal colour values on
 * purpose (that is how it proves a scope repainted something), and
 * `scripts/page-shots.ts` builds a developer contact sheet, not a surface any
 * scope re-skins. Bringing either in would mean either banning the assertion
 * or writing an exemption for it, and neither buys anything.
 */
export const COMPONENT_SOURCE_ROOTS = ['app', 'components', 'src', 'lib'] as const;

function walk(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) {
      found.push(...walk(full));
    } else if (
      /\.tsx?$/.test(full)
      && !/\.(test|spec)\.tsx?$/.test(full)
      && !full.endsWith('.d.ts')
    ) {
      found.push(full);
    }
  }
  return found.sort();
}

export interface ComponentSourceFile {
  /** Path relative to `apps/web`, which is how a failure names it. */
  readonly relativePath: string;
  /** The file with its comments blanked, line numbers intact. */
  readonly code: string;
}

/**
 * Every rendered-product `.ts`/`.tsx` under {@link COMPONENT_SOURCE_ROOTS},
 * comment-stripped, sorted so a failure list is stable between runs.
 *
 * `.ts` is walked alongside `.tsx` because `components/uiStyles.ts` and
 * `components/sessionBarControls.ts` build the className strings that `.tsx`
 * files wear -- a `.tsx`-only walk would miss the shared furniture, which is
 * precisely where a colour defect hurts most.
 */
export function readComponentSource(): ComponentSourceFile[] {
  return COMPONENT_SOURCE_ROOTS.flatMap((root) => walk(path.join(WEB_ROOT, root))).map((file) => ({
    relativePath: path.relative(WEB_ROOT, file),
    code: stripSourceComments(readFileSync(file, 'utf8')),
  }));
}
