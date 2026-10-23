// What the General Research form collects and shows of a source's provenance
// (issue #345 R29; the contract is src/shared/researchProvenance.ts). This file
// holds no limits and no value lists of its own: the check is the contract's
// own validator, and the boxing-specificity and protected-domain lists are read
// from it, so the form cannot drift from what the sources route accepts.
//
// Labels are PROPOSED copy (new words; Jason has not ruled on them).

import {
  RESEARCH_PROTECTED_DOMAINS,
  parseResearchProvenance,
  type ResearchProtectedDomain,
} from '@/src/shared/researchProvenance';

export interface ProvenanceDraft {
  institutionalId: string;
  authors: string;
  year: string;
  journal: string;
  publicationDate: string;
  studyDesign: string;
  population: string;
  ageRange: string;
  sex: string;
  transferStatus: string;
  boxingSpecificity: string;
  protectedDomains: Partial<Record<ResearchProtectedDomain, boolean>>;
}

export const EMPTY_PROVENANCE_DRAFT: ProvenanceDraft = {
  institutionalId: '', authors: '', year: '', journal: '', publicationDate: '',
  studyDesign: '', population: '', ageRange: '', sex: '', transferStatus: '',
  boxingSpecificity: '', protectedDomains: {},
};

type TextDraftKey = Exclude<keyof ProvenanceDraft, 'boxingSpecificity' | 'protectedDomains'>;

/** The one-line inputs, in the order the form shows them. */
export const PROVENANCE_INPUTS: ReadonlyArray<{
  draft: TextDraftKey;
  label: string;
  type?: 'date';
  inputMode?: 'numeric';
  hint?: string;
  /** A pasted one-name-per-line list needs a field that keeps its line breaks. */
  multiline?: true;
}> = [
  { draft: 'institutionalId', label: 'Institutional source ID' },
  { draft: 'authors', label: 'Authors', hint: 'Separate names with semicolons or new lines', multiline: true },
  { draft: 'year', label: 'Year', inputMode: 'numeric' },
  { draft: 'journal', label: 'Journal' },
  { draft: 'publicationDate', label: 'Publication date', type: 'date' },
  { draft: 'studyDesign', label: 'Study design' },
  { draft: 'population', label: 'Population' },
  { draft: 'ageRange', label: 'Age range' },
  { draft: 'sex', label: 'Sex' },
  { draft: 'transferStatus', label: 'Transfer status' },
];

export const BOXING_SPECIFICITY_LABEL = 'Boxing specificity';
export const PROTECTED_DOMAINS_LABEL = 'Protected domains this source speaks to';

/** "return_to_play" -> "Return to play": the contract's own values, spaced. */
export function provenanceWords(value: string): string {
  const spaced = value.replaceAll('_', ' ').replace(/^ppbf\b/, 'PPBF');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export type ProvenanceRegistration =
  | { ok: true; provenance: Record<string, unknown>; fields: { publisher?: string; publication_date?: string } }
  | { ok: false; error: string };

/**
 * The provenance and the two columns the form sends. `base` is what the form
 * already sent (doi_or_pmid, provider, original_filename); a blank value is not
 * sent. The contract's validator decides whether the result is acceptable and
 * its message is returned as written. The journal and publication date are the
 * `publisher` and `publication_date` columns, not provenance keys.
 */
export function buildProvenanceRegistration(
  draft: ProvenanceDraft,
  base: Record<string, string>,
): ProvenanceRegistration {
  const candidate: Record<string, unknown> = { ...base };
  const text = (key: string, value: string) => {
    if (value.trim()) candidate[key] = value.trim();
  };
  text('institutional_source_id', draft.institutionalId);
  text('study_design', draft.studyDesign);
  text('population', draft.population);
  text('age_range', draft.ageRange);
  text('sex', draft.sex);
  text('transfer_status', draft.transferStatus);
  text('boxing_specificity', draft.boxingSpecificity);

  const authors = draft.authors.split(/[;\n]/).map((name) => name.trim()).filter(Boolean);
  if (authors.length > 0) candidate.authors = authors;

  // A year that is not all digits goes to the validator as typed, so its own
  // message answers it.
  const year = draft.year.trim();
  if (year) candidate.year = /^\d+$/.test(year) ? Number(year) : year;

  const flagged = RESEARCH_PROTECTED_DOMAINS.filter((domain) => draft.protectedDomains[domain] === true);
  if (flagged.length > 0) candidate.protected_domains = Object.fromEntries(flagged.map((domain) => [domain, true]));

  const checked = parseResearchProvenance(candidate);
  if (!checked.ok) return { ok: false, error: checked.error };

  const fields: { publisher?: string; publication_date?: string } = {};
  if (draft.journal.trim()) fields.publisher = draft.journal.trim();
  if (draft.publicationDate.trim()) fields.publication_date = draft.publicationDate.trim();
  return { ok: true, provenance: checked.provenance as Record<string, unknown>, fields };
}

export interface ProvenanceLine {
  label: string;
  value: string;
}

// Saved key -> label, in the order the list shows them.
const SAVED_TEXT_LINES: ReadonlyArray<readonly [string, string]> = [
  ['doi_or_pmid', 'DOI / PMID'],
  ['institutional_source_id', 'Institutional source ID'],
  ['provider', 'Provider'],
  ['original_filename', 'Original filename'],
  ['study_design', 'Study design'],
  ['population', 'Population'],
  ['age_range', 'Age range'],
  ['sex', 'Sex'],
  ['transfer_status', 'Transfer status'],
];

function plain(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function shown(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
}

/**
 * What a registered source already carries, one line per field that is set.
 * Read-only and defensive: older rows may hold anything, and a value of the
 * wrong shape is left out rather than shown.
 */
export function savedProvenanceLines(
  source: { publisher?: unknown; publication_date?: unknown; metadata?: unknown },
): ProvenanceLine[] {
  const lines: ProvenanceLine[] = [];
  const add = (label: string, value: string | null) => {
    if (value) lines.push({ label, value });
  };
  const saved = plain(plain(source.metadata)?.provenance) ?? {};

  add('Journal', shown(source.publisher));
  add('Publication date', shown(source.publication_date));
  add('Year', typeof saved.year === 'number' ? shown(saved.year) : null);
  if (Array.isArray(saved.authors)) {
    add('Authors', saved.authors.map(shown).filter(Boolean).join('; ') || null);
  }
  for (const [key, label] of SAVED_TEXT_LINES) add(label, shown(saved[key]));
  const specificity = shown(saved.boxing_specificity);
  add(BOXING_SPECIFICITY_LABEL, specificity ? provenanceWords(specificity) : null);
  const flags = plain(saved.protected_domains);
  if (flags) {
    const names = RESEARCH_PROTECTED_DOMAINS.filter((domain) => flags[domain] === true).map(provenanceWords);
    add('Protected domains', names.join(', ') || null);
  }
  return lines;
}
