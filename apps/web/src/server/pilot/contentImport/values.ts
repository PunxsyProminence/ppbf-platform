// Cell-level reading rules shared by the validator, the canonical hash and the
// prepare step. One copy, because the moment the validator and the hash read
// "2.0" or " True" differently, a re-import of unchanged files starts to look
// like a revision (R2: unchanged items must be skipped).

/** What a cell means: NFC, LF line breaks, no edge whitespace. */
export function normalizeCell(raw: string | null | undefined): string {
  return String(raw ?? '')
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .trim();
}

// The committed CSVs write whole numbers both ways ('2' and '2.0': cohort
// min_level_ordinal, template item duration_minutes). The old loaders read
// both with parseInt (the retired seed-competence-cohorts.mjs), so both stay valid.
const INTEGER_TEXT = /^-?\d+(?:\.0+)?$/;
const NUMBER_TEXT = /^-?\d+(?:\.\d+)?$/;

export function isIntegerText(value: string): boolean {
  return INTEGER_TEXT.test(value);
}

export function isNumberText(value: string): boolean {
  return NUMBER_TEXT.test(value);
}

/** '2.0' -> '2'. Callers check isIntegerText first. */
export function integerText(value: string): string {
  return String(Number.parseInt(value, 10));
}

export function numberText(value: string): string {
  return String(Number(value));
}

/** true/false in any case; anything else is not a boolean. */
export function parseBoolean(value: string): boolean | null {
  const lowered = value.toLowerCase();
  if (lowered === 'true') return true;
  if (lowered === 'false') return false;
  return null;
}

/** Split a list cell on its separator; items trimmed, empties dropped. */
export function splitList(value: string, separator: string): string[] {
  return value
    .split(separator)
    .map((item) => item.trim())
    .filter((item) => item !== '');
}
