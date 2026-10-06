// ONE RULE FOR "BLANK" IN A LIBRARY LOCATOR (CL-C1, audit 2026-10-05).
//
// The chunks route trimmed with JavaScript's String.prototype.trim (tabs, line
// breaks, NBSP and the other Unicode spaces are blank) while the database
// trigger used btrim (ASCII space only). A tab "locator" was therefore full
// text to the route and an excerpt to the database, and the full-text rights
// rule was never asked.
//
// The rule is JavaScript's trim set. The database cannot call it, so the same
// set is written out below as a regular-expression class, and the source-rights
// migration carries that class verbatim (locatorWhitespace.test.ts holds both
// to it: every BMP code point, and the text of the migration). Not POSIX
// [:space:], whose meaning in Postgres depends on the database's locale.
export const LOCATOR_WHITESPACE_CLASS =
  ' \\t\\n\\v\\f\\r\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff';

/** The locator with surrounding whitespace removed; '' when it holds nothing else. */
export function trimLocator(value: string): string {
  return value.trim();
}
