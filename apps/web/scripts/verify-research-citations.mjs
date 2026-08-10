#!/usr/bin/env node
// verify-research-citations.mjs — machine verification that library citations resolve.
//
// Asks one mechanical question of every source in pilot.shadow_library_sources: does its
// identifier resolve, and does the record it resolves to match the title the row claims?
// Writes the answer to pilot.source_citation_checks. Never touches verification_state --
// that belongs to a human evidence reviewer, and a resolved identifier is not review.
//
// Run:
//   npm run verify:research-citations -- --dry-run
//   npm run verify:research-citations -- --limit 200
//   npm run verify:research-citations -- --csv path/to/registry.csv   (offline, no DB)
//
// CSV mode is the peer-review path: no database, no credentials, no infrastructure access.
// An outside reviewer points it at the published evidence registry and reproduces the check
// independently.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { parse } from 'csv-parse/sync';

const CHECKER_VERSION = 'citation-check/1.0.0';
const NCBI_ESUMMARY = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi';
const CROSSREF = 'https://api.crossref.org/works/';
const NCBI_BATCH = 150;
const NCBI_PAUSE_MS = 400; // NCBI asks for <=3 req/s without a key
const CROSSREF_PAUSE_MS = 120;
const TITLE_MATCH_THRESHOLD = 0.5;

// ---------------------------------------------------------------------------
// IDENTIFIER EXTRACTION
//
// THE BUG THIS FUNCTION EXISTS TO PREVENT. A naive PMID pattern of \b\d{7,8}\b run over a
// field that also holds DOIs harvests digits from INSIDE the DOI suffix. `10.1080/02640414.
// 2021.2001175` yields "2001175" -- a real but unrelated PubMed record. In the research
// program that produced the seeded corpus this produced 173 contaminated rows, 31 of which
// had no genuine PMID at all, and every one of them looked correct until re-resolution.
//
// So: strip DOIs FIRST, then look for PMIDs in what remains.
// ---------------------------------------------------------------------------
const DOI_RX = /10\.\d{4,9}\/[^\s;,\]"'<>]+/g;
const PMID_LABELLED_RX = /pmid[:\s]*(\d{7,8})/gi;
const PMID_BARE_RX = /\b(\d{7,8})\b/g;

export function extractIdentifiers(raw) {
  const text = String(raw ?? '');
  const dois = [...text.matchAll(DOI_RX)].map((m) => m[0].replace(/[.,;:)\]}'"]+$/, ''));

  // Remove every DOI from the string before looking for PMIDs.
  let residue = text;
  for (const d of dois) residue = residue.split(d).join(' ');

  const labelled = [...text.matchAll(PMID_LABELLED_RX)].map((m) => m[1]);
  const bare = [...residue.matchAll(PMID_BARE_RX)].map((m) => m[1]);
  const pmids = [...new Set([...labelled, ...bare])];

  return { pmids, dois: [...new Set(dois)] };
}

// ---------------------------------------------------------------------------
// TITLE MATCHING
//
// A boolean "resolved" is not enough: the DOI-fragment rows resolved perfectly well, just to
// the wrong article. We compare the retrieved title against the claimed one and store both.
//
// Author-year citation style ("Smith et al., 2021") shares few words with a paper's title, so
// low overlap alone is not evidence of a mismatch -- it is checked against author surname and
// year before anything is flagged.
// ---------------------------------------------------------------------------
const STOP = new Set(
  'the a an of and in on for to with by from at as is are was were this that which study trial '
    + 'effects effect between during using via among'.split(' '),
);

function contentWords(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP.has(w));
}

export function titleOverlap(claimed, retrieved) {
  const t = contentWords(retrieved);
  if (t.length === 0) return null;
  const c = new Set(contentWords(claimed));
  return t.filter((w) => c.has(w)).length / t.length;
}

export function authorYearMatch(claimed, authors, year) {
  const text = String(claimed ?? '').toLowerCase();
  const surnameHit = (authors ?? []).some((a) => {
    const surname = String(a).split(/[\s,]+/)[0]?.toLowerCase();
    return surname && surname.length > 2 && text.includes(surname);
  });
  // e-pub and issue years commonly differ by one; accept +/-1.
  const y = parseInt(year, 10);
  const yearHit = Number.isFinite(y) && [y - 1, y, y + 1].some((v) => text.includes(String(v)));
  return { surnameHit, yearHit };
}

// ---------------------------------------------------------------------------
// RESOLVERS
// A network failure is 'resolver_unavailable', never 'unresolved'. Reporting a rate limit as a
// bad citation would be a false accusation against the source, and would decay trust in the
// whole check.
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(45_000) });
  if (res.status === 429 || res.status >= 500) {
    const err = new Error(`transient ${res.status}`);
    err.transient = true;
    throw err;
  }
  if (!res.ok) return null; // 404 = genuinely unresolved
  return res.json();
}

export async function resolvePmids(pmids, { contactEmail } = {}) {
  const out = new Map();
  for (let i = 0; i < pmids.length; i += NCBI_BATCH) {
    const batch = pmids.slice(i, i + NCBI_BATCH);
    const qs = new URLSearchParams({ db: 'pubmed', id: batch.join(','), retmode: 'json' });
    qs.set('tool', 'ppbf-citation-check');
    if (contactEmail) qs.set('email', contactEmail);
    let payload = null;
    for (let attempt = 0; attempt < 3 && payload === null; attempt += 1) {
      try {
        payload = await fetchJson(`${NCBI_ESUMMARY}?${qs}`);
      } catch (err) {
        if (!err.transient || attempt === 2) {
          payload = undefined;
          break;
        }
        await sleep(2000 * (attempt + 1));
      }
    }
    const result = payload?.result ?? {};
    for (const pmid of batch) {
      const entry = result[pmid];
      if (payload === undefined) {
        out.set(pmid, { unavailable: true });
        continue;
      }
      if (!entry || entry.error) {
        out.set(pmid, null);
        continue;
      }
      out.set(pmid, {
        title: entry.title ?? '',
        year: String(entry.pubdate ?? '').slice(0, 4),
        container: entry.fulljournalname ?? entry.source ?? '',
        authors: (entry.authors ?? []).map((a) => a.name).slice(0, 3),
      });
    }
    await sleep(NCBI_PAUSE_MS);
  }
  return out;
}

export async function resolveDoi(doi, { contactEmail } = {}) {
  const headers = {
    'User-Agent': contactEmail
      ? `ppbf-citation-check/1.0 (mailto:${contactEmail})`
      : 'ppbf-citation-check/1.0',
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const payload = await fetchJson(CROSSREF + encodeURIComponent(doi), headers);
      if (payload === null) return null;
      const m = payload.message ?? {};
      return {
        title: (m.title ?? [''])[0] ?? '',
        year: String(m.issued?.['date-parts']?.[0]?.[0] ?? ''),
        container: (m['container-title'] ?? [''])[0] ?? '',
        authors: (m.author ?? []).map((a) => a.family).filter(Boolean).slice(0, 3),
      };
    } catch (err) {
      if (!err.transient || attempt === 2) return { unavailable: true };
      await sleep(2000 * (attempt + 1));
    }
  }
  return { unavailable: true };
}

// ---------------------------------------------------------------------------
// ADJUDICATION — one source row in, one check row out.
// ---------------------------------------------------------------------------
export function adjudicate({ claimedTitle, identifierKind, identifierValue, record }) {
  if (!record) {
    return {
      outcome: 'unresolved',
      matchMethod: 'none',
      detail: `${identifierKind} ${identifierValue} did not resolve`,
    };
  }
  if (record.unavailable) {
    return {
      outcome: 'resolver_unavailable',
      matchMethod: 'none',
      detail: 'resolver returned a transient error after retries; not a finding about the source',
    };
  }
  if (!record.title) {
    return {
      outcome: 'resolved_title_unknown',
      matchMethod: 'none',
      retrieved: record,
      detail: 'resolver returned no title to compare',
    };
  }
  const overlap = titleOverlap(claimedTitle, record.title);
  if (overlap !== null && overlap >= TITLE_MATCH_THRESHOLD) {
    return {
      outcome: 'resolved_title_match',
      matchMethod: 'title_overlap',
      matchScore: overlap,
      retrieved: record,
      detail: '',
    };
  }
  // Low overlap is expected for author-year citation style. Check that before flagging.
  const { surnameHit, yearHit } = authorYearMatch(claimedTitle, record.authors, record.year);
  if (surnameHit && yearHit) {
    return {
      outcome: 'resolved_title_match',
      matchMethod: 'author_year',
      matchScore: overlap,
      retrieved: record,
      detail: 'author-year citation style; matched on surname and year',
    };
  }
  return {
    outcome: 'resolved_title_mismatch',
    matchMethod: 'title_overlap',
    matchScore: overlap,
    retrieved: record,
    detail: 'claimed title does not match the record this identifier resolves to',
  };
}

// ---------------------------------------------------------------------------
// CSV MODE — the reproducibility path. No database, no credentials.
// ---------------------------------------------------------------------------
async function runCsv(csvPath, opts) {
  const rows = parse(readFileSync(csvPath, 'utf8'), { bom: true, columns: true, skip_empty_lines: true });
  const idField = ['doi_or_pmid', 'identifier', 'url'].find((f) => f in (rows[0] ?? {}));
  if (!idField) throw new Error('no identifier column found (expected doi_or_pmid)');

  const allPmids = new Set();
  for (const r of rows) for (const p of extractIdentifiers(r[idField]).pmids) allPmids.add(p);
  const pmidMap = await resolvePmids([...allPmids], opts);

  const tally = {};
  const findings = [];
  for (const r of rows) {
    const { pmids, dois } = extractIdentifiers(r[idField]);
    const claimed = r.citation ?? r.title ?? '';
    let verdict = { outcome: 'no_identifier', matchMethod: 'none', detail: '' };
    if (pmids.length) {
      verdict = adjudicate({
        claimedTitle: claimed,
        identifierKind: 'pmid',
        identifierValue: pmids[0],
        record: pmidMap.get(pmids[0]),
      });
    } else if (dois.length) {
      const rec = await resolveDoi(dois[0], opts);
      await sleep(CROSSREF_PAUSE_MS);
      verdict = adjudicate({ claimedTitle: claimed, identifierKind: 'doi', identifierValue: dois[0], record: rec });
    }
    tally[verdict.outcome] = (tally[verdict.outcome] ?? 0) + 1;
    if (verdict.outcome === 'resolved_title_mismatch' || verdict.outcome === 'unresolved') {
      findings.push({
        id: r.claim_id ?? r.source_id ?? '?',
        outcome: verdict.outcome,
        claimed: String(claimed).slice(0, 90),
        retrieved: String(verdict.retrieved?.title ?? '').slice(0, 90),
      });
    }
  }
  console.log(`\n${CHECKER_VERSION} — ${rows.length} rows\n`);
  for (const [k, v] of Object.entries(tally).sort()) console.log(`  ${k.padEnd(26)} ${v}`);
  if (findings.length) {
    console.log(`\nRows a human should adjudicate (${findings.length}):`);
    for (const f of findings) {
      console.log(`  [${f.id}] ${f.outcome}`);
      console.log(`      claimed:   ${f.claimed}`);
      console.log(`      resolved:  ${f.retrieved}`);
    }
  } else {
    console.log('\nNo mismatches or unresolved identifiers.');
  }
  return findings.length === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// DB MODE — reads pilot.v_sources_needing_citation_check, writes
// pilot.source_citation_checks. Requires `pg`; imported lazily so CSV mode needs no DB driver.
// ---------------------------------------------------------------------------
function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

async function runDb(opts) {
  const { Client } = await import('pg');
  const connectionString = process.env.AZURE_POSTGRES_CONNECTION_STRING?.trim();
  if (!connectionString) throw new Error('MISSING_AZURE_POSTGRES_CONNECTION_STRING');
  if (!opts.orgId) throw new Error('MISSING_PPBF_ORG_ID');

  // Guards against a repeat of the 2026-07-18 incident (see
  // apps/web/scripts/lib/postgres-write-target.mjs): this script writes rows, so it must
  // never run against a database the operator did not explicitly declare, dry-run or not --
  // a dry-run still reads real rows, and the flag that suppresses writes is trivially
  // forgotten on a rerun.
  const { assertDeclaredWriteTargetFromEnv } = await import('./lib/postgres-write-target.mjs');
  const target = assertDeclaredWriteTargetFromEnv(connectionString);

  const client = new Client({ connectionString, ssl: sslConfig() });
  await client.connect();
  try {
    console.log(`target_hostname: ${target.hostname}`);
    console.log(`target_database: ${target.database}`);

    const { rows } = await client.query(
      `select organization_id, source_id, title, url, metadata
         from pilot.v_sources_needing_citation_check
        where check_state <> 'current'
          and organization_id = $1
        limit $2`,
      [opts.orgId, opts.limit],
    );
    console.log(`${rows.length} sources need checking`);

    const idFor = (r) => `${r.metadata?.doi ?? ''} ${r.metadata?.pmid ?? ''} ${r.url ?? ''}`;
    const allPmids = new Set();
    for (const r of rows) for (const p of extractIdentifiers(idFor(r)).pmids) allPmids.add(p);
    const pmidMap = await resolvePmids([...allPmids], opts);

    let written = 0;
    for (const r of rows) {
      const { pmids, dois } = extractIdentifiers(idFor(r));
      let kind = 'none';
      let value = '';
      let resolver = 'not_attempted';
      let record = null;
      if (pmids.length) {
        kind = 'pmid';
        value = pmids[0];
        resolver = 'ncbi_eutils';
        record = pmidMap.get(value);
      } else if (dois.length) {
        kind = 'doi';
        value = dois[0];
        resolver = 'crossref';
        record = await resolveDoi(value, opts);
        await sleep(CROSSREF_PAUSE_MS);
      }
      const v = kind === 'none'
        ? {
          outcome: 'no_identifier',
          matchMethod: 'none',
          detail: 'no PMID or DOI on this source; governing-body, statute or internal document',
        }
        : adjudicate({ claimedTitle: r.title, identifierKind: kind, identifierValue: value, record });

      if (opts.dryRun) {
        console.log(`  [dry] ${r.source_id} ${v.outcome}`);
        continue;
      }
      await client.query(
        `insert into pilot.source_citation_checks
           (organization_id, check_id, source_id, identifier_kind, identifier_value, resolver,
            outcome, retrieved_title, retrieved_year, retrieved_container, match_method,
            match_score, checker_version, detail)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          r.organization_id, `chk_${randomUUID()}`, r.source_id, kind, value, resolver,
          v.outcome, v.retrieved?.title ?? null, v.retrieved?.year ?? null,
          v.retrieved?.container ?? null, v.matchMethod, v.matchScore ?? null,
          CHECKER_VERSION, v.detail,
        ],
      );
      written += 1;
    }
    console.log(`\nwrote ${written} check rows`);
    const { rows: sig } = await client.query(
      `select review_signal, count(*)::int as n from pilot.v_source_citation_status
        where organization_id = $1 group by review_signal order by review_signal`,
      [opts.orgId],
    );
    for (const s of sig) console.log(`  ${s.review_signal.padEnd(24)} ${s.n}`);
    return sig.some((s) => s.review_signal === 'needs_adjudication') ? 1 : 0;
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const flag = (name, dflt = null) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? dflt : (args[i + 1] ?? true);
  };
  const opts = {
    dryRun: args.includes('--dry-run'),
    limit: Number(flag('limit', 500)),
    orgId: flag('org', process.env.PPBF_ORG_ID),
    contactEmail: process.env.PPBF_CONTACT_EMAIL || null,
  };
  const csv = flag('csv');
  const code = csv ? await runCsv(csv, opts) : await runDb(opts);
  process.exit(code);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
