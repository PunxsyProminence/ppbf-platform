#!/usr/bin/env node
//
// Grades the STRUCTURE of the Evidence Applicability Records in a pull request
// body. It does not grade whether the evidence is any good.
//
// WHY THIS EXISTS. docs/current/EVIDENCE_APPLICABILITY.md is the contract; this
// is the half of it that does not depend on the lane having read the contract.
// It answers only questions with an objective answer -- is the field there, is
// the level a real level, does a staging claim name an environment, is a cited
// commit a full SHA. Whether the instrument actually measures the claim is a
// judgement, and no amount of parsing produces it.
//
// WHAT IT DOES NOT DO, STATED HERE BECAUSE THE FAILURE MODE IS BELIEVING IT
// DID. A record that passes every rule below can still be nonsense: a real
// instrument, a real subject, a real green result, and no relationship to the
// claim. That is exactly the defect class this contract exists for, and it is
// the reviewer's to catch. A green run of this checker means "the record is
// filled in", never "the claim is verified".
//
// AND IT IS OPT-IN, DELIBERATELY. A body carrying no record passes. Requiring
// one on every pull request would red every branch open today for a reason
// unrelated to its own evidence, and -- worse -- would turn a filled-in form
// into the thing CI blesses. The asymmetry is real and is written down in the
// contract: silence here is not a pass on applicability, it is an absence of
// any structural declaration to grade.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Starts a record. The label after the marker is free text and is not graded. */
const RECORD_MARKER = /EVIDENCE\s+APPLICABILITY/i;

/**
 * Canonical field names, in the order the contract prints them.
 *
 * Order matters only for the report; presence is what is checked. Every one is
 * required, because a record that may omit a field omits the field that would
 * have been inconvenient -- and on this list the inconvenient one is usually
 * EXECUTION PATH or BLIND SPOTS, which are the two that catch Case A and Case B
 * in the contract's own exemplars.
 */
export const REQUIRED_FIELDS = [
  'CLAIM',
  'PROPERTY',
  'INSTRUMENT',
  'SUBJECT',
  'EXECUTION PATH',
  'POSITIVE CONTROL',
  'NEGATIVE CONTROL',
  'EVIDENCE LEVEL',
  'BLIND SPOTS',
  'VERDICT',
];

/**
 * Spellings the contract's prose uses for the same field, normalised to the
 * canonical name. A record is rejected for what it fails to say, never for the
 * heading style it said it in.
 */
export const FIELD_ALIASES = new Map([
  ['SUBJECT SHA / ENVIRONMENT', 'SUBJECT'],
  ['SUBJECT SHA', 'SUBJECT'],
  ['SUBJECT / ENVIRONMENT', 'SUBJECT'],
  ['NEGATIVE CONTROL / MUTATION', 'NEGATIVE CONTROL'],
  ['NEGATIVE CONTROL / ADVERSARIAL PROOF', 'NEGATIVE CONTROL'],
  ['ADVERSARIAL PROOF', 'NEGATIVE CONTROL'],
  ['MUTATION', 'NEGATIVE CONTROL'],
  ['KNOWN BLIND SPOTS', 'BLIND SPOTS'],
  ['BLIND SPOT', 'BLIND SPOTS'],
  ['EVIDENCE_LEVEL', 'EVIDENCE LEVEL'],
  ['LEVEL', 'EVIDENCE LEVEL'],
  ['CONTROL', 'POSITIVE CONTROL'],
]);

/**
 * The evidence ladder, weakest first. Each rung names an INSTRUMENT, not a
 * degree of confidence -- the kernel's rule that "verified" names its
 * instrument, spelled as a closed vocabulary so a claim cannot quietly inherit
 * a stronger level than the thing that produced it.
 *
 * NONE is a real rung and the honest one for a claim nothing measured.
 */
export const EVIDENCE_LEVELS = [
  'NONE',
  'CODE_READ',
  'TYPECHECK',
  'UNIT',
  'INTEGRATION',
  'REAL_DATABASE',
  'BROWSER',
  'LOCAL_RUNTIME',
  'STAGING',
  'PRODUCTION',
  'HUMAN_OBSERVATION',
];

/**
 * Levels whose whole meaning is WHERE the instrument ran. A record claiming one
 * of these without naming the environment in SUBJECT is the Case A shape: a run
 * cited without the state it ran against.
 *
 * BROWSER is not here on purpose -- a Playwright run against a local dev server
 * is a real browser instrument and names no deployed environment.
 */
export const ENVIRONMENT_LEVELS = ['LOCAL_RUNTIME', 'STAGING', 'PRODUCTION'];

/** Words that count as naming an environment in SUBJECT. */
export const ENVIRONMENT_WORDS = [
  'local',
  'localhost',
  'container',
  'sandbox',
  'staging',
  'production',
  'prod',
  'preview',
];

export const VERDICTS = ['APPLICABLE', 'PARTIAL', 'UNVERIFIED', 'RETRACTED'];

/**
 * The two fields answered from a closed vocabulary rather than in prose.
 *
 * They are exempt from the waiver rule below, and have to be: NONE is a real
 * rung on the ladder and the honest one for a claim nothing measured, so
 * demanding a reason after it would push a record toward claiming a level it
 * does not have. Their emptiness is caught by the vocabulary check instead --
 * an empty string is not a level and not a verdict.
 */
export const CLOSED_VOCABULARY_FIELDS = ['EVIDENCE LEVEL', 'VERDICT'];

/**
 * Bare waivers. Each of these is a legitimate ANSWER -- mutation is nonsensical
 * for a version read, a source-only structural claim has no environment -- and
 * none of them is a legitimate answer ON ITS OWN. The rule is that a waiver
 * carries its reason, so "why not" is on the record where a reviewer can
 * disagree with it, rather than being a blank a reader fills in charitably.
 */
export const WAIVER_TOKENS = [
  'none',
  'n/a',
  'na',
  'not applicable',
  'nil',
  'tbd',
  'todo',
  'unknown',
  'pending',
  '-',
  '--',
  '?',
  'x',
];

/** Placeholder text lifted straight out of a template and never replaced. */
const PLACEHOLDER = /^(?:<[^>]*>|\.{3}|…|xxx+|fill in|your .*here)$/i;

function normaliseFieldName(raw) {
  const upper = raw.trim().toUpperCase().replace(/\s+/g, ' ');
  return FIELD_ALIASES.get(upper) ?? upper;
}

/**
 * Strip list bullets, quote markers, bold/italic markers and backticks.
 *
 * Underscores are LEFT ALONE. They are markdown emphasis in theory and
 * `COACHING_CONTENT_READER_ROLES` in practice, and a checker that quietly
 * rewrote an identifier in the value it is about to print back at a reviewer
 * would be lying about the record it read.
 */
function unadorn(line) {
  return line.replace(/^[ \t>]*(?:[-*+]\s+|\d+[.)]\s+)?/, '').replace(/[`*]/g, '').trim();
}

/**
 * Blank out HTML comments, keeping the line count so reported line numbers
 * still point at the body the author wrote.
 *
 * The pull request template carries the record block INSIDE a comment, so an
 * author who has not filled it in has declared nothing and must be treated as
 * having declared nothing -- not as having filed ten placeholder fields. An
 * unterminated comment swallows the rest of the body, which is what a browser
 * does with it too.
 */
export function stripHtmlComments(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, (match) => '\n'.repeat((match.match(/\n/g) ?? []).length))
    .replace(/<!--[\s\S]*$/, (match) => '\n'.repeat((match.match(/\n/g) ?? []).length));
}

/**
 * Pull every Evidence Applicability Record out of a body.
 *
 * A record starts at a line naming the marker and ends at the next marker, the
 * next markdown heading, or a horizontal rule -- whichever comes first. Values
 * may run over several lines; a continuation is any line that is not itself a
 * `FIELD:` line, which is how a CLAIM long enough to be worth making survives
 * being written on two lines.
 */
export function parseRecords(body) {
  const text = stripHtmlComments(String(body ?? '').replace(/\r\n/g, '\n'));
  const lines = text.split('\n');
  const records = [];
  let current = null;
  let field = null;

  const closeField = () => {
    if (current && field) current.fields[field] = current.fields[field].trim();
    field = null;
  };

  for (const [index, line] of lines.entries()) {
    const bare = unadorn(line);

    if (RECORD_MARKER.test(bare) && !/^[A-Z][A-Z _/-]*:/.test(bare.replace(/^#+\s*/, ''))) {
      closeField();
      const label = bare.replace(/^#+\s*/, '').replace(RECORD_MARKER, '').replace(/^[\s—-]+/, '').trim();
      current = { label, line: index + 1, fields: {} };
      records.push(current);
      continue;
    }

    if (!current) continue;

    if (/^#{1,6}\s/.test(line.trim()) || /^\s*(?:-{3,}|={3,}|\*{3,})\s*$/.test(line)) {
      closeField();
      current = null;
      continue;
    }

    const match = /^([A-Za-z][A-Za-z _/-]*?):\s?(.*)$/.exec(bare);
    if (match) {
      const name = normaliseFieldName(match[1]);
      closeField();
      field = name;
      current.fields[name] = match[2];
      continue;
    }

    if (field && bare) current.fields[field] += ` ${bare}`;
  }

  closeField();

  // A marker line with no field under it is a heading, not a record. Prose
  // about this contract -- including this contract's own section headings --
  // says the words "evidence applicability" constantly, and grading every one
  // of those as an empty record would report ten missing fields for a sentence.
  // A record is a marker that actually declared something.
  return records.filter((record) =>
    REQUIRED_FIELDS.some((name) => name in record.fields));
}

/**
 * Is a value a bare waiver or a placeholder rather than an answer?
 *
 * "none" fails. "none -- a production version read has no mutation to make"
 * passes: the waiver is the same, the difference is that somebody committed to
 * a reason for it.
 */
export function isVacuous(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return true;
  if (PLACEHOLDER.test(trimmed)) return true;

  const stripped = trimmed.replace(/[.\s]+$/, '').toLowerCase();
  return WAIVER_TOKENS.includes(stripped);
}

/**
 * An abbreviated commit SHA, presented as a subject.
 *
 * The kernel's staging gate refuses an abbreviated `expected_sha` for the same
 * reason: seven characters do not identify a commit to anyone who has to go and
 * find it later. Requiring a letter AND a digit is what keeps a workflow run id
 * (`33202463204`, all decimal) and an English word (`defaced`, no digit) out of
 * this net. A short SHA that happens to be all digits slips through -- named in
 * the contract's blind-spot section rather than papered over.
 */
export function abbreviatedShas(value) {
  const found = [];
  for (const token of String(value ?? '').split(/[^0-9a-fA-F]+/)) {
    const lower = token.toLowerCase();
    if (lower.length < 7 || lower.length >= 40) continue;
    if (!/[a-f]/.test(lower) || !/[0-9]/.test(lower)) continue;
    found.push(token);
  }
  return [...new Set(found)];
}

function namesEnvironment(value) {
  const lower = String(value ?? '').toLowerCase();
  return ENVIRONMENT_WORDS.some((word) => new RegExp(`\\b${word}\\b`).test(lower));
}

/** Grade one record. Returns the failures, most structural first. */
export function evaluateRecord(record) {
  const failures = [];
  const where = record.label ? `record "${record.label}"` : `record at line ${record.line}`;
  const fields = record.fields ?? {};

  for (const name of REQUIRED_FIELDS) {
    if (!(name in fields)) failures.push(`${where}: missing ${name}.`);
    else if (CLOSED_VOCABULARY_FIELDS.includes(name)) continue;
    else if (isVacuous(fields[name])) {
      failures.push(
        `${where}: ${name} is "${fields[name].trim() || '(empty)'}" -- a waiver needs its reason. `
        + `Write "none -- <why this instrument is not the right one here>".`,
      );
    }
  }

  const level = (fields['EVIDENCE LEVEL'] ?? '').trim().toUpperCase().replace(/[^A-Z_]/g, '');
  if ('EVIDENCE LEVEL' in fields) {
    if (!EVIDENCE_LEVELS.includes(level)) {
      failures.push(
        `${where}: EVIDENCE LEVEL "${fields['EVIDENCE LEVEL'].trim()}" is not one of `
        + `${EVIDENCE_LEVELS.join(', ')}.`,
      );
    } else if (ENVIRONMENT_LEVELS.includes(level) && !namesEnvironment(fields.SUBJECT)) {
      failures.push(
        `${where}: EVIDENCE LEVEL is ${level}, but SUBJECT names no environment. `
        + `A run is evidence about the state it ran against; say which one.`,
      );
    }
  }

  const verdict = (fields.VERDICT ?? '').trim().toUpperCase().replace(/[^A-Z]/g, '');
  if ('VERDICT' in fields) {
    if (!VERDICTS.includes(verdict)) {
      failures.push(
        `${where}: VERDICT "${fields.VERDICT.trim()}" is not one of ${VERDICTS.join(', ')}. `
        + `"likely", "should" and "expected" are not verdicts.`,
      );
    } else if (verdict === 'APPLICABLE' && level === 'NONE') {
      failures.push(
        `${where}: VERDICT is APPLICABLE with EVIDENCE LEVEL NONE. `
        + `Nothing measured it, so the verdict is UNVERIFIED.`,
      );
    }
  }

  for (const sha of abbreviatedShas(fields.SUBJECT)) {
    failures.push(
      `${where}: SUBJECT cites "${sha}", an abbreviated SHA. `
      + `Write the full 40 characters -- the staging gate refuses short ones for the same reason.`,
    );
  }

  return { ok: failures.length === 0, failures };
}

export function evaluate(body) {
  const records = parseRecords(body);
  const failures = [];
  for (const record of records) failures.push(...evaluateRecord(record).failures);
  return { ok: failures.length === 0, records, failures };
}

function main() {
  const fileArg = process.argv[2];
  const body = fileArg ? fs.readFileSync(fileArg, 'utf8') : process.env.PR_BODY;
  const result = evaluate(body);

  console.log(`Evidence Applicability Records found: ${result.records.length}`);
  for (const record of result.records) {
    console.log(`  - ${record.label || `(unlabelled, line ${record.line})`}`
      + `  [${(record.fields['EVIDENCE LEVEL'] ?? '?').trim()} / ${(record.fields.VERDICT ?? '?').trim()}]`);
  }
  console.log('');

  if (result.records.length === 0) {
    console.log('No record to grade. This is a pass on FORM only: it says nothing about');
    console.log('whether this pull request\'s evidence establishes its claims.');
    console.log(`See ${path.relative(path.resolve(HERE, '../../..'), path.resolve(HERE, '../../../docs/current/EVIDENCE_APPLICABILITY.md'))}`);
    return;
  }

  for (const failure of result.failures) console.error(`FAIL: ${failure}`);

  if (!result.ok) {
    console.error('');
    console.error('These are structural faults only. A record that passes them all can still');
    console.error('cite an instrument that never exercised the claim -- that judgement is the');
    console.error('reviewer\'s, and this check does not make it.');
    process.exit(1);
  }

  console.log('Every record is structurally complete.');
  console.log('That is NOT a finding that the evidence establishes the claims. Structural');
  console.log('completeness is form; applicability is the reviewer\'s judgement.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
