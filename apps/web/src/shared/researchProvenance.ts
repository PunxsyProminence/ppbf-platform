// The provenance a research source carries (issue #345 provenance list,
// docs/SHADOW_RESEARCH_ARCHITECTURE.md section 6): what a curator knows about
// the STUDY, kept with the source so the original can be told from a lookalike.
//
// WHERE IT LIVES. `metadata.provenance` on the SOURCE row. Journal is the
// existing `publisher` column and the full publication date the existing
// `publication_date` column; `year` is here because a year alone is not a date
// and must not be stored as one (no invented month or day). The two are not
// cross-checked: an online date in December and an issue year of the next
// January are both true of one paper.
//
// WHERE IT MUST NEVER GO. Chunk metadata. The research importer writes
// population, age_range, sex, study_design, boxing_specificity and
// transfer_status on each CHUNK, and `boxing_specificity` there is what the
// evidence tier rule reads (shadowEvidenceTier.ts, the PROVEN gate). The same
// names here describe the source for a reader; nothing grades from them, and a
// curator-typed value must never become a tier input. No function in this file
// produces chunk metadata, and researchProvenance.test.ts pins it.
//
// SHAPE, NOT POLICY. Everything is optional ("retain as available"); a null or
// blank value is absence and is left out. A present value must have the right
// shape, and a key this file does not name is refused rather than stored.
// Only `boxing_specificity` has a defined set (the importer's four values); the
// rest are free text in the corpus (population 895 distinct values, sex 186,
// transfer_status 740, study_design 925), so they are length-bounded, not
// enumerated. The keys are bibliographic and describe studies and populations,
// never a person in the gym: no free-text note field is offered.
//
// `doi_or_pmid`, `provider` and `original_filename` are the three keys the
// General Research form already sends. They stay accepted. `doi_or_pmid` is
// stored exactly as given (not trimmed; a bare numeric PMID is allowed, as the
// publication key's reader allows it): how it is READ is not decided here.

import type { ShadowBoxingSpecificity } from '@/src/server/pilot/shadowEvidenceTier';

// Keyed by the union so a member added to or removed from the importer's
// vocabulary fails to compile here rather than silently drifting.
const BOXING_SPECIFICITY_SET: Record<ShadowBoxingSpecificity, true> = {
  boxing_specific: true,
  partly_boxing_specific: true,
  ppbf_specific: true,
  transferred: true,
};
export const RESEARCH_BOXING_SPECIFICITY_VALUES = Object.keys(BOXING_SPECIFICITY_SET) as ShadowBoxingSpecificity[];

// The evidence the issue names as never creating automated clearance, diagnosis
// or prescription authority ("Non-negotiable epistemic / safety rules").
// PROPOSED key names; a flag records that a source speaks to the domain, so a
// reader can see it. It grades and gates nothing.
export const RESEARCH_PROTECTED_DOMAINS = [
  'medical',
  'safeguarding',
  'nutrition',
  'weight_management',
  'contact',
  'return_to_play',
  'sparring',
] as const;
export type ResearchProtectedDomain = (typeof RESEARCH_PROTECTED_DOMAINS)[number];

// Longest in the 1,193-chunk corpus: population 127, age_range 100, sex 98,
// study_design 188, transfer_status 212, doi_or_pmid 162.
const TEXT_LIMITS = {
  doi_or_pmid: 200,
  provider: 200,
  original_filename: 300,
  institutional_source_id: 200,
  population: 300,
  age_range: 120,
  sex: 120,
  study_design: 300,
  transfer_status: 400,
} as const;
type TextKey = keyof typeof TEXT_LIMITS;

const MAX_AUTHORS = 100;
const MAX_AUTHOR_LENGTH = 200;
const EARLIEST_YEAR = 1800;

export interface ResearchProvenance extends Partial<Record<Exclude<TextKey, 'doi_or_pmid'>, string>> {
  doi_or_pmid?: string | number;
  authors?: string[];
  year?: number;
  boxing_specificity?: ShadowBoxingSpecificity;
  protected_domains?: Partial<Record<ResearchProtectedDomain, boolean>>;
}

export type ResearchProvenanceResult =
  | { ok: true; provenance: ResearchProvenance }
  | { ok: false; error: string };

const KNOWN_KEYS: ReadonlySet<string> = new Set([
  ...Object.keys(TEXT_LIMITS),
  'authors',
  'year',
  'boxing_specificity',
  'protected_domains',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Null, undefined and a blank string all mean "not known". */
function isAbsent(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function fail(error: string): ResearchProvenanceResult {
  return { ok: false, error };
}

/**
 * Checks a source's `metadata.provenance` and returns the copy to store: known
 * keys only, strings trimmed, absent values left out. `now` is injectable so the
 * year bound is testable.
 */
export function parseResearchProvenance(input: unknown, now: Date = new Date()): ResearchProvenanceResult {
  if (!isPlainObject(input)) return fail('metadata.provenance must be an object');

  const unknownKey = Object.keys(input).find((key) => !KNOWN_KEYS.has(key));
  if (unknownKey !== undefined) {
    return fail(`metadata.provenance.${unknownKey.slice(0, 60)} is not a provenance field`);
  }

  const out: ResearchProvenance = {};

  for (const key of Object.keys(TEXT_LIMITS) as TextKey[]) {
    const value = input[key];
    if (isAbsent(value)) continue;
    if (key === 'doi_or_pmid' && typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
      out[key] = value;
      continue;
    }
    if (typeof value !== 'string') return fail(`metadata.provenance.${key} must be a string`);
    const trimmed = value.trim();
    if (trimmed.length > TEXT_LIMITS[key]) {
      return fail(`metadata.provenance.${key} must be ${TEXT_LIMITS[key]} characters or fewer`);
    }
    if (key === 'doi_or_pmid') out[key] = value;
    else out[key] = trimmed;
  }

  if (!isAbsent(input.authors)) {
    const authors = input.authors;
    if (!Array.isArray(authors) || authors.length > MAX_AUTHORS) {
      return fail(`metadata.provenance.authors must be a list of at most ${MAX_AUTHORS} names`);
    }
    const names: string[] = [];
    for (const author of authors) {
      if (isAbsent(author)) continue;
      if (typeof author !== 'string') return fail('metadata.provenance.authors must be a list of names');
      if (author.trim().length > MAX_AUTHOR_LENGTH) {
        return fail(`metadata.provenance.authors must be names of ${MAX_AUTHOR_LENGTH} characters or fewer`);
      }
      names.push(author.trim());
    }
    if (names.length > 0) out.authors = names;
  }

  if (!isAbsent(input.year)) {
    const latest = now.getUTCFullYear() + 1; // an in-press paper may be dated next year
    if (!Number.isSafeInteger(input.year) || (input.year as number) < EARLIEST_YEAR || (input.year as number) > latest) {
      return fail(`metadata.provenance.year must be a whole year from ${EARLIEST_YEAR} to ${latest}`);
    }
    out.year = input.year as number;
  }

  if (!isAbsent(input.boxing_specificity)) {
    const value = input.boxing_specificity;
    if (typeof value !== 'string' || !Object.hasOwn(BOXING_SPECIFICITY_SET, value.trim())) {
      return fail(`metadata.provenance.boxing_specificity must be one of ${RESEARCH_BOXING_SPECIFICITY_VALUES.join(', ')}`);
    }
    out.boxing_specificity = value.trim() as ShadowBoxingSpecificity;
  }

  if (!isAbsent(input.protected_domains)) {
    const flags = input.protected_domains;
    if (!isPlainObject(flags)) return fail('metadata.provenance.protected_domains must be an object');
    const kept: Partial<Record<ResearchProtectedDomain, boolean>> = {};
    for (const [domain, flag] of Object.entries(flags)) {
      if (!(RESEARCH_PROTECTED_DOMAINS as readonly string[]).includes(domain)) {
        return fail(`metadata.provenance.protected_domains.${domain.slice(0, 60)} is not a protected domain`);
      }
      if (typeof flag !== 'boolean') {
        return fail(`metadata.provenance.protected_domains.${domain} must be true or false`);
      }
      kept[domain as ResearchProtectedDomain] = flag;
    }
    if (Object.keys(kept).length > 0) out.protected_domains = kept;
  }

  return { ok: true, provenance: out };
}
