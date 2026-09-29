const LINE_SEPARATORS = /[\u2028\u2029]/g;

const escapeLineSeparator = (character) => (character === '\u2028' ? '\\u2028' : '\\u2029');

/**
 * Any value as reversible JSON that cannot occupy more than one physical log line.
 * pilot-check-cue-source-provenance.mjs and pilot-check-reference-content.mjs
 * print every database-derived value through it, so there is one rule to audit
 * instead of one per script or per field. It lives here rather than in either
 * check so neither depends on the other existing under its current name.
 *
 * JSON.stringify escapes quotes, backslashes and every C0 control character
 * including newline and carriage return. U+2028 and U+2029 are escaped on top of
 * that, because JSON leaves them raw and some log viewers still break a line on
 * them. The consequence is the property everything else rests on: a stored value
 * cannot begin a line, so it can neither forge an evidence record nor be read as
 * a `::workflow command::`. A pipe is just a character, because nothing here is
 * pipe-delimited.
 *
 * IT DELIBERATELY DOES NOT TRUNCATE. This is a serialization primitive, not a
 * display-bound one -- `JSON.parse` of its output reproduces the input exactly.
 * A bound that lived here would silently make an identifier irreversible, so any
 * shortening is the caller's decision and the caller has to say it shortened.
 */
export function encodeSingleLineJson(value) {
  return JSON.stringify(value).replace(LINE_SEPARATORS, escapeLineSeparator);
}
