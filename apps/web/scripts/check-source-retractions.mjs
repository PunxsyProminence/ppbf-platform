#!/usr/bin/env node
// check-source-retractions.mjs — standing surveillance for retracted and corrected sources.
//
// A citation check asks "does this identifier point where it claims". This asks "is the thing it
// points at still standing". Different questions: a citation that resolves correctly today
// resolves just as correctly the day after the paper is withdrawn.
//
// This is worthless as a one-off. Run it on a schedule -- the recheck interval is 90 days and the
// work queue (pilot.v_sources_needing_retraction_check) enforces it. The failure mode it exists to
// prevent is silent: a source is approved, cited in coaching guidance, retracted two years later,
// and nothing ever asks again.
//
// Run:
//   npm run check:retractions -- --dry-run
//   npm run check:retractions -- --limit 300
//   npm run check:retractions -- --csv path/to/evidence_registry.csv     (offline reviewer path)
//
// This script never suppresses, deletes, or downgrades anything. It only raises findings into
// pilot.source_retraction_checks; disposing of one (including setting retrieval_suppressed on the
// source) is a human decision recorded through sourceRetractionChecks.ts.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { parse } from 'csv-parse/sync';

const CHECKER_VERSION = 'retraction-check/1.0.0';
const NCBI_ESUMMARY = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi';
const CROSSREF = 'https://api.crossref.org/works/';
const NCBI_BATCH = 150;
const NCBI_PAUSE_MS = 400;
const CROSSREF_PAUSE_MS = 120;

// Shares the identifier extractor with the citation checker, including the DOI-fragment guard:
// a bare DOI must never yield a PMID. See verify-research-citations.mjs for why that matters.
const DOI_RX = /10\.\d{4,9}\/[^\s;,\]"'<>]+/g;
const PMID_LABELLED_RX = /pmid[:\s]*(\d{7,8})/gi;
const PMID_BARE_RX = /\b(\d{7,8})\b/g;

export function extractIdentifiers(raw) {
  const text = String(raw ?? '');
  const dois = [...text.matchAll(DOI_RX)].map((m) => m[0].replace(/[.,;:)\]}'"]+$/, ''));
  let residue = text;
  for (const d of dois) residue = residue.split(d).join(' ');
  const labelled = [...text.matchAll(PMID_LABELLED_RX)].map((m) => m[1]);
  const bare = [...residue.matchAll(PMID_BARE_RX)].map((m) => m[1]);
  return { pmids: [...new Set([...labelled, ...bare])], dois: [...new Set(dois)] };
}

// ---------------------------------------------------------------------------
// DETECTION
//
// PubMed marks a retracted record in esummary `pubtype`. Verified against PMID 9500320
// (Wakefield 1998), which returns ['Journal Article', "Research Support, Non-U.S. Gov't",
// 'Retracted Publication'].
// ---------------------------------------------------------------------------
const PUBTYPE_MAP = [
  ['retracted publication', 'retracted'],
  ['retraction of publication', 'retracted'],
  ['expression of concern', 'expression_of_concern'],
  ['withdrawn publication', 'withdrawn'],
  ['published erratum', 'corrected'],
];

export function classifyPubtypes(pubtypes) {
  const lowered = (pubtypes ?? []).map((p) => String(p).toLowerCase());
  for (const [needle, status] of PUBTYPE_MAP) {
    const hit = lowered.find((p) => p.includes(needle));
    if (hit) return { status, evidence: `pubtype: ${hit}` };
  }
  return { status: 'clear', evidence: '' };
}

// Crossref carries Retraction Watch data in `updated-by`. Verified against
// 10.1016/S0140-6736(97)11096-0, which returns entries of type 'correction' and 'retraction'
// with source 'retraction-watch'.
const UPDATE_TYPE_MAP = {
  retraction: 'retracted',
  withdrawal: 'withdrawn',
  expression_of_concern: 'expression_of_concern',
  'expression-of-concern': 'expression_of_concern',
  correction: 'corrected',
  erratum: 'corrected',
  addendum: 'corrected',
};
// Ordered worst-first: a work with both a correction and a retraction is retracted.
const SEVERITY = ['retracted', 'withdrawn', 'expression_of_concern', 'corrected', 'clear'];

export function classifyCrossrefUpdates(updatedBy) {
  let worst = 'clear';
  let notice = null;
  for (const u of updatedBy ?? []) {
    const mapped = UPDATE_TYPE_MAP[String(u.type ?? '').toLowerCase()];
    if (!mapped) continue;
    if (SEVERITY.indexOf(mapped) < SEVERITY.indexOf(worst)) {
      worst = mapped;
      notice = u;
    }
  }
  if (worst === 'clear') return { status: 'clear', evidence: '' };
  const dp = notice?.updated?.['date-parts']?.[0] ?? [];
  return {
    status: worst,
    evidence: `crossref updated-by: type=${notice?.type} source=${notice?.source} label=${notice?.label ?? ''}`,
    noticeType: notice?.type ?? null,
    noticeDoi: notice?.DOI ?? null,
    noticeSource: notice?.source ?? null,
    noticeDate: dp.length >= 3
      ? `${dp[0]}-${String(dp[1]).padStart(2, '0')}-${String(dp[2]).padStart(2, '0')}`
      : null,
  };
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(45_000) });
  if (res.status === 429 || res.status >= 500) {
    const e = new Error(`transient ${res.status}`);
    e.transient = true;
    throw e;
  }
  if (!res.ok) return null;
  return res.json();
}

export async function checkPmids(pmids, { contactEmail } = {}) {
  const out = new Map();
  for (let i = 0; i < pmids.length; i += NCBI_BATCH) {
    const batch = pmids.slice(i, i + NCBI_BATCH);
    const qs = new URLSearchParams({ db: 'pubmed', id: batch.join(','), retmode: 'json' });
    qs.set('tool', 'ppbf-retraction-check');
    if (contactEmail) qs.set('email', contactEmail);
    let payload = null;
    for (let a = 0; a < 3 && payload === null; a += 1) {
      try {
        payload = await fetchJson(`${NCBI_ESUMMARY}?${qs}`);
      } catch (err) {
        if (!err.transient || a === 2) {
          payload = undefined;
          break;
        }
        await sleep(2000 * (a + 1));
      }
    }
    const result = payload?.result ?? {};
    for (const pmid of batch) {
      if (payload === undefined) {
        out.set(pmid, { status: 'resolver_unavailable', evidence: '' });
        continue;
      }
      const entry = result[pmid];
      if (!entry || entry.error) {
        out.set(pmid, { status: 'clear', evidence: 'record not found; no retraction asserted' });
        continue;
      }
      out.set(pmid, classifyPubtypes(entry.pubtype));
    }
    await sleep(NCBI_PAUSE_MS);
  }
  return out;
}

export async function checkDoi(doi, { contactEmail } = {}) {
  const headers = {
    'User-Agent': contactEmail
      ? `ppbf-retraction-check/1.0 (mailto:${contactEmail})`
      : 'ppbf-retraction-check/1.0',
  };
  for (let a = 0; a < 3; a += 1) {
    try {
      const payload = await fetchJson(CROSSREF + encodeURIComponent(doi), headers);
      if (payload === null) return { status: 'clear', evidence: 'DOI not in Crossref; no retraction asserted' };
      return classifyCrossrefUpdates(payload.message?.['updated-by']);
    } catch (err) {
      if (!err.transient || a === 2) return { status: 'resolver_unavailable', evidence: '' };
      await sleep(2000 * (a + 1));
    }
  }
  return { status: 'resolver_unavailable', evidence: '' };
}

// ---------------------------------------------------------------------------
async function runCsv(csvPath, opts) {
  const rows = parse(readFileSync(csvPath, 'utf8'), { bom: true, columns: true, skip_empty_lines: true });
  const idField = ['doi_or_pmid', 'identifier', 'url'].find((f) => f in (rows[0] ?? {}));
  if (!idField) throw new Error('no identifier column found (expected doi_or_pmid)');

  const allPmids = new Set();
  for (const r of rows) for (const p of extractIdentifiers(r[idField]).pmids) allPmids.add(p);
  const pmidMap = await checkPmids([...allPmids], opts);

  const tally = {};
  const hits = [];
  for (const r of rows) {
    const { pmids, dois } = extractIdentifiers(r[idField]);
    let v = { status: 'not_checkable', evidence: '' };
    if (pmids.length) v = pmidMap.get(pmids[0]) ?? v;
    else if (dois.length) {
      v = await checkDoi(dois[0], opts);
      await sleep(CROSSREF_PAUSE_MS);
    }
    tally[v.status] = (tally[v.status] ?? 0) + 1;
    if (['retracted', 'withdrawn', 'expression_of_concern', 'corrected'].includes(v.status)) {
      hits.push({
        id: r.claim_id ?? r.source_id ?? '?',
        status: v.status,
        evidence: v.evidence,
        cite: String(r.citation ?? '').slice(0, 90),
      });
    }
  }
  console.log(`\n${CHECKER_VERSION} — ${rows.length} rows\n`);
  for (const [k, v] of Object.entries(tally).sort()) console.log(`  ${k.padEnd(24)} ${v}`);
  if (hits.length) {
    console.log(`\nSources with a retraction, concern or correction (${hits.length}):`);
    for (const h of hits) {
      console.log(`  [${h.id}] ${h.status.toUpperCase()}`);
      console.log(`      ${h.cite}`);
      console.log(`      ${h.evidence}`);
    }
  } else {
    console.log('\nNo retractions, concerns or corrections found.');
  }
  // Only a retraction or withdrawal is an error condition; a correction is informational.
  return hits.some((h) => h.status === 'retracted' || h.status === 'withdrawn') ? 1 : 0;
}

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

async function runDb(opts) {
  const { Client } = await import('pg');
  const connectionString = process.env.AZURE_POSTGRES_CONNECTION_STRING?.trim();
  if (!connectionString) throw new Error('MISSING_AZURE_POSTGRES_CONNECTION_STRING');
  if (!opts.orgId) throw new Error('MISSING_PPBF_ORG_ID');

  // Same production-safety guard as verify-research-citations.mjs: this script writes rows to
  // pilot.source_retraction_checks, so it must never run against a database the operator did not
  // explicitly declare. See apps/web/scripts/lib/postgres-write-target.mjs.
  const { assertDeclaredWriteTargetFromEnv } = await import('./lib/postgres-write-target.mjs');
  const target = assertDeclaredWriteTargetFromEnv(connectionString);

  const client = new Client({ connectionString, ssl: sslConfig() });
  await client.connect();
  try {
    console.log(`target_hostname: ${target.hostname}`);
    console.log(`target_database: ${target.database}`);

    const { rows } = await client.query(
      `select organization_id, source_id, title, url, metadata
         from pilot.v_sources_needing_retraction_check
        where check_state <> 'current' and organization_id = $1
        limit $2`,
      [opts.orgId, opts.limit],
    );
    console.log(`${rows.length} sources due for retraction check`);

    const idFor = (r) => `${r.metadata?.doi ?? ''} ${r.metadata?.pmid ?? ''} ${r.url ?? ''}`;
    const allPmids = new Set();
    for (const r of rows) for (const p of extractIdentifiers(idFor(r)).pmids) allPmids.add(p);
    const pmidMap = await checkPmids([...allPmids], opts);

    let written = 0;
    for (const r of rows) {
      const { pmids, dois } = extractIdentifiers(idFor(r));
      let kind = 'none';
      let value = '';
      let resolver = 'not_attempted';
      let v = { status: 'not_checkable', evidence: 'no PMID or DOI; not surveillable' };
      if (pmids.length) {
        kind = 'pmid';
        value = pmids[0];
        resolver = 'ncbi_eutils';
        v = pmidMap.get(value) ?? v;
      } else if (dois.length) {
        kind = 'doi';
        value = dois[0];
        resolver = 'crossref';
        v = await checkDoi(value, opts);
        await sleep(CROSSREF_PAUSE_MS);
      }

      if (opts.dryRun) {
        console.log(`  [dry] ${r.source_id} ${v.status}`);
        continue;
      }
      await client.query(
        `insert into pilot.source_retraction_checks
           (organization_id, retraction_check_id, source_id, identifier_kind, identifier_value,
            resolver, status, notice_type, notice_doi, notice_date, notice_source,
            evidence_snippet, checker_version)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          r.organization_id, `rtc_${randomUUID()}`, r.source_id, kind, value, resolver,
          v.status, v.noticeType ?? null, v.noticeDoi ?? null, v.noticeDate ?? null,
          v.noticeSource ?? null, v.evidence ?? '', CHECKER_VERSION,
        ],
      );
      written += 1;
    }
    console.log(`\nwrote ${written} check rows`);

    // A retracted source still live in the library is the finding that matters.
    const { rows: urgent } = await client.query(
      `select source_id, title, status, dependent_chunks
         from pilot.v_source_retraction_status
        where organization_id = $1 and action_signal = 'urgent_unhandled'`,
      [opts.orgId],
    );
    if (urgent.length) {
      console.log(`\nURGENT — retracted or withdrawn sources still live (${urgent.length}):`);
      for (const u of urgent) {
        console.log(`  ${u.source_id}  ${u.status}  ${u.dependent_chunks} dependent chunks`);
        console.log(`     ${String(u.title).slice(0, 100)}`);
      }
      console.log('\nThese require a human disposition. The script does not suppress or delete anything.');
    }
    return urgent.length ? 1 : 0;
  } finally {
    await client.end();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (n, d = null) => {
    const i = args.indexOf(`--${n}`);
    return i === -1 ? d : (args[i + 1] ?? true);
  };
  const opts = {
    dryRun: args.includes('--dry-run'),
    limit: Number(flag('limit', 500)),
    orgId: flag('org', process.env.PPBF_ORG_ID),
    contactEmail: process.env.PPBF_CONTACT_EMAIL || null,
  };
  const csv = flag('csv');
  process.exit(csv ? await runCsv(csv, opts) : await runDb(opts));
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
