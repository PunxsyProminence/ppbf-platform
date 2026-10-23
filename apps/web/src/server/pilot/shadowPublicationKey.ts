/**
 * One paper, one source (F-136).
 *
 * Two library passages count as two sources only when their publication keys
 * differ. Counting by source_id let one paper filed twice (a doi.org link and a
 * PubMed link, or the same URL with and without www/utm tracking) satisfy
 * "two independent sources".
 *
 * RULING (Jason 2026-10-18, "A: DOI/PMID/URL key (Rec.)"): a source's key is its
 * DOI, else its PMID, else its normalised URL (lowercase host; no scheme, no
 * www., no trailing slash, no fragment, no utm_* query params), else its
 * source_id.
 *
 * Where each is read, first found wins: the DOI from metadata.doi, then
 * metadata.provenance.doi_or_pmid, then identifier_kind 'doi', then the URL;
 * the PMID the same way from metadata.pmid, the provenance box, identifier_kind
 * 'pmid', then a PubMed URL. provenance.doi_or_pmid is General Research's one
 * "DOI or PMID" box (app/research/page.tsx), so it may hold either: a DOI
 * anywhere in it (before any ? or #, as in a URL, so a pasted doi.org link
 * keys as it would in the URL field), or the whole box a PMID ("31452104",
 * "PMID: 31452104") or a PubMed link.
 *
 * publicationKey() keys the claim path in JS; PUBLICATION_KEY_SQL() is the same
 * rule as a Postgres expression for capability coverage. They must agree:
 * shadowLibraryCoverage.pg.test.ts compares them row by row.
 *
 * publicationIdentifiers() and PUBLICATION_IDENTIFIERS_SQL() read the same
 * places with the same helpers but keep EVERY DOI and PMID, not the first: the
 * registration check (#345 D2) refuses a paper whose DOI or PMID is already on
 * the shelf. The same drift guard compares those two. Neither changes the key.
 *
 * Both twins assume ASCII DOIs when lowercasing: JS toLowerCase() folds every
 * letter, Postgres lower() follows the database locale. Real DOIs are ASCII;
 * a non-ASCII one could key or match differently in the two (fails open).
 */

export type PublicationKeySource = {
  source_id: string;
  url: string | null;
  metadata: Record<string, unknown> | null;
};

const DOI_PATTERN = /10\.\d{4,9}\/[^\s;,\]"'<>]+/;
const PUBMED_URL_PATTERN =
  /^(?:https?:\/\/)?(?:pubmed\.ncbi\.nlm\.nih\.gov|(?:www\.)?ncbi\.nlm\.nih\.gov\/pubmed)\/(\d+)(?:[/?#]|$)/i;

// ASCII whitespace only, on both sides: JS .trim() and Postgres btrim() trim
// different sets, and the two keys must agree byte for byte.
const EDGE_SPACE = /^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g;

// The whole provenance box as a PMID, optionally labelled. Letters are spelled
// out and digits are [0-9]: a case-insensitive flag or \d can fold or match
// non-ASCII characters differently in Postgres, and the keys must agree.
const PMID_BOX_PATTERN = /^(?:[Pp][Mm][Ii][Dd][ \t\n\r\f\v]*:?[ \t\n\r\f\v]*)?([0-9]+)$/;

// A string, or a non-negative whole number (a PMID stored as a number) that
// JS holds exactly. Any other JSON value -- object, array, boolean, fraction,
// a number past 2^53 -- is absent, as in SQL.
function text(value: unknown): string | null {
  const raw = typeof value === 'string'
    ? value
    : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  const trimmed = raw?.replace(EDGE_SPACE, '') ?? '';
  return trimmed === '' ? null : trimmed;
}

function doiFrom(value: string | null): string | null {
  const match = value ? DOI_PATTERN.exec(value) : null;
  return match ? match[0] : null;
}

// General Research's "DOI or PMID" box: metadata.provenance.doi_or_pmid.
function provenanceIdOf(meta: Record<string, unknown>): string | null {
  const provenance = meta.provenance;
  return typeof provenance === 'object' && provenance !== null && !Array.isArray(provenance)
    ? text((provenance as Record<string, unknown>).doi_or_pmid)
    : null;
}

// Every place a DOI can live, in the key's precedence order (null where it is
// absent), before normalisation. publicationKey() takes the first;
// publicationIdentifiers() takes them all.
function doiCandidates(source: PublicationKeySource): (string | null)[] {
  const meta = source.metadata ?? {};
  const url = text(source.url);
  const box = provenanceIdOf(meta);
  return [
    doiFrom(text(meta.doi)),
    doiFrom(box ? box.replace(/[?#][\s\S]*$/, '') : null),
    doiFrom(meta.identifier_kind === 'doi' ? text(meta.identifier) : null),
    doiFrom(url ? url.replace(/[?#][\s\S]*$/, '') : null),
  ];
}

function normalizeDoi(found: string): string {
  return found.replace(/[.,;:]+$/, '').toLowerCase();
}

function doiOf(source: PublicationKeySource): string | null {
  const found = doiCandidates(source).find((candidate) => candidate !== null);
  return found ? normalizeDoi(found) : null;
}

function digitsOnly(value: string | null): string | null {
  return value !== null && /^\d+$/.test(value) ? value : null;
}

// Every place a PMID can live, in the key's precedence order.
function pmidCandidates(source: PublicationKeySource): (string | null)[] {
  const meta = source.metadata ?? {};
  const url = text(source.url);
  const box = provenanceIdOf(meta);
  return [
    digitsOnly(text(meta.pmid)),
    box ? (PMID_BOX_PATTERN.exec(box)?.[1] ?? null) : null,
    box ? (PUBMED_URL_PATTERN.exec(box)?.[1] ?? null) : null,
    digitsOnly(meta.identifier_kind === 'pmid' ? text(meta.identifier) : null),
    url ? (PUBMED_URL_PATTERN.exec(url)?.[1] ?? null) : null,
  ];
}

function pmidOf(source: PublicationKeySource): string | null {
  return pmidCandidates(source).find((candidate) => candidate !== null) ?? null;
}

export function normalizePublicationUrl(rawUrl: string | null): string | null {
  const trimmed = text(rawUrl);
  if (!trimmed) return null;
  const rest = trimmed.replace(/#[\s\S]*$/, '').replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, '');
  if (rest === '') return null;
  const host = (/^[^/?]*/.exec(rest)?.[0] ?? '').toLowerCase().replace(/^www\./, '');
  const pathAndQuery = rest.slice((/^[^/?]*/.exec(rest)?.[0] ?? '').length);
  const path = (/^[^?]*/.exec(pathAndQuery)?.[0] ?? '').replace(/\/+$/, '');
  const queryMatch = /\?([\s\S]*)$/.exec(pathAndQuery);
  const params = (queryMatch ? queryMatch[1].split('&') : []).filter(
    (part) => part !== '' && !/^utm_[^=]*(=|$)/i.test(part),
  );
  return `${host}${path}${params.length > 0 ? `?${params.join('&')}` : ''}`;
}

export function publicationKey(source: PublicationKeySource): string {
  const doi = doiOf(source);
  if (doi) return `doi:${doi}`;
  const pmid = pmidOf(source);
  if (pmid) return `pmid:${pmid}`;
  const url = normalizePublicationUrl(source.url);
  if (url) return `url:${url}`;
  return `source:${source.source_id}`;
}

/**
 * Every DOI and every PMID the source carries, read from every place
 * publicationKey() reads one, as `doi:<doi>` / `pmid:<pmid>` (normalised the
 * same way, deduplicated, sorted). The key keeps only the first; this keeps
 * them all, because one paper can key by its DOI on one row and by its PMID on
 * another (a PubMed URL plus a DOI in the box, beside a seeded PMID-only
 * record). Registration (#345 D2) refuses a new source that shares ANY of
 * these with a source already on its shelf. A source with no DOI or PMID has
 * none and matches nothing; its URL is the unique (organization_id, url)
 * constraint's business.
 */
export function publicationIdentifiers(source: PublicationKeySource): string[] {
  const identifiers = new Set<string>();
  for (const doi of doiCandidates(source)) if (doi !== null) identifiers.add(`doi:${normalizeDoi(doi)}`);
  for (const pmid of pmidCandidates(source)) if (pmid !== null) identifiers.add(`pmid:${pmid}`);
  return [...identifiers].sort();
}

// The SQL twin's pieces: the same places, in the same order, as
// doiCandidates() and pmidCandidates() above.
function candidateSql(alias: string): { url: string; doi: string[]; pmid: string[] } {
  const trim = (expr: string) => String.raw`nullif(regexp_replace(${expr}, '^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$', '', 'g'), '')`;
  // text() above: a JSON string, or a non-negative whole number up to 2^53-1;
  // else null. `json` is a jsonb expression.
  const jsonText = (json: string) => trim(`case jsonb_typeof(${json})
      when 'string' then ${json} #>> '{}'
      when 'number' then case when (${json})::numeric >= 0
        and (${json})::numeric = trunc((${json})::numeric)
        and (${json})::numeric <= 9007199254740991
        then trunc((${json})::numeric)::text end
    end`);
  const field = (key: string) => jsonText(`${alias}.metadata->'${key}'`);
  // provenanceIdOf() above. When provenance is not an object, -> yields null.
  const box = jsonText(`${alias}.metadata->'provenance'->'doi_or_pmid'`);
  const url = trim(`${alias}.url`);
  const kind = (k: string) =>
    `case when ${alias}.metadata->>'identifier_kind' = '${k}' then ${field('identifier')} end`;
  // JS's \s spelled out, and [0-9] for JS's \d: [:space:] and \d here follow
  // the database locale, JS's do not (a no-break space ended a DOI in JS and
  // not here).
  const doiRe = String.raw`'10\.[0-9]{4,9}/[^\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff;,\]"''<>]+'`;
  const digits = (expr: string) => String.raw`case when ${expr} ~ '^[0-9]+$' then ${expr} end`;
  const pubmedRe = String.raw`'(?i)^(?:https?://)?(?:pubmed\.ncbi\.nlm\.nih\.gov|(?:www\.)?ncbi\.nlm\.nih\.gov/pubmed)/([0-9]+)(?:[/?#]|$)'`;
  const pmidBoxRe = String.raw`'^(?:[Pp][Mm][Ii][Dd][ \t\n\r\f\v]*:?[ \t\n\r\f\v]*)?([0-9]+)$'`;
  return {
    url,
    doi: [
      `substring(${field('doi')} from ${doiRe})`,
      `substring(regexp_replace(${box}, '[?#].*$', '') from ${doiRe})`,
      `substring(${kind('doi')} from ${doiRe})`,
      `substring(regexp_replace(${url}, '[?#].*$', '') from ${doiRe})`,
    ],
    pmid: [
      digits(field('pmid')),
      `substring(${box} from ${pmidBoxRe})`,
      `substring(${box} from ${pubmedRe})`,
      digits(kind('pmid')),
      `substring(${url} from ${pubmedRe})`,
    ],
  };
}

// normalizeDoi() above.
const normalizeDoiSql = (expr: string) => `lower(regexp_replace(${expr}, '[.,;:]+$', ''))`;

/**
 * The same key as a SQL expression over `<alias>.url`, `<alias>.metadata` and
 * `<alias>.source_id`. Keep in step with publicationKey above.
 */
export function PUBLICATION_KEY_SQL(alias: string): string {
  const { url, doi: doiCandidates, pmid: pmidCandidates } = candidateSql(alias);
  const doi = normalizeDoiSql(`coalesce(
      ${doiCandidates.join(',\n      ')}
    )`);
  const pmid = `coalesce(
      ${pmidCandidates.join(',\n      ')}
    )`;
  const rest = String.raw`nullif(regexp_replace(regexp_replace(${url}, '#.*$', ''), '^[A-Za-z][A-Za-z0-9+.-]*://', ''), '')`;
  const host = `lower(substring(${rest} from '^[^/?]*'))`;
  const pathAndQuery = `substring(${rest} from length(${host}) + 1)`;
  const path = `regexp_replace(substring(${pathAndQuery} from '^[^?]*'), '/+$', '')`;
  const query = String.raw`array_to_string(array(
        select p from unnest(string_to_array(substring(${pathAndQuery} from '\?(.*)$'), '&')) as p
        where p <> '' and p !~* '^utm_[^=]*(=|$)'
      ), '&')`;
  const urlKey = String.raw`case when ${rest} is null then null else
      regexp_replace(${host}, '^www\.', '') || ${path} ||
      case when ${query} <> '' then '?' || ${query} else '' end end`;
  return `coalesce(
      'doi:' || ${doi},
      'pmid:' || ${pmid},
      'url:' || ${urlKey},
      'source:' || ${alias}.source_id
    )`;
}

/**
 * publicationIdentifiers() above as a SQL text[] over `<alias>.url` and
 * `<alias>.metadata`: every `doi:` and `pmid:` the row carries (it may repeat
 * one; compare as a set, e.g. with &&). Keep in step with
 * publicationIdentifiers: shadowLibraryCoverage.pg.test.ts compares them row
 * by row, beside the key.
 */
export function PUBLICATION_IDENTIFIERS_SQL(alias: string): string {
  const { doi, pmid } = candidateSql(alias);
  const elements = [
    ...doi.map((candidate) => `'doi:' || ${normalizeDoiSql(candidate)}`),
    ...pmid.map((candidate) => `'pmid:' || ${candidate}`),
  ];
  return `array_remove(array[
      ${elements.join(',\n      ')}
    ]::text[], null)`;
}
