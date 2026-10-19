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
 * publicationKey() keys the claim path in JS; PUBLICATION_KEY_SQL() is the same
 * rule as a Postgres expression for capability coverage. They must agree:
 * shadowLibraryCoverage.pg.test.ts compares them row by row.
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

// A string, or a non-negative whole number (a PMID stored as a number). Any
// other JSON value -- object, array, boolean, fraction -- is absent, as in SQL.
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

function doiOf(source: PublicationKeySource): string | null {
  const meta = source.metadata ?? {};
  const url = text(source.url);
  const found =
    doiFrom(text(meta.doi)) ??
    doiFrom(meta.identifier_kind === 'doi' ? text(meta.identifier) : null) ??
    doiFrom(url ? url.replace(/[?#][\s\S]*$/, '') : null);
  return found ? found.replace(/[.,;:]+$/, '').toLowerCase() : null;
}

function digitsOnly(value: string | null): string | null {
  return value !== null && /^\d+$/.test(value) ? value : null;
}

function pmidOf(source: PublicationKeySource): string | null {
  const meta = source.metadata ?? {};
  const url = text(source.url);
  return (
    digitsOnly(text(meta.pmid)) ??
    digitsOnly(meta.identifier_kind === 'pmid' ? text(meta.identifier) : null) ??
    (url ? (PUBMED_URL_PATTERN.exec(url)?.[1] ?? null) : null)
  );
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
 * The same key as a SQL expression over `<alias>.url`, `<alias>.metadata` and
 * `<alias>.source_id`. Keep in step with publicationKey above.
 */
export function PUBLICATION_KEY_SQL(alias: string): string {
  const trim = (expr: string) => String.raw`nullif(regexp_replace(${expr}, '^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$', '', 'g'), '')`;
  // text() above: a JSON string, or a non-negative whole number; else null.
  const field = (key: string) => trim(`case jsonb_typeof(${alias}.metadata->'${key}')
      when 'string' then ${alias}.metadata->>'${key}'
      when 'number' then case when (${alias}.metadata->'${key}')::numeric >= 0
        and (${alias}.metadata->'${key}')::numeric = trunc((${alias}.metadata->'${key}')::numeric)
        then trunc((${alias}.metadata->'${key}')::numeric)::text end
    end`);
  const url = trim(`${alias}.url`);
  const kind = (k: string) =>
    `case when ${alias}.metadata->>'identifier_kind' = '${k}' then ${field('identifier')} end`;
  const doiRe = String.raw`'10\.\d{4,9}/[^[:space:];,\]"''<>]+'`;
  const doi = String.raw`lower(regexp_replace(coalesce(
      substring(${field('doi')} from ${doiRe}),
      substring(${kind('doi')} from ${doiRe}),
      substring(regexp_replace(${url}, '[?#].*$', '') from ${doiRe})
    ), '[.,;:]+$', ''))`;
  const digits = (expr: string) => String.raw`case when ${expr} ~ '^\d+$' then ${expr} end`;
  const pubmedRe = String.raw`'(?i)^(?:https?://)?(?:pubmed\.ncbi\.nlm\.nih\.gov|(?:www\.)?ncbi\.nlm\.nih\.gov/pubmed)/(\d+)(?:[/?#]|$)'`;
  const pmid = `coalesce(
      ${digits(field('pmid'))},
      ${digits(kind('pmid'))},
      substring(${url} from ${pubmedRe})
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
