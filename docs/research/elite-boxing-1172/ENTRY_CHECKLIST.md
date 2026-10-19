# Issue #1172: elite-boxing sources, platform shelf entry checklist

Adults only. Nothing here is youth guidance (issue #1172).

## 1. What is already in the library

Of the 33 citations verified on issue #1172 (2026-10-04), **25 are already
registered** in the loadable seed `apps/web/seed-data/shadow-research/2026-08-07/seed_shadow_library_sources.csv`
and **8 are missing**. The row-by-row list, with seed `source_id`s, is in
[overlap.csv](overlap.csv).

How it was checked (2026-10-19, origin/main `75b4efa38b70fe3fd9a7a640abc316556997bfe8`): the same rule as the
F-136 publication key (`apps/web/src/server/pilot/shadowPublicationKey.ts`: DOI, else PMID, else URL).
Each DOI was searched in the seed sources file; each DOI was also resolved to its PMID with PubMed
esearch and matched to the seed's `pubmed.ncbi.nlm.nih.gov/<pmid>/` URLs. 16 matched by DOI, 9 by
PMID only. The 8 missing rows were also searched by title.

Not checked: production state. Production Postgres was unreachable from this PC on 2026-10-19
(connect timeout), so whether those 25 are approved and servable in production is **unknown**. The
seed only proves they are registered: every seed row ships as `pending_review` / `unverified`. The
`approve-library-baseline` dry-run in section 4 shows production state.

Correction to the issue: row 19 (Macnamara 2016 meta-analysis) **is** in the seed
(`src_6a5f99045eae8a7c`, PMID 27217246), not only the two commentaries.

## 2. Who does what

| Step | Who | Where |
|---|---|---|
| Register the 8 sources | Jason, signed in as **Admin@punxsyprominence.org** (platform owner) | www.punxsyprominence.org/research, General Research Intake |
| Approve them | Overwatch dispatches the `approve-library-baseline` workflow; Jason approves the production run in GitHub | GitHub Actions |
| Excerpts (later, optional) | Curator's choice, with page numbers | not part of this checklist |

Claude never enters credentials. The platform owner's `/research` page writes to the platform shelf
automatically. Before you start, check that the page shows the plaque "PLATFORM SHELF (EVERY GYM READS
THIS)". The form is under the **General Research** tab.

## 3. Register the 8 missing sources

For each row, fill in **Title**, **Source type**, **Classification domain**, **URL** and **DOI / PMID**,
leave Provider and Original filename blank, then press **Register general research**.

**Use the URL exactly as written.** The library tells papers apart by the URL, not by the DOI / PMID box
(the form stores that box as provenance, which the F-136 key does not read). A `doi.org` URL keys the
row by its DOI, so SHADOW's evidence count treats it as the same paper as any other copy with that DOI.

If the form says "This URL is already registered as …", stop on that row and note it: that exact URL
is already on the shelf. The form checks only the exact URL, not the DOI. Section 1 is the DOI/PMID
duplicate check.

| # | Title | Source type | Classification domain | URL | DOI / PMID | Intended rights |
|---|---|---|---|---|---|---|
| 4 | Physiological profile of senior and junior England international amateur boxers | peer reviewed | Boxing and athlete development | https://www.jssm.org/jssm-05-CSSI1-74.xml-Fulltext | *(blank: no DOI)* | licensed_excerpt_only |
| 5 | A new approach to monitoring exercise training | peer reviewed | Measurement and assessment instruments | https://doi.org/10.1519/00124278-200102000-00019 | 10.1519/00124278-200102000-00019 | licensed_excerpt_only |
| 13 | Strength and power qualities are highly associated with punching impact in elite amateur boxers | peer reviewed | Strength, conditioning, nutrition, recovery | https://doi.org/10.1519/JSC.0000000000001075 | 10.1519/JSC.0000000000001075 | licensed_excerpt_only |
| 14 | Compatibility of concurrent aerobic and strength training for skeletal muscle size and function: an updated systematic review and meta-analysis | peer reviewed | Strength, conditioning, nutrition, recovery | https://doi.org/10.1007/s40279-021-01587-7 | 10.1007/s40279-021-01587-7 | **open_licence** |
| 17 | Participant development in sport: an academic review | governing body | Boxing and athlete development | https://research.birmingham.ac.uk/en/publications/participant-development-in-sport-an-academic-review | *(blank: no DOI)* | licensed_excerpt_only |
| 27 | Sleep interventions designed to improve athletic performance and recovery: a systematic review of current approaches | peer reviewed | Strength, conditioning, nutrition, recovery | https://doi.org/10.1007/s40279-017-0832-x | 10.1007/s40279-017-0832-x | licensed_excerpt_only |
| 28 | Sleep hygiene for optimizing recovery in athletes: review and recommendations | peer reviewed | Strength, conditioning, nutrition, recovery | https://doi.org/10.1055/a-0905-3103 | 10.1055/a-0905-3103 | licensed_excerpt_only |
| 32 | *(optional)* The efficacy of psychological skills training for enhancing performance in sport: a review of reviews | peer reviewed | Learning science and skill acquisition | https://doi.org/10.1080/1612197X.2023.2168725 | 10.1080/1612197X.2023.2168725 | licensed_excerpt_only |

Row 32's title is from Crossref; the publisher's page returned 403. It is optional: skip it if you like.

Row notes:
- **4**: the paper includes junior-squad data. Use adult excerpts only.
- **17**: a Sports Coach UK commissioned report, so it goes in as *governing body*. It shares row 16's
  youth caveat: use it only for adult-pathway reasoning.

### Rights

No screen on main sets a source's rights marker, so every source registered through this form
lands at `unknown`. The API has a rights PATCH (`app/api/pilot/shadow/library/sources/route.ts`), but
no screen calls it. `unknown` and `licensed_excerpt_only` behave the same way:
- the library refuses full text and accepts excerpts that say where they come from
  (`apps/web/src/server/pilot/shadowLibraryRights.ts`);
- SHADOW cites the source **by title only** and shows no passage text, because passage display needs
  `ppbf_owned` or `open_licence` (`PASSAGE_DISPLAY_RIGHTS`, `apps/web/src/server/pilot/shadowEvidence.ts`).

So only row 14 behaves differently once it is marked `open_licence`: then its passages can be shown.
The "Intended rights" column records the value each row should carry once a control exists:

- **14**: open_licence. The Springer article page states the Creative Commons Attribution 4.0
  International License (read 2026-10-19).
- **4**: the JSSM footer says "all rights reserved … without previous written permission" and also
  shows a CC BY-NC-ND badge. It is site-wide and contradicts itself, so the row stays excerpt only.
- **32**: the publisher's page could not be read (403), so the row stays excerpt only. Whether NC/ND
  licences count as open_licence is still open (`docs/research/library-rights-proposal-2026-10-05/SUMMARY.md` section B).
- **5, 13, 27, 28, 17**: no open licence was seen. Free repository copies (27, 28) are free to read, not
  licensed to store.

No full text of any paywalled paper is entered.

## 4. Approval (Overwatch)

Workflow `approve-library-baseline` (`.github/workflows/approve-library-baseline.yml`):

1. **Dry-run first:** target `production`, confirm_target `production`, mode `dry-run`,
   organization_id blank (this means `__platform__`).
2. **Before apply, check the dry-run for other pending rows.** Apply approves *every* pending
   `__platform__` source and document in one transaction, not only these 8. The plan lists pending
   rows that are not from the seed corpus by name, with an uncapped count beside them
   (`apps/web/scripts/pilot-approve-library-baseline.mjs`). Expect that count to be 8, or 7 if row 32
   was skipped, and those names. If anything else is pending, stop and decide on it first.
3. **Apply:** the same inputs with mode `apply` and confirm_approval `APPROVE EVIDENCE`. Jason approves
   the production run in GitHub.

A registered source with no excerpts has nothing for SHADOW to cite. Approval makes the source
eligible, and excerpts with page numbers are what make it citable (by title, under the rights note in
section 3).

## 5. Done when

All 8 rows (7 if row 32 is skipped) are on the platform shelf and approved, and the 25 overlaps are
recorded in [overlap.csv](overlap.csv) as already in the library.
