"""Rebuilds proposal.csv from the 2026-08-07 seed sources and Europe PMC.

Read-only: reads the seed CSV and queries the public Europe PMC REST API
(one request per PMID/DOI, rate-limited). Writes proposal.csv and
lookups.json next to this file. Touches no database.

Rules (lane brief + overwatch GO, 2026-10-05):
  * The 21 internal_policy sources are already ppbf_owned (migration) and are skipped.
  * open_licence only where Europe PMC returns a Creative Commons licence for the
    exact identifier on the row, and the seed row is RESOLVED (not MISRESOLVED).
  * US federal government works (17 USC 105) -> open_licence, listed separately.
  * The Europe PMC record's title must match the seed title (>= 0.8 similarity).
  * Everything else stays unknown. Journal-level policy is never used.
"""
import csv, difflib, json, os, re, sys, time, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
SEED = os.path.join(ROOT, 'apps/web/seed-data/shadow-research/2026-08-07/seed_shadow_library_sources.csv')
CACHE = os.path.join(HERE, 'lookups.json')
API = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search'

# US federal hosts. State (.pa.gov, pacodeandbulletin.gov) is not covered by 17 USC 105.
FEDERAL_HOSTS = {
    'www.congress.gov': 'US Congress (congress.gov)',
    'www.federalregister.gov': 'Federal Register (Office of the Federal Register)',
    'stacks.cdc.gov': 'CDC Stacks (Centers for Disease Control and Prevention)',
    'www.epa.gov': 'US Environmental Protection Agency',
    'www.irs.gov': 'Internal Revenue Service',
    'www.ecfr.gov': 'eCFR (Office of the Federal Register)',
    'www.grants.gov': 'Grants.gov (US Department of Health and Human Services)',
}
HIGH = {'cc0', 'cc by', 'cc-by', 'cc by-sa', 'cc-by-sa'}


def same_title(a, b):
    n = lambda t: re.sub(r'[^a-z0-9]', '', (t or '').lower())
    return difflib.SequenceMatcher(None, n(a), n(b)).ratio() >= 0.8


def query_for(kind, ident):
    if kind == 'pmid':
        return f'EXT_ID:{ident} AND SRC:MED'
    if kind == 'doi':
        return f'DOI:"{ident}"'
    return None


def lookup(q, cache):
    if q in cache:
        return cache[q]
    url = API + '?' + urllib.parse.urlencode({'query': q, 'resultType': 'core', 'format': 'json', 'pageSize': 5})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                d = json.load(r)
            break
        except Exception as e:  # transient network errors: back off and retry
            if attempt == 3:
                raise
            time.sleep(2 * (attempt + 1))
    hits = [{k: h.get(k) for k in ('id', 'source', 'pmid', 'pmcid', 'doi', 'license', 'isOpenAccess', 'title')}
            for h in d.get('resultList', {}).get('result', [])]
    cache[q] = {'url': url, 'hits': hits}
    time.sleep(0.2)
    return cache[q]


def main():
    rows = list(csv.DictReader(open(SEED, encoding='utf-8', newline='')))
    cache = json.load(open(CACHE, encoding='utf-8')) if os.path.exists(CACHE) else {}
    out = []
    try:
        for i, x in enumerate(rows):
            if x['source_type'] == 'internal_policy':
                continue
            m = json.loads(x['metadata'] or '{}')
            kind, ident, vs = m.get('identifier_kind'), str(m.get('identifier', '')).strip(), m.get('verification_status')
            host = urllib.parse.urlparse(x['url']).netloc.lower()
            rights, ev, conf = 'unknown', '', 'n/a'
            if host in FEDERAL_HOSTS:
                rights, conf = 'open_licence', 'medium'
                ev = f'US federal government work, 17 USC 105; publisher host {host} = {FEDERAL_HOSTS[host]}; url {x["url"]}'
            elif vs == 'MISRESOLVED':
                ev = f'no evidence: seed identifier {kind}:{ident} is MISRESOLVED (points at a different work), licence not looked up'
            elif kind in ('pmid', 'doi') and ident:
                q = query_for(kind, ident)
                res = lookup(q, cache)
                match = [h for h in res['hits'] if (kind == 'pmid' and h.get('pmid') == ident)
                         or (kind == 'doi' and (h.get('doi') or '').lower() == ident.lower())]
                lic = sorted({(h.get('license') or '').strip().lower() for h in match} - {''})
                if not match:
                    ev = f'no evidence: Europe PMC returned no record for {kind}:{ident}; query {res["url"]}'
                elif not lic:
                    ev = f'no evidence: Europe PMC record for {kind}:{ident} carries no licence; query {res["url"]}'
                elif len(lic) > 1:
                    ev = f'no evidence: Europe PMC records for {kind}:{ident} disagree ({"; ".join(lic)}); query {res["url"]}'
                elif not same_title(match[0].get('title'), m.get('verified_title') or x['title']):
                    ev = (f'no evidence: Europe PMC record for {kind}:{ident} has a different title '
                          f'("{(match[0].get("title") or "")[:80]}"), so its licence may not apply to this source; query {res["url"]}')
                elif lic[0].startswith('cc'):
                    rights = 'open_licence'
                    conf = 'high' if lic[0] in HIGH else 'medium'
                    pmcid = next((h.get('pmcid') for h in match if h.get('pmcid')), '')
                    ev = f'Europe PMC license="{lic[0]}" for {kind}:{ident}{" ("+pmcid+")" if pmcid else ""}; query {res["url"]}'
                else:
                    ev = f'no evidence: Europe PMC licence "{lic[0]}" is not an open licence; query {res["url"]}'
            else:
                ev = f'no evidence: no licence in seed row, identifier kind {kind} ({vs}), not a US federal host'
            out.append({'source_id': x['source_id'], 'proposed_rights': rights, 'evidence': ev, 'confidence': conf})
            if i % 100 == 0:
                print(i, file=sys.stderr)
    finally:
        json.dump(cache, open(CACHE, 'w', encoding='utf-8', newline='\n'), indent=1, sort_keys=True)
    with open(os.path.join(HERE, 'proposal.csv'), 'w', encoding='utf-8', newline='') as f:
        w = csv.DictWriter(f, fieldnames=['source_id', 'proposed_rights', 'evidence', 'confidence'], lineterminator='\n')
        w.writeheader(); w.writerows(out)
    print(len(out), 'rows', file=sys.stderr)


if __name__ == '__main__':
    main()
