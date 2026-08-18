# Pass 16 — Research, data library & evidence governance

Branch `docs/full-spectrum-audit-2026-08-18`, pinned to `origin/main` at `04dd116b`.
Read-only pass. This file is the only write.

This pass audits the machinery by which a claim is supposed to *earn* authority in
this codebase: the research workspace, the source-submission lifecycle, the SHADOW
Library's approval gate, the evidence registry, and everything that presents a
"finding", "pattern", "coverage" or "evidence" to a human.

The headline is mixed and both halves matter. **The retrieval gate is real** — I
tried hard to get an unapproved source into a citation and could not. **The
approval gate that feeds it is a single button with nothing behind it**, and two
surfaces present graded evidence without passing through the codebase's own
quality rule.

---

## Method

- Read `AGENT_KERNEL.md`; `docs/capabilities/NETWORK_STATUS.md` and
  `docs/HANDOFF_RESEARCH.md` from `origin/docs/agent-handoff-briefs` (neither is on
  `main` — the citation in this directory's README still does not resolve on `main`,
  as the log already records); `docs/RESEARCH_EVIDENCE_REGISTRY.md`.
- Traced the source lifecycle end to end at the SQL level: DDL → domain module →
  route → page, for `shadow_library_sources`, `shadow_library_documents`,
  `shadow_library_chunks`, `shadow_research_requirements`,
  `shadow_research_submissions`, `assessment_protocols`,
  `data_collection_requests`, `source_citation_checks`, `source_retraction_checks`.
- Enumerated every writer of `pilot.shadow_events` (there is exactly one) and every
  literal event name in the tree, to test the Knowledge Graph claim independently.
- Enumerated callers of every read function in the research/evidence modules, to
  separate "built" from "reachable".
- **No code was run.** There is no database in this session. Every finding below is
  a source-level finding; where runtime behaviour is the claim I say so and mark it
  as unverified at runtime rather than asserting it.
- De-duplicated against `NETWORK_STATUS.md`, `PASS-02`, `PASS-04`,
  `PASS-03`/`PASS-10` (running), and `git log --oneline origin/main -40`. Overlaps
  with Pass 7 (fabricated-data disclosure), Pass 9 (formulas) and Pass 15 (egress)
  are flagged inline rather than silently claimed as new.
- Every finding was attacked before being written. Three candidate findings were
  **dropped on refutation** and are recorded in *Checked and found sound* so the
  next reader does not re-find them.

---

## The source lifecycle as built

Each transition, and what is actually enforced at it.

| # | Transition | Who may | What is enforced | What is not |
|---|---|---|---|---|
| 1 | **Register a source** (`POST /api/pilot/shadow/library/sources`) | `SHADOW_LIBRARY_CURATOR_ROLES` = `organization_admin`, `admin`, `platform_owner` | Source type must be a union member; `authority_tier` 1–5 rejected rather than clamped; `publication_date` must be ISO; `classification_domain` held to the shared 14-domain taxonomy; unique `(organization_id, url)` | Nothing about the source being real. No URL reachability, no DOI resolution, no duplicate-title check. `approval_state` is **not** settable from the route — it takes the DDL default |
| 2 | **Land unapproved** (DDL) | — | `approval_state text not null default 'pending_review'`, `verification_state … default 'unverified'`, plus a DB `review_pair_check` that makes `approved` impossible without `verified` **and** both attributions **and** both timestamps | — |
| 3 | **Add a document + chunks** | curator roles; `assertActorCanAccessAthlete` for a `subject_id` document | Same pending defaults; document approval additionally requires `ingest_state = 'indexed'` and `index_completed_at is not null`, enforced in both the DDL constraint and the `UPDATE`'s own `WHERE` | — |
| 4 | **Approve + verify** (`PATCH /api/pilot/shadow/evidence/review`) | `organization_admin`, `admin`, `platform_owner` (`requireEvidenceReviewer`) | Role. That is the whole check | Everything else. See **[HIGH] H-1** |
| 5 | **Become citable** (`searchShadowLibrary`) | any `SHADOW_PROJECTION_READ_ROLES` reader | Seven predicates on two tables, restated identically in the keyword query, the semantic query, and `hasRetrievableLibraryEvidence`: source `active` + `approved` + `verified` + not `retrieval_suppressed`; document `indexed` + `index_completed_at` + `approved` + `verified` | — this one is sound |
| 6 | **Submit a source against a requirement** (`POST /shadow/research-submissions`) | curator roles | Org-scoped existence of requirement, source and document, each collapsing "absent" and "another gym's" into one `hiddenNotFound`; row starts `applicability_state 'unreviewed'`; duplicate `(org, requirement, source)` refused by name | The source need not be approved — deliberate, and the UI says so |
| 7 | **Review applicability** (`PATCH` same route) | curator roles | Verdict must not be `unreviewed` ("Un-reviewing is not a verdict"); DB `review_attribution` constraint forces reviewer + timestamp to arrive with the verdict | The source need not be approved to be marked ✓ Responsive — again deliberate and disclosed |
| 8 | **Resolve the requirement** (`POST /shadow/research-requirements` `action:'resolve'`) | **`ORGANIZATION_MEMBER_ROLES` — including `athlete`, `parent`, `volunteer`, `staff`** | For a `parent`, athlete scope. For everyone else: nothing | No evidence needed, no submission needed, no review needed. See **[HIGH] H-4** |

**The NETWORK_STATUS claim, verified independently.** "Submission never resolves a
requirement, structurally" is **true**. The migration says so:

> `--   * A submission NEVER resolves a requirement. There is no trigger, no`
> `--     status write-through, no path from this table to`
> `--     shadow_research_requirements.status. Resolution remains the existing`
> `--     human act on the requirement row itself.`
> — `infra/azure/pilot_slice_postgres_shadow_research_submissions_migration.sql:13-16`

and the code holds it. `grep` for `trigger` in that migration returns only that
comment; there is exactly **one** `update pilot.shadow_research_requirements` in
the entire tree, at `apps/web/src/server/pilot/shadowResearch.ts:136`, inside
`resolveShadowResearchRequirement`. The ladder is architecturally incapable of
`resolved`:

> `  if (requirementStatus === 'resolved') return 'resolved';`
> — `apps/web/src/server/pilot/shadowResearchSubmissions.ts:191`

That rung reads the requirement's own status and nothing else. The claim is
confirmed. **What the claim does not say, and what this pass adds, is that the
human act it defers to is ungated** — see H-4. The architecture protects the
ladder from a PDF and then hands the pen to anyone in the building.

---

## What can be cited as evidence, and what stands in the way

**Path A — SHADOW chat citations.** Gated properly. `buildEvidenceBundle` →
`searchShadowLibrary` with the seven-predicate retrieval gate, then
`deriveEvidenceTier` applies a quality rule with two written invariants. The
unavailable case fails closed with model-facing boundary text
(`shadowEvidence.ts:58-60`) and distinguishes an empty library from a broken
lookup. Nothing gets in here that a reviewer did not approve.

**Path B — The Library Q&A (`/research/chat`).** Same retrieval gate, **different
grading**. `createShadowLibraryClaim` grades by counting, not by quality, and the
citation display drops the quality fields it was handed. See **[HIGH] H-2**.

**Path C — Capability coverage.** `recomputeShadowCapabilityCoverage` decides
whether a capability is `covered` by counting sources with **no approval predicate
at all**. See **[HIGH] H-3**.

**Path D — Intervention evidence.** `EVIDENCE_SOURCES.film_study` links a Film
Study proposal by `(org, proposal_id, athlete_id)` with no `review_state` check —
the already-known "a REJECTED proposal is citable" finding, still present on
`main`, fixed on an open PR. I went looking for the same shape in the other four
kinds and **did not find it**; see *Checked and found sound*.

**Path E — Rabbit-hole lessons.** Exemplary. The migration explains at length why
it uses no foreign key and re-checks the full seven-column approval predicate on
every read, and `rabbitHoles.ts:218-229` does exactly that.

**Path F — Research-bridge export.** Filters approved + verified but **not**
`retrieval_suppressed`. A retracted source keeps being exported. See M-4.

**What stands between a source and citability, in total:** one role check and one
button. There is no automated check of any kind in the approval path — not the
citation resolver that exists, not the retraction check that exists, not a second
reviewer, not a quorum. The DB constraint is the strongest thing in the chain, and
what it constrains is the *shape* of the attestation, not its content.

---

## UI claims vs. implemented behaviour

| # | Claim, verbatim, with `path:line` | Implementing code, or absent |
|---|---|---|
| 1 | "Registering a source does NOT make it citable. Rows land on `approval_state='pending_review'` / `verification_state='unverified'`" — `apps/web/app/api/pilot/shadow/library/sources/route.ts:22-23` | **Implemented.** `createShadowLibrarySource` (`shadowLibrary.ts:462-466`) omits both columns from its `INSERT`; the DDL defaults them (`pilot_slice_postgres_shadow_evidence_migration.sql:7-8`) |
| 2 | "Source registered and classified. Evidence review still decides what becomes citable." — `apps/web/app/research/page.tsx:249` | **Implemented**, per row 1 |
| 3 | "Source submitted. It answers nothing until evidence review says so." — `apps/web/app/research/page.tsx:310` | **Implemented** for citability; **not** for the requirement's own `status`, which any org member can flip to `resolved` regardless (H-4) |
| 4 | "A general source becomes linkable to a requirement later through Answer a Gap, and citable only through evidence review." — `apps/web/app/research/page.tsx:733-734` | **Implemented** |
| 5 | "Only approved, verified, fully indexed documents can support SHADOW citations." — `apps/web/app/evidence/page.tsx:132` | **Implemented** in retrieval (`shadowLibrary.ts:1161-1168`). But the same page's own button is `'Approve + verify'` (`page.tsx:111`) — one control for both states, and the route derives one from the other (H-1) |
| 6 | "A submission never resolves a requirement by itself" — `apps/web/app/research/review/page.tsx:229-231` | **Implemented.** Verified above |
| 7 | "Run front-end what-if scenarios to evaluate expected outcomes and risk before audit and promotion stages." — `apps/web/app/simulator/page.tsx:84` | **Absent.** `/simulator` is a server component with no state, no form, no fetch and no handler. The seven scenarios are a module-level `const scenarios = [...]` (`page.tsx:5-55`). Nothing runs. Partial disclosure exists as one plaque: `{ label: 'Engine', value: 'Front-end Only' }` (`page.tsx:70`) |
| 8 | "Validated scenarios feed into Audit Trace for governance visibility before Source Control promotion." — `apps/web/app/simulator/page.tsx:152` | **Absent, and unqualified.** `grep -rn "scenario" apps/web/src/server infra/azure` returns exactly one hit, an unrelated comment in `auth.ts:654`. There is no scenario table, no scenario route, no writer, no reader. This sentence carries no disclosure of its own |
| 9 | "Shows how cards would move through Draft, Review, Approved, Published, and Archived states before ecosystem release. Every card, version, and count on this page is a sample, not live promotion state." — `apps/web/app/source-control/page.tsx:98` | **Honestly declared.** The page also carries `stamp stamp--brass` reading `'PLANNED \| FRONT-END PLACEHOLDER \| NOT YET AUTOMATED \| BACKEND REQUIRED'` (`page.tsx:5, 96`) and "Mock destination routing only." (`page.tsx:181`). This **partly refutes** NETWORK_STATUS's "islands … whose own copy claims hand-offs that no code implements": Source Control declares itself, Scenario Simulation does not |
| 10 | "Required source types: any verified source type" — `apps/web/src/server/pilot/shadowLibrary.ts:360`, rendered into the knowledge-gap text an admin reads on `/research` | **Contradicted by the query that produces the number.** The coverage count filters `s.status = 'active'` and authority tier only (`shadowLibrary.ts:1383-1388`) — no `approval_state`, no `verification_state`, no `retrieval_suppressed` (H-3) |
| 11 | "SHADOW v21.1 seed is ingested, stress-validated, and sealed for development deployment." under the heading "System Diagnostics and SHADOW Certification" → "Mathematical Gate Validation", over the LEGACY-READINESS equation — `apps/web/app/operations/page.tsx:242, 236, 254-256` | **Contradicted by the registry**, which registers the same equation `support: 'experimental_unsupported'` with `unsupportedReason: 'Coefficients, input scales, fairness, and clinical/safety validity are unproven. It must not clear, restrict, or prescribe training.'` (`formulas/registry.ts:316-319`). No code links the two: the equation is a second hand-typed string (`operations/page.tsx:112`) and the prohibition appears nowhere on the page (L-2) |
| 12 | "The registry is the answer to all three, and the verification scripts mean none of them has to take it on trust." — `docs/RESEARCH_EVIDENCE_REGISTRY.md` | **Partly absent.** Both scripts exist (`apps/web/package.json:194-195`) and their results land in `pilot.source_citation_checks` / `pilot.source_retraction_checks`. But no page in the app reads either — `grep -rn "citation-checks\|retraction-checks" --include=*.tsx` returns nothing (M-5) |
| 13 | "Reminder: everything registered is pending_review. Approve it at /admin/shadow before SHADOW can cite it." — `apps/web/scripts/seed-shadow-library.mjs:312` | **Wrong destination.** The evidence review queue is `/evidence`; `/admin/shadow` has no source-approval panel (L-4) |

---

## Findings

### [HIGH] H-1 — "Approve + verify" is one click by one person, and the screen shows nothing that could be verified

**What is wrong.** Approval is the single gate between a registered source and a
citation a coach reads. The database goes to real trouble to record it as two
independent human attestations. The route collapses them into one, and the page at
which the act happens displays none of the information a person would need to
verify anything.

The route derives verification from approval:

> `    const verificationState = approvalState === 'approved' ? 'verified' : 'unverified';`
> — `apps/web/app/api/pilot/shadow/evidence/review/route.ts:87`

The module then writes both attributions from the same actor in the same statement:

> `         approved_by_account_id = case when $1 = 'approved' then $3 else null end,`
> `         approved_at = case when $1 = 'approved' then now() else null end,`
> `         verified_by_account_id = case when $2 = 'verified' then $3 else null end,`
> `         verified_at = case when $2 = 'verified' then now() else null end,`
> — `apps/web/src/server/pilot/shadowLibrary.ts:691-694`

`$3` is `input.actorAccountId` in both. The DDL then asserts, to any later reader
of the row, that four separate facts were established:

> `        (approval_state = 'approved'`
> `          and verification_state = 'verified'`
> `          and approved_by_account_id is not null`
> `          and approved_at is not null`
> `          and verified_by_account_id is not null`
> `          and verified_at is not null)`
> — `infra/azure/pilot_slice_postgres_shadow_evidence_migration.sql:53-58`

And the control is a single button:

> `            {approvalState === 'approved' ? 'Approve + verify' : 'Reject'}`
> — `apps/web/app/evidence/page.tsx:111`

What the reviewer sees before pressing it is the whole of this:

> `                      {source.publisher || 'Publisher unavailable'} · {source.source_type} · {source.status}`
> — `apps/web/app/evidence/page.tsx:171`

No URL. No DOI or PMID — those live in `metadata.provenance.doi_or_pmid`, which the
`ReviewSource` interface (`page.tsx:10-18`) does not declare, even though
`listShadowLibraryReviewQueue` runs `select *` (`shadowLibrary.ts:628`) so the data
is already on the wire. No publication date. No abstract or excerpt. No
citation-check outcome. No retraction status. The reviewer is asked to attest that
a source is *verified* while looking at a title, a publisher and the word `active`.

The scale matters: the seeded corpus is 1,215 sources
(`apps/web/seed-data/shadow-research/2026-08-07/seed_shadow_library_sources.csv`,
1,216 lines with header), each requiring its own click, through a queue hard-capped
at 200 rows with no offset parameter (`shadowLibrary.ts:625`).

**Refutation attempt.** Four:
1. *Maybe `pending_review` is settable so approval can be split across two people.*
   No — the route's third accepted `approvalState` value is `pending_review`, which
   maps to `verificationState = 'unverified'`, i.e. a reset. There is no reachable
   `(approved, unverified)` or `(pending_review, verified)` state, and the DDL
   `review_pair_check` forbids both anyway. The two-column design has no reachable
   intermediate state, which is what makes it decorative rather than merely lax.
2. *Maybe `requireEvidenceReviewer` is a strong gate.* It is a genuine, deliberately
   shared gate (`shadowLibrary.ts:231-235`, reused by `drillVersioning.ts` on
   purpose). But it is a *role* check. It does not make one admin's click into two
   attestations.
3. *Maybe the citation check gates approval upstream.* It does not, and the module
   says so itself: "A RESOLVED IDENTIFIER IS NOT REVIEWER APPROVAL. review_signal
   flags rows a human should look at; it never sets
   shadow_library_sources.verification_state" (`sourceCitationChecks.ts:14-16`).
   That is the correct design — but the human it defers to cannot see the signal
   (M-5).
4. *Maybe the seed pre-approves, so nobody is really clicking 1,215 times.* It does
   not, and that is to its credit — see *Checked and found sound*.

None of the four lands. The finding stands.

**Consequence.** Every citation SHADOW puts in front of a coach rests on a
`verified_by_account_id` that was written by the same click as `approved_by_account_id`,
made on a screen carrying no verifiable information. A coach, a parent asking why
their child is taught a particular way, or an academic reviewer following the
provenance chain reaches a row that says two people checked this and finds one
click. The registry document promises this audience exactly the opposite.

---

### [HIGH] H-2 — The Library grades a claim "Backed by approved Library evidence" by counting citations, bypassing the codebase's own quality rule, and the UI drops the quality fields

**What is wrong.** This codebase contains a written, tested, quality-weighted
evidence rule with two invariants stated as invariants:

> ` * 1. PROVEN requires boxing-specific evidence at authority tier 1-2.`
> ` *    Transferred evidence never reaches PROVEN, however much of it there is.`
> ` * 2. A contested claim can never read as PROVEN.`
> — `apps/web/src/server/pilot/shadowEvidenceTier.ts:60-62`

`shadowJobProcessor.ts:217` applies it to the SHADOW chat path. The Library Q&A
path — the one a coach reaches from `/research` via the "Q&A Research Chat" button
— does not import it at all (`grep -n "shadowEvidenceTier" shadowLibrary.ts`
returns only two comment mentions). It grades by counting:

> `  if (distinctSourceCount >= 2 && evidence.length >= 2) {`
> `    status = 'supported';`
> `    confidence = 0.78;`
> — `apps/web/src/server/pilot/shadowLibrary.ts:1250-1252`

and the client turns that into:

> `      return 'Backed by approved Library evidence';`
> — `apps/web/src/client/libraryResearch.ts:48`

The quality fields are retrieved. `searchShadowLibrary` selects them explicitly —
`c.metadata->>'evidence_class' as evidence_class` and
`c.metadata->>'boxing_specificity' as boxing_specificity`
(`shadowLibrary.ts:1142-1143`) — and `ShadowEvidenceItem` carries them with a
comment saying callers "deriving a tier must treat null as not gradeable"
(`shadowEvidence.ts:27-30`). The Library client then discards them:

> `        sourceTitle: entry.source_title,`
> `        documentName: entry.document_name,`
> `        authorityTier: typeof entry.authority_tier === 'number' ? entry.authority_tier : 5,`
> `        snippet: entry.text_content.length > 280`
> — `apps/web/src/client/libraryResearch.ts:77-80`

and the page renders only what survives:

> `                                  {item.sourceTitle} (tier {item.authorityTier}) — {item.documentName}`
> — `apps/web/app/research/chat/page.tsx:186`

So two approved chunks from two approved sources, both classed
`CONTESTED PRACTICE` and both `transferred`, produce an answer labelled "Backed by
approved Library evidence" with a Sources list that does not disclose either fact.
`docs/RESEARCH_EVIDENCE_REGISTRY.md` states the base rate this matters at:
"**32% of claims are boxing-specific.** The rest is transferred from other sports
and sectors, and the registry marks which per row." The registry marks it, the
chunk metadata carries it, the search returns it, and the screen drops it.

The answer text itself is a concatenation of the top three chunks:

> `  return `Library-backed answer from current SHADOW evidence: ${snippetSummary}${snippetSummary.endsWith('.') ? '' : '.'} Primary sources: ${sourceSummary}.`;`
> — `apps/web/src/server/pilot/shadowLibrary.ts:307`

Two chunks that contradict each other are joined by a space and presented as one
library-backed answer. `docs/RESEARCH_EVIDENCE_REGISTRY.md` records 34 adjudicated
cross-track conflicts and three escalated as requiring human decisions; nothing in
this path consults the conflict ledger.

**Refutation attempt.** Three:
1. *Maybe "supported" is weaker language than "PROVEN" and the labels are not
   comparable.* Partly fair — the strings differ. But `claimStatusLabel` renders it
   as "Backed by approved Library evidence", which is a claim about evidential
   backing, and the whole purpose of `deriveEvidenceTier`'s invariant is that
   transferred evidence must not read as backing however much of it there is.
   The comment above the rule says it replaced "the old citation-count rule" —
   this path *is* the old citation-count rule, still shipping.
2. *Maybe the tier fields are usually null and the rule would abstain anyway.*
   `shadowEvidenceTier.ts:31-35` says the opposite: the class values were "Verified
   against the real 1,193-chunk corpus" and produce a stated distribution
   (115 / 796 / 227 / 55). The fields are populated.
3. *Maybe `/research/chat` is unreachable.* It is linked from `/research`
   (`page.tsx:445`) and its own header calls it "The Library".

The finding stands, narrowed: the mis-grading is real, the wording gap between
"supported" and "PROVEN" is a genuine mitigation, and the undisclosed
`boxing_specificity` is the part I am most confident in.

**Consequence.** A coach asks the Library a question about a child's training and
gets an answer stamped as backed by approved evidence, assembled from sources that
the platform's own rule says can never read as proven, with the transfer status
suppressed. This is the exact failure the evidence registry exists to prevent.

---

### [HIGH] H-3 — Capability coverage counts sources nobody approved, including sources a reviewer rejected and sources withdrawn for retraction

**What is wrong.** `recomputeShadowCapabilityCoverage` decides whether a SHADOW
capability has evidence behind it. Its counting query applies no approval predicate:

> `     left join lateral (`
> `       select count(distinct s.source_id) as matched_sources`
> `       from pilot.shadow_library_sources s`
> `       where s.organization_id = cm.organization_id`
> `         and s.status = 'active'`
> `         and s.authority_tier <= cm.minimum_authority_tier`
> — `apps/web/src/server/pilot/shadowLibrary.ts:1379-1384`

Compare the retrieval gate seventy lines away, which needs four more predicates:

> `        and s.status = 'active'`
> `        and s.approval_state = 'approved'`
> `        and s.verification_state = 'verified'`
> `        and not coalesce(s.retrieval_suppressed, false)`
> — `apps/web/src/server/pilot/shadowLibrary.ts:1160-1163`

Three consequences follow from the missing predicates, because `status` and
`approval_state` are different columns and `reviewShadowLibrarySource` touches only
the latter:

- A source registered thirty seconds ago and never reviewed counts.
- A source an evidence reviewer pressed **Reject** on counts. Rejection sets
  `approval_state = 'rejected'` and leaves `status = 'active'`.
- A source withdrawn by retraction surveillance counts. `suppressSource` "only flips
  retrieval_suppressed" (`sourceRetractionChecks.ts:226`) and never touches `status`.

And the text this number is rendered into tells the reader the opposite:

> `  const requiredTypes = row.required_source_types.length > 0 ? row.required_source_types.join(', ') : 'any verified source type';`
> — `apps/web/src/server/pilot/shadowLibrary.ts:360`

This is the same shape as the known "a REJECTED Film Study proposal was citable as
evidence" finding — a downstream reader that never checks the upstream review
state — in a place nobody has looked.

**Refutation attempt.** Three:
1. *Maybe `status` already means "approved" and `approval_state` is a second
   opinion.* No. `ShadowLibrarySourceStatus = 'active' | 'archived' | 'rejected' | 'quarantined'`
   (`shadowLibrary.ts:32`) is settable by the *registering* curator from the POST
   body (`sources/route.ts:164-166, 193`), and `createShadowLibrarySource` defaults
   it to `'active'` (`shadowLibrary.ts:476`). It is a lifecycle flag the submitter
   sets, not a review outcome.
2. *Maybe nothing reads `coverage_state`, so this is inert.* Partly true and it is
   why I checked: `listShadowCapabilityCoverage` is served by
   `/api/pilot/shadow/library/capability-coverage` and I found **no `.tsx` reader**.
   But the *suppression* half is not inert — a capability that counts as `covered`
   never gets a knowledge-gap requirement raised
   (`ensureCoverageGapResearchRequirement` returns early at `shadowLibrary.ts:393-395`),
   and requirements are exactly what an admin reads on `/research`. The gap that
   should be on the screen is absent because unapproved sources satisfied the
   threshold.
3. *Maybe the capability map is empty in practice.* `seed_shadow_library_capability_map.csv`
   exists in the seed package, and `v_shadow_research_triage` joins on it and bands
   eight capability keys as `1_BLOCKING_SAFETY` — including
   `injury_head_impact_risk` and `emergency_medical_response`. It is not intended
   to be empty.

I did **not** stop at MEDIUM, and the reason is refutation 3. The capabilities this
counter governs include head-impact risk and emergency medical response, and the
failure direction is "we have evidence for this" when the evidence was never
approved, or was rejected, or was retracted. The absence of a UI reader today is
recorded as the real mitigation it is.

**Consequence.** `covered` can be manufactured by registering sources and never
reviewing them, and the effect is a safety-relevant knowledge gap that is silently
not raised. Nothing here fabricates a number a coach acts on *today*; the moment
anyone builds a screen for coverage, it does.

---

### [HIGH] H-4 — Any organization member, including an athlete, can mark a research requirement "Resolved" with no evidence at all

**What is wrong.** The whole no-auto-resolve architecture — the trigger that does
not exist, the write-through that does not exist, the ladder rung that cannot be
computed — defers to one human act. That act is gated on organization membership
and nothing else.

> `    requireRole(principal, [...ORGANIZATION_MEMBER_ROLES]);`
> — `apps/web/app/api/pilot/shadow/research-requirements/route.ts:56`

and `ORGANIZATION_MEMBER_ROLES` is:

> `export const ORGANIZATION_MEMBER_ROLES: readonly PilotRole[] = [`
> `  'organization_admin',`
> `  'admin',`
> `  'coach',`
> `  'athlete',`
> `  'parent',`
> `  'volunteer',`
> `  'staff',`
> `];`
> — `apps/web/src/server/pilot/shadowRoleSets.ts:22-30`

The route's own comment explains a deliberate *narrowing* at this point —
"Creating and resolving research requirements is an in-organization authoring act,
so platform_owner is deliberately excluded here" (`route.ts:50-52`) — so the set was
considered. `parent` got a scope check with a comment explaining exactly why
(`route.ts:79-82`); `athlete`, `volunteer` and `staff` got none.

The UI matches. The button's only condition is the requirement's status:

> `                {requirement.status === 'open' ? (`
> `                  <button`
> `                    type="button"`
> `                    onClick={() => void handleResolveRequirement(requirement.research_requirement_id)}`
> — `apps/web/app/research/page.tsx:645-648`

and `handleResolveRequirement` posts `action: 'resolve'` with nothing else
(`page.tsx:394-399`). Contrast the two curator-gated surfaces beside it: the
Answer-a-Gap panel is hidden behind a curator probe (`page.tsx:673`) and
`/research/review` is `allowedRoles={['admin', 'platform_owner']}`
(`review/page.tsx:220`). Reviewing a submission needs an admin; declaring the
question answered does not.

The ladder then displays the result unconditionally:

> `  if (requirementStatus === 'resolved') return 'resolved';`
> — `apps/web/src/server/pilot/shadowResearchSubmissions.ts:191`

pinned as intended by the unit suite:

> `    expect(deriveAnswerState('resolved', [sub('not_responsive')])).toBe('resolved');`
> — `apps/web/src/server/pilot/shadowResearchSubmissions.test.ts:34`

so a requirement whose only submitted source was reviewed **Not Responsive** reads
`✓ Resolved` on the badge ladder.

**Refutation attempt.** Four:
1. *Maybe `/research` is admin-gated so an athlete never sees the button.* It is
   not. `/research/page.tsx` returns a bare `<main className="room--file …">` with
   no `RoleStandaloneView` and no `RoleSessionGate`; visibility is decided by which
   API calls succeed, and the requirements list is `SHADOW_PROJECTION_READ_ROLES`,
   which includes `athlete`. And "no UI path" would not be a mitigation for an
   authenticated endpoint anyway — this audit's README already rejected that
   argument when raising F-20.
2. *Maybe an athlete has no requirements in scope.* Athlete scoping is not applied
   at all on this route — only `parent` gets `resolveParentAthleteScope`
   (`route.ts:84-89`). An athlete sees and can resolve the organization's whole
   open list.
3. *Maybe resolution is reversible, so the damage is bounded.* There is no
   un-resolve path: `resolveShadowResearchRequirement` only sets
   `status = 'resolved'` where `status = 'open'` (`shadowResearch.ts:130-133`), and
   no route sets it back. Resolution is one-way.
4. *Maybe nothing downstream trusts `resolved`.* Two things do:
   `sanitizeResearchNeeds` exports `status` to the research bridge
   (`researchBridgeExport.ts:86`), and `v_shadow_research_triage` filters
   `where r.status = 'open'` — so resolving removes a requirement from the
   safety-banded triage view.

The finding stands, and refutation 3 makes it worse than I first wrote it.

**Consequence.** A knowledge gap the platform raised about a child's training —
including a gap `v_shadow_research_triage` would band `1_BLOCKING_SAFETY` — can be
closed permanently by one click from a minor, a volunteer, or a staff account, with
no source submitted and no reviewer involved, and the workspace then displays it as
`✓ Resolved`. The architecture spent a migration comment, a unique index and a
computed ladder ensuring "PDF uploaded" is not "question answered", and then let
"button pressed" be exactly that.

This narrows a role gate. **Do not implement a fix from inside the audit** — per
this directory's own standard it is escalated, not patched. The decision is
narrow and easy to state: should `action: 'resolve'` require
`SHADOW_LIBRARY_CURATOR_ROLES`, the same authority that reviews the submissions
it is meant to be judging?

---

### [MEDIUM] M-1 — Resolving a capability-coverage gap suppresses it permanently; the re-raise path is a deliberate no-op

**What is wrong.** `ensureCoverageGapResearchRequirement` dedups against *open*
requirements only:

> `    const openItems = await listShadowResearchRequirements(input.organizationId, { status: 'open' });`
> — `apps/web/src/server/pilot/shadowLibrary.ts:1419`

so once a coverage gap is `resolved` it is no longer in the dedup set and the code
proceeds to re-create it. The insert then hits the unique key and does nothing:

> `     on conflict (organization_id, source_event_name, source_entity_type, source_entity_id)`
> `     do update set`
> `       source_entity_id = pilot.shadow_research_requirements.source_entity_id`
> — `apps/web/src/server/pilot/shadowResearch.ts:52-54`

The key is real:

> `create unique index if not exists idx_shadow_research_requirements_source`
> `  on pilot.shadow_research_requirements(`
> `    organization_id,`
> `    source_event_name,`
> `    source_entity_type,`
> `    source_entity_id`
> `  );`
> — `infra/azure/pilot_slice_postgres_shadow_runtime_migration.sql:537-543`

and for a coverage gap `source_entity_id` is the stable `capability_key`
(`shadowLibrary.ts:412`). So the resolved row wins the conflict on every future
recompute, forever, and `status` is never returned to `'open'`.

**Refutation attempt.** *Maybe claim gaps behave the same and this is the intended
"resolved means resolved" semantics.* No, and the asymmetry is the evidence:
`ensureClaimResearchRequirement` builds `source_entity_id` as
`` `${input.scope}:${input.subjectId ?? 'global'}:${Date.now()}` `` (`shadowLibrary.ts:339`),
so claim gaps mint a fresh key and *do* re-raise. Only the coverage path has a
stable key, which means the permanence is a side effect of the key choice rather
than a decision anyone recorded. I also checked whether the review-flag lifecycle
has the same problem and it does not — its route comment states "The learning
loop's upsert deliberately returns a topic to 'pending' when NEW negative feedback
arrives after a verdict, so resolution is never permanent immunity"
(`library/review-flags/route.ts:16-18`), and that behaviour is pinned by a pg
suite. The desired semantics are written down next door; this path does not have
them.

**Consequence.** Combined with H-4: one click by any org member permanently
suppresses a capability-coverage gap, and the recompute that exists to re-raise it
is a no-op. `ensureCoverageGapResearchRequirement` will run thousands of times and
never raise that capability again.

---

### [MEDIUM] M-2 — The batch answer-state ladder appears unable to return anything but `needs_evidence` for an open requirement, and no test covers it

**What is wrong.** `getAnswerStates` builds its lookup map keyed on the raw value
Postgres returned for a `bigint` column:

> `    if (!byRequirement.has(row.research_requirement_id)) byRequirement.set(row.research_requirement_id, []);`
> `    byRequirement.get(row.research_requirement_id)!.push({ applicability_state: row.applicability_state });`
> — `apps/web/src/server/pilot/shadowResearchSubmissions.ts:227-228`

and then looks it up with a JavaScript number:

> `      deriveAnswerState(requirement.status, byRequirement.get(requirement.research_requirement_id) ?? []),`
> — `apps/web/src/server/pilot/shadowResearchSubmissions.ts:234`

`research_requirement_id` is `bigint` (`bigserial primary key`,
`pilot_slice_postgres_shadow_runtime_migration.sql:154`; `bigint not null` on the
submissions table, `…_shadow_research_submissions_migration.sql:31`).
`node-postgres` returns `int8` as a **string** unless a parser is registered, and
`apps/web/src/server/pilot/db.ts:9` registers exactly one — `1082`, DATE — with a
comment explaining that timestamps are untouched. So the map keys are strings, the
lookup key is a number, `Map` uses SameValueZero, and every lookup misses.

The sibling function in the same file converts, which is what makes this a slip
rather than a shared assumption:

> `    research_requirement_id: Number(row.research_requirement_id),`
> — `apps/web/src/server/pilot/shadowResearchSubmissions.ts:88`

That is the function the route calls to build the input, so the two sides are
provably in different types by line 234. The consequence is that every open
requirement falls to `?? []` and `deriveAnswerState('open', [])` returns
`'needs_evidence'` (`:192`) — the badge on `/research` reads `▲ Needs Evidence`
however many sources were submitted and reviewed responsive.

Nothing pins it. `shadowResearchSubmissions.pg.test.ts` has four tests, none of
which calls `getAnswerStates`; `shadowResearchSubmissions.test.ts` imports only
`deriveAnswerState`, which is pure and correct.

**Refutation attempt.** Three:
1. *Maybe a global type parser is registered elsewhere.* `grep -rn "setTypeParser"
   apps/ packages/` returns two hits: `db.ts:9` and its own unit test. Only OID 1082.
2. *Maybe both sides are strings and it works.* The route builds `requirements`
   from `getRequirementStatusesInOrg`, which is the function that calls `Number()`
   (`route.ts:52-53`). Both sides cannot be strings.
3. *Maybe the single-requirement path covers the UI.* It does not — that path calls
   `deriveAnswerState(status, items)` directly (`route.ts:71`) and is used by
   `/research/review`, which does not render the ladder. `/research` uses batch mode
   exclusively (`page.tsx:126-128`).

**I could not run this.** There is no database in this session, so this is a
source-level finding about types, not an observed failure. If node-postgres in this
version returns `int8` as a number, the finding is wrong and should be retracted;
one pg test asserting a non-`needs_evidence` batch result would settle it either
way, and its absence is the more durable half of this finding.

**Consequence.** The failure direction is conservative — the ladder understates
progress and never claims a gap is closer to answered than it is. That is why this
is MEDIUM and not higher. The cost is that issue #345's central deliverable, the
computed answer-state ladder, has been invisible since it shipped and nobody
noticed because no test looks at it.

---

### [MEDIUM] M-3 — `assessment_protocols` defaults to "not established" exactly as documented, and has no writer and no reader

**What is wrong.** The table is a correctly-shaped, completely empty frame, and the
three functions that read it have zero callers — so the measurement-properties
vocabulary this platform built to avoid fabricating reliability reaches nobody.

The defaults are as `HANDOFF_RESEARCH.md` item 4 describes, verbatim:

> `  reliability_status     text not null default 'UNVALIDATED - PPBF MUST ESTABLISH',`
> `  validity_status        text not null default 'UNKNOWN',`
> `  evidence_class         text not null default 'INSUFFICIENT EVIDENCE',`
> — `infra/azure/pilot_slice_postgres_assessment_protocols_migration.sql:49-51`

with `boxing_specific text not null default 'NO - transferred'`,
`retest_interval_basis text not null default 'TBD - no defensible basis'`,
`human_authority_required boolean not null default true` and
`minimal_detectable_change numeric null,     -- null until the reliability study supplies it`
(`:52-55`). The table comment states the intent:

> `  'Assessment protocol catalog with dual retest triggers (elapsed time and accumulated training hours). Every reliability/validity field defaults to an explicit unvalidated state -- this platform does not fabricate measurement properties it has not established.';`
> — `infra/azure/pilot_slice_postgres_assessment_protocols_migration.sql:155`

This is the governing principle working. What is new here is the reach:

- **No write path.** `grep -rn "insert into pilot.assessment_protocols"` across
  `.ts`, `.tsx`, `.mjs` and `.sql` returns exactly one hit — the pg test at
  `assessmentProtocols.pg.test.ts:146`. No route, no seed, no migration row.
- **No readers.** `listAssessmentProtocols` (`assessmentProtocols.ts:89`),
  `getAssessmentProtocol` (`:105`) and `listDueAssessments` (`:130`) have **zero**
  callers. `/api/pilot/data-collection-requests` imports five other functions from
  the same module and none of these three.
- **The one place a protocol id enters the system is unvalidated.**
  `createDataCollectionRequest` binds `input.protocolId ?? null` straight into the
  insert (`assessmentProtocols.ts:181`), the route passes `body.protocol_id`
  through, and `pilot.data_collection_requests` carries `protocol_id text null`
  with **no** foreign key to `assessment_protocols`
  (`…_assessment_protocols_migration.sql:122`) — unlike `pilot.assessments`, which
  does get `pilot_assessments_protocol_fk` (`:89-92`). So a capture prompt can name
  a protocol that cannot exist, and since the table is unwritable, every
  `protocol_id` on that table necessarily dangles.
- `/api/pilot/data-collection-requests` has no `.tsx` caller either.

**Refutation attempt.** *Maybe a seed migration populates it and I missed the file.*
I grepped all 88 `.sql` files in `infra/azure` and all of `apps/web/scripts` for the
insert; there is none. *Maybe the FK is unnecessary because a null protocol is the
normal case.* Fair for `request_kind: 'observation'`, but the column exists
precisely so a physical test can name its protocol, and the sibling table got the
FK — the asymmetry is the finding.

**Consequence.** No assessment in this platform can be recorded against a versioned
protocol, because the FK on `pilot.assessments` can never be satisfied. The
reliability/validity vocabulary — the mechanism by which an assessment result would
carry its own measurement properties — is present in the schema, absent from the
application, and unreachable by any surface. `HANDOFF_RESEARCH.md` calls it "an
empty frame with the right shape"; that is accurate, and the frame has now also
lost its readers.

---

### [MEDIUM] M-4 — A source withdrawn for retraction is removed from retrieval but is still exported to the research bridge

**What is wrong.** `suppressSource` is the retraction-surveillance withdrawal, and
its own docstring names the one predicate it relies on:

> ` * Removes a source from retrieval. Refuses up front, ahead of`
> ` * pilot_library_sources_suppression_reason, when the reason is under 10`
> ` * characters. The row, its documents and its chunks are never touched --`
> ` * this only flips retrieval_suppressed, which searchShadowLibrary excludes on.`
> — `apps/web/src/server/pilot/sourceRetractionChecks.ts:222-226`

Three readers honour it: `searchShadowLibrary`'s keyword query
(`shadowLibrary.ts:1163`), its semantic query (`:1070`) and
`hasRetrievableLibraryEvidence` (`shadowEvidence.ts:101`). The export does not:

> `       and s.status = 'active'`
> `       and s.approval_state = 'approved'`
> `       and s.verification_state = 'verified'`
> `       and d.ingest_state = 'indexed'`
> `       and d.index_completed_at is not null`
> `       and d.approval_state = 'approved'`
> `       and d.verification_state = 'verified'`
> `       and s.source_type = any($2::text[])`
> — `apps/web/src/server/pilot/shadowLibrary.ts:604-611`

Seven predicates, `retrieval_suppressed` absent. `buildResearchBridgeExport` ships
these rows as `SanitizedApprovedEvidence` with title, publisher, authority tier,
URL, publication date and excerpt, served by
`GET /api/pilot/shadow/research-bridge/export`.

**Refutation attempt.** Two:
1. *Maybe suppression also archives the source, so `status = 'active'` catches it.*
   No — the `UPDATE` sets only `retrieval_suppressed`, `suppression_reason`,
   `suppressed_at`, `suppressed_by_account_id` (`sourceRetractionChecks.ts:238-241`).
   `status` is untouched, which the docstring says explicitly.
2. *Maybe the export is internal and low-stakes.* It is a cross-boundary export
   (`apps/research-bridge`, added by #449 / #435) with a redaction pass for PII and
   secrets, which is the opposite of low-stakes: the pipeline was built carefully
   enough to redact bearer tokens, and then omitted the one predicate that means
   "this paper was retracted."

**Consequence.** A retracted paper stops being cited inside the gym and keeps being
shipped outward as approved evidence. Overlaps Pass 15's egress scope; recorded here
because the defect is an evidence-governance predicate, not an egress control.

---

### [MEDIUM] M-5 — The citation-verification and retraction machinery exists, works, has API routes, and is on no screen — least of all the approval screen

**What is wrong.** `docs/RESEARCH_EVIDENCE_REGISTRY.md` promises a funder, a parent
and an academic reviewer that "the verification scripts mean none of them has to
take it on trust." The scripts are real (`apps/web/package.json:194-195`), the
tables are real, the read modules are real and carefully written — and no page in
the app reads them. `grep -rn "citation-checks\|retraction-checks" --include=*.tsx`
over `apps/web` returns nothing. The only consumers are
`/api/pilot/admin/citation-checks` and `/api/pilot/admin/retraction-checks`.

`getSourceCitationStatus` exists precisely to serve the reviewer:

> ` * Latest citation status per source. This is the reviewer-facing read: it`
> ` * carries review_signal so a human can see which rows need adjudication`
> ` * without re-deriving it from raw outcomes.`
> — `apps/web/src/server/pilot/sourceCitationChecks.ts:103-106`

The reviewer-facing read has no reviewer-facing surface. `/evidence` — the only
screen where approval happens — never calls it, and its `ReviewSource` interface
(`apps/web/app/evidence/page.tsx:10-18`) has no field for a citation signal or a
retraction status.

Same for the triage view. `pilot.v_shadow_research_triage` bands open requirements,
with the top band reserved for eight named safety capabilities:

> `    'safeguarding_boundaries','injury_head_impact_risk','weight_management_safety',`
> `    'emergency_medical_response','staffing_supervision_ratios','hand_wrapping_sop',`
> `    'regulatory_eligibility_reference','hygiene_infection_control'`
> — `infra/azure/pilot_slice_postgres_research_triage_view_migration.sql:8-10`
>
> `    when sc.capability_key is not null then '1_BLOCKING_SAFETY'`
> — `infra/azure/pilot_slice_postgres_research_triage_view_migration.sql:25`

`grep -rn "v_shadow_research_triage"` over `apps/` and `scripts/` returns only the
schema-verification test and the migration runner. **Zero application readers.**
`/research` renders requirements in `created_at desc` with no band
(`shadowResearch.ts:110`), so a `1_BLOCKING_SAFETY` gap sorts by age alongside a
backlog item.

**Refutation attempt.** *Maybe the routes are the intended surface and a UI was
never the plan.* Possible for the admin check queues — but not for the triage view,
whose entire content is a priority ordering that only matters if a human sees it,
and not for `getSourceCitationStatus`, whose docstring names its audience as the
reviewer. *Maybe the scripts are run manually and the operator reads the CSV.* That
would be a legitimate answer; I could not establish whether they have ever been run
against a real database, and record it as a hole below rather than assume either way.

**Consequence.** The approval decision in H-1 is made blind not because the
information does not exist, but because it exists two API routes away from the
button. And the mechanism that decides which knowledge gap about a child is most
urgent is a database view nothing queries.

---

### [MEDIUM] M-6 — Scenario Simulator claims a hand-off that no code implements, and grades fabricated training changes with the real safety ladder

**What is wrong.** `/simulator` is a static server component. Seven scenarios are a
module-level constant (`page.tsx:5-55`); there is no form, no state, no fetch, no
handler. Two claims sit on top of it.

The imperative:

> `              Run front-end what-if scenarios to evaluate expected outcomes and risk before audit and promotion stages.`
> — `apps/web/app/simulator/page.tsx:84`

And the hand-off, which carries no qualifier at all:

> `              Validated scenarios feed into Audit Trace for governance visibility before Source Control promotion.`
> — `apps/web/app/simulator/page.tsx:152`

There is no such feed. `grep -rn "scenario" --include=*.ts --include=*.sql
apps/web/src/server infra/azure` returns exactly one hit: an unrelated comment in
`auth.ts:654`. No scenario table, no route, no writer, no reader. Nothing here is
"validated" and nothing feeds anywhere.

The second half is what raises this above a stale sentence. The fabricated scenarios
carry fabricated coaching risk grades, rendered with the design system's genuine
safety ladder:

> `  if (risk === 'Low') return { className: 'badge badge--cleared', glyph: '✓', label: 'Low Risk' };`
> `  if (risk === 'Moderate') return { className: 'badge badge--restricted', glyph: '▲', label: 'Moderate Risk' };`
> `  return { className: 'badge badge--locked', glyph: '✕', label: 'High Risk' };`
> — `apps/web/app/simulator/page.tsx:61-63`

on content like `proposedChange: 'Shift one recovery session to additional technical
sparring prep.'` graded `riskRating: 'High'` (`page.tsx:16-18`). `badge--locked`,
`badge--restricted` and `badge--cleared` are the same classes `/evidence` uses for
Rejected/Approved and the training-hold surfaces use for a child's safety state.
Law 2 reserves them: "Green, blue, orange and red appear only to communicate a
participant's safety state or a queue outcome" (`design-system/README.md:44-46`).
An invented risk grade on an invented training change is neither.

**Refutation attempt.** Two:
1. *Maybe the page discloses itself and the reader is warned.* Partly. There is one
   plaque, `{ label: 'Engine', value: 'Front-end Only' }` (`page.tsx:70`), rendered
   as `ENGINE: FRONT-END ONLY` in a row of four status plaques alongside
   `MODE: SAFE VALIDATION`. That is real and I am recording it. But compare
   `/source-control`, which puts `PLANNED | FRONT-END PLACEHOLDER | NOT YET
   AUTOMATED | BACKEND REQUIRED` in a `stamp--brass` and says outright "Every card,
   version, and count on this page is a sample, not live promotion state."
   (`source-control/page.tsx:5, 96, 98`). The same codebase, the same pipeline,
   the same author's hand — one page declares itself under Law 7 and the other does
   not, and the sentence at line 152 has no qualifier anywhere near it.
2. *Maybe NETWORK_STATUS already recorded this, so it is not new.* It records
   "Scenario Simulation and Source Governance are islands with zero data edges,
   whose own copy claims hand-offs that no code implements" as an *unclaimed item*.
   This pass verifies half of it and **refutes the other half**: Source Control's
   copy does not claim an unimplemented hand-off, it declares itself a placeholder
   in the design system's own refusal vocabulary. The verified half is the
   simulator, and the Law 2 badge misuse is new.

**Consequence.** A page reachable from the research pipeline banner presents seven
hypothetical changes to children's training with risk grades in the platform's
safety colours, tells the reader they feed into the audit trail, and does neither.
Overlaps Pass 7 on fabricated-data disclosure; recorded here because the false
hand-off claim is an evidence-governance claim.

---

### [LOW] L-1 — Knowledge Graph: "Pattern" has no emitter, but "Finding" does — the NETWORK_STATUS claim is half wrong

**What is wrong.** NETWORK_STATUS records: "Knowledge Graph's 'Pattern' and
'Finding' columns are permanently empty — nothing emits an event matching those
filters." I checked both sides independently and it is **half right**.

The filter:

> `      if (event.event_name.toUpperCase().includes('PATTERN')) {`
> `        type = 'Pattern';`
> `      } else if (event.event_name.toUpperCase().includes('FINDING')) {`
> `        type = 'Finding';`
> — `apps/web/src/server/pilot/shadowReadModels.ts:487-490`

with a second gate the event must also pass:

> `      if (`
> `        !event.event_name.toUpperCase().includes('SHADOW')`
> `        && !event.event_name.toUpperCase().includes('INTAKE')`
> `        && !event.event_name.toUpperCase().includes('AUDIT')`
> `      ) {`
> `        return null;`
> `      }`
> — `apps/web/src/server/pilot/shadowReadModels.ts:497-503`

`pilot.shadow_events` has exactly one writer (`insert into pilot.shadow_events` at
`shadowEvents.ts:15`), so the set of possible event names is enumerable.

**Pattern — confirmed empty.** No literal `eventName:` in the tree contains
`PATTERN`, and no dynamic construction can produce one: the only two generators are
`audit.ts:44` and the two `/shadow/events`-adjacent pass-throughs, and no
`event_type` or `entity_type` literal in the tree contains `pattern`.

**Finding — refuted.** `writePilotAuditEvent` mints names as:

> `    eventName: `SHADOW_AUDIT_${normalizedEventType}_${normalizedEntityType}`,`
> — `apps/web/src/server/pilot/audit.ts:44`

and one entity type is:

> `      entity_type: 'local_finding',`
> — `apps/web/app/api/pilot/admin/local-findings/route.ts:88` (and `:147`)

producing `SHADOW_AUDIT_CREATE_LOCAL_FINDING` and
`SHADOW_AUDIT_UPDATE_LOCAL_FINDING`. Both contain `FINDING` and both contain
`SHADOW`, so both pass the filter and both land in the Finding column. The
NETWORK_STATUS row is wrong on this half and should be corrected rather than
quietly tightened.

The practical reach is small, which is why this is LOW: `/api/pilot/admin/local-findings`
has **no `.tsx` caller**, so the column populates only for someone calling the API
directly. And `toReviewState` matches none of its keywords on those names
(`shadowReadModels.ts:207-214`), so such a node renders `◌ Unknown`.

**Refutation attempt.** *Maybe `local_finding` normalizes to something without
`FINDING`.* `normalizedEntityType` is `event.entity_type.toUpperCase().replace(/[^A-Z0-9]+/g, '_')`
(`audit.ts:43`) → `LOCAL_FINDING`. It survives. *Maybe `shadow_mirror: false`
suppresses the mirror on that route.* The route's two `writePilotAuditEvent` calls
do not pass `shadow_mirror` (`local-findings/route.ts:83-88, 142-147`), and the
guard is `if (!event.organization_id || event.shadow_mirror === false) return;`
(`audit.ts:37`) — `undefined` is not `false`, so the mirror fires.

**Consequence.** Minor for the screen. Material for the coordination surface: a row
in the shared handoff file is inaccurate, and the next session would have re-found
it.

---

### [LOW] L-2 — A formula's claimed evidential status is a hand-typed string with no link to any registered evidence, and the same equation is duplicated on `/operations` without its prohibition

**What is wrong.** `FormulaDefinition` has no field for a citation, a source id, or
an evidence-registry row:

> `export interface FormulaDefinition {`
> `  readonly id: FormulaId;`
> `  readonly version: string;`
> `  readonly name: string;`
> `  readonly expression: string;`
> `  readonly support: FormulaSupport;`
> `  readonly outputUnit: FormulaUnit;`
> `  readonly outputs: readonly FormulaOutputDefinition[];`
> `  readonly requiredObservationKinds: readonly ObservationKind[];`
> `  readonly humanReviewRequired: boolean;`
> `  readonly unsupportedReason?: string;`
> `  readonly implementation?: string;`
> `}`
> — `apps/web/src/server/pilot/formulas/types.ts:266-278`

`support` is a union literal typed by hand in the source
(`'implemented' | 'primitive_only' | 'unsupported' | 'experimental_unsupported'`,
`types.ts:53`). Nothing connects it to `shadow_library_sources`, to
`evidence_registry_boxing_learning.csv`, or to `pilot.local_findings`. Answering the
brief's question directly: **it is a hand-typed string.** There is no code path by
which registering evidence could change a formula's claimed status, and no check
that a formula marked `implemented` has any.

The registry does use that string honestly, which is why this is LOW:

> `    support: 'experimental_unsupported',`
> `    outputUnit: 'unitless',`
> `    humanReviewRequired: true,`
> `    unsupportedReason: 'Coefficients, input scales, fairness, and clinical/safety validity are unproven. It must not clear, restrict, or prescribe training.',`
> — `apps/web/src/server/pilot/formulas/registry.ts:316-319`

The provenance break is that the string does not travel with the equation. The same
formula appears on `/operations` as an independent literal:

> `const shadowReadinessEquation = 'Readiness = max(1, min(10, (Sleep x 1.25) - (Soreness x 0.45) + (Discipline x 0.3)))';`
> — `apps/web/app/operations/page.tsx:112`

rendered under `<h3>Mathematical Gate Validation</h3>` (`:254`) inside a section
headed "System Diagnostics and SHADOW Certification" (`:236`), beside
"This build section mirrors the certified guardrails used for floor safety, role
isolation, and audit integrity." (`:242`) and a boundary check asserting
"Any readiness score below 5.0 triggers protective route and drill constraints."
(`:129`). The prohibition appears nowhere on the page. A reader of `/operations`
cannot reach the registry entry from what is on screen, because there is no link —
only two strings that happen to spell the same equation.

**Refutation attempt.** *Maybe `/operations` reads the registry and I missed it.*
`grep -n "registry\|getFormulaDefinition" apps/web/app/operations/page.tsx` finds
nothing; line 112 is a module-level literal. *Maybe `unsupportedReason` is surfaced
somewhere else and the reader would find it.* Possibly on other screens; it is not
on this one, which is the one carrying the certification frame.

Pass 9 owns the coefficients and the `readinessMath.ts` zero-caller mechanism (F-08
already records it). What is recorded here is only the missing link between a
claimed status and any evidence, and the duplicated string that strips the
prohibition.

---

### [LOW] L-3 — An invented confidence number ships in the claim payload with no basis and no disclosure

**What is wrong.** `createShadowLibraryClaim` attaches a numeric confidence to
every answer:

> `    confidence = 0.78;`
> …
> `    confidence = 0.46;`
> …
> `    confidence = 0.12;`
> — `apps/web/src/server/pilot/shadowLibrary.ts:1252, 1255, 1258`

Three magic constants with no citation, no comment, and no derivation, returned in
the `claim` object by `POST /api/pilot/shadow/library/claims` (`route.ts:54`).

**Refutation attempt.** *Maybe it is displayed and this should be higher.* It is
not: `libraryResearch.ts`'s `LibraryClaimAnswer` interface (`:23-30`) has no
`confidence` field and `parseEvidence` drops it, so `/research/chat` never renders
it. That is the reason for LOW rather than HIGH. `shadowEvidenceTier.ts:3-6` is
explicit that this platform keeps three *different* confidence notions apart —
"Distinct from explainability.confidence (0-100 numeric) and the formula engine's
ConfidenceState" — which makes a fourth, undocumented one in the API surface a
drift risk rather than a live defect.

**Consequence.** Any future consumer of the claims API — the research bridge, a
report, a board packet — can render `0.78` as a confidence figure about a claim
concerning a child's training, and the number means nothing.

---

### [LOW] L-4 — The seed script sends the operator to the wrong page to approve 1,215 sources

> `  console.log('Reminder: everything registered is pending_review. Approve it at /admin/shadow before SHADOW can cite it.');`
> — `apps/web/scripts/seed-shadow-library.mjs:312`

and the same instruction earlier at `:49-50`. The evidence review queue is
`/evidence` (`apps/web/app/evidence/page.tsx`, calling
`/api/pilot/shadow/evidence/review`). `/admin/shadow` reads
`/shadow/library/review-flags` and a document-review queue; it has no
source approval control. **Refutation attempt:** I grepped
`apps/web/app/admin/shadow/page.tsx` for `evidence/review` and `Evidence Review`
and found neither; the page's own pipeline rows *link out* to `/evidence`
(`page.tsx:190, 196`), which is the tell that the queue lives elsewhere.
**Consequence:** the operator who has just imported the corpus is told to approve
it somewhere it cannot be approved. Nothing gets approved by accident; the corpus
stays uncitable for longer.

---

### [LOW] L-5 — Three buttons on `/research` are dead ends for five of the seven roles that can read the page

`/research` renders for any `SHADOW_PROJECTION_READ_ROLES` reader — the page has no
`RoleSessionGate` at all — and offers `<Link href="/evidence">Evidence Review</Link>`
(`page.tsx:448`), a per-card `<Link href="/evidence">Move to Evidence</Link>`
(`:543`) and `<Link href="/source-control#publish">Publish Stage</Link>` (`:451`).
`/evidence` is `allowedRoles={['admin', 'platform_owner']}`
(`evidence/page.tsx:122`), so a coach, athlete, parent, volunteer or staff member
following either of the first two is bounced. `/research/chat` carries the same link
(`chat/page.tsx:266`). **Refutation attempt:** I checked whether
`allowedRoles={['admin', …]}` silently excludes a provisioned `organization_admin`
— the F-22 shape — and it does **not**: `mapPilotRoleToClubRole` folds
`organization_admin` and `admin` to one `ClubRole`
(`apps/web/components/roleSession.ts:213`) before
`isRoleSessionAllowed` runs its `includes` (`:312-314`). That candidate finding is
withdrawn. Overlaps Pass 7's dead-end scope.

---

## Checked and found sound

Recorded so the next reader does not spend an afternoon here. Several of these are
the strongest work I saw in this pass.

- **No write-through from submissions to requirements.** The NETWORK_STATUS claim is
  verified, not merely repeated: no trigger in the migration, exactly one `update
  pilot.shadow_research_requirements` in the tree, and the `'resolved'` rung reads
  the requirement's own status.
- **The retrieval gate.** Seven predicates on two tables, restated identically in
  three places — `searchShadowLibrary`'s keyword query (`shadowLibrary.ts:1161-1168`),
  its semantic query (`:1067-1074`) and `hasRetrievableLibraryEvidence`
  (`shadowEvidence.ts:98-105`). I tried to find a fourth retrieval path that skipped
  one and found none. The semantic path additionally pins `embedding_model` to the
  current deployment with a comment explaining that a retired model's vector would
  "clear SEMANTIC_SCORE_FLOOR by chance, and get cited to a user as evidence"
  (`:1043-1050`) — that is the right instinct, applied where it was easy to miss.
- **The DB review-pair constraints.** `shadow_library_sources_review_pair_check` and
  its document twin make an approved row without both attributions and both
  timestamps unrepresentable, and the document version additionally requires
  `ingest_state = 'indexed'` and `index_completed_at is not null`. The `UPDATE` in
  `reviewShadowLibraryDocument` re-states the indexing condition in its own `WHERE`
  rather than relying on the constraint to throw (`shadowLibrary.ts:958-961`).
- **Registration cannot pre-approve, and neither can the seed.** `createShadowLibrarySource`
  omits both review columns from its `INSERT`, and `seed-shadow-library.mjs`
  contains no approval call — its only mentions of approval are the two reminders
  telling the operator to do it by hand. A seed that quietly approved its own 1,215
  rows is the single worst thing this pass could have found, and it does not happen.
- **`sourceCitationChecks.ts` never writes, and says so.** "THIS MODULE NEVER
  WRITES… it has no insert/update path, on purpose, so there is exactly one writer
  to reason about" (`:8-12`), and "A RESOLVED IDENTIFIER IS NOT REVIEWER APPROVAL"
  (`:14`). Both true.
- **Rabbit-hole citations.** The migration argues for three paragraphs why it uses
  no foreign key and must re-check the full approval predicate on every read
  (`pilot_slice_postgres_rabbit_holes_migration.sql:56-88`), and
  `rabbitHoles.ts:218-229` does exactly that. Its admission that authored lessons
  have no reviewer — "Coaches publish directly -- there is no review state, because
  there is no reviewer" (`:105-106`) — is a disclosed design choice, not a gap, and
  the table deliberately holds no `athlete_id` so no audience value can widen
  access to a minor's data.
- **The submission table's two constraints.** `pilot_shadow_research_submissions_unique_link`
  refuses the same source twice against the same requirement, surfaced to the route
  as a named error rather than a constraint name; `…_review_attribution` makes an
  unattributed verdict and an attributed non-verdict both unrepresentable.
- **Org isolation on the submission route.** Requirement, source and document
  existence are each checked org-scoped, with "doesn't exist" and "exists in another
  organization" collapsed into one `hiddenNotFound` — and the module explains that
  the FKs prove existence, not tenancy (`shadowResearchSubmissions.ts:54-59`). This
  is the pattern Pass 2 found to be the house standard, correctly applied.
- **`interventionEvidence.ts`'s other four source kinds.** I went looking for the
  rejected-Film-Study shape in `training_attempt`, `readiness`, `assessment` and
  `activity_log` and found nothing to find: none of those four tables carries an
  approval, review or void column, so there is no upstream state their queries
  could have failed to check. `film_study` is the only one of the five whose table
  has a `review_state` (`pilot_slice_postgres_film_study_proposals_migration.sql:75-76`),
  and it is the one already reported and already fixed on a PR. Do not go hunting
  this as a systemic problem in that module.
- **The Library Q&A's honesty about its own notes.** "This note stays in this
  browser session only. It is not stored anywhere, and it is gone when you reload or
  leave the page." (`research/chat/page.tsx:129`), with a code comment stating
  "There is no notes table and no write, so the confirmation has to say so"
  (`:120-121`). That is Law 7 applied to a feature's own absence.
- **The `/research` curator probe.** Answer-a-Gap and General Research Intake are
  hidden behind a probe of the same endpoint their writes need, so a non-curator
  sees a read-only workspace rather than buttons that 403 (`page.tsx:141-146`).
  The pattern L-5 complains about is done correctly ten lines away.
- **`/source-control`'s Law 7 disclosure.** Refutes half the NETWORK_STATUS
  "islands claiming hand-offs" row. See UI-claims table row 9.
- **`allowedRoles={['admin', …]}` admits `organization_admin`.** Candidate finding
  withdrawn; see L-5.
- **The review-flag lifecycle re-opens on new evidence.** "resolution is never
  permanent immunity" (`library/review-flags/route.ts:16-18`), pinned by a pg suite,
  and it has a real UI reader on `/admin/shadow`. This is the correct semantics that
  M-1's coverage-gap path lacks.

---

## Could not establish

Holes, stated as holes.

1. **Whether M-2 manifests at runtime.** No database in this session. The finding is
   a type-level argument plus the absence of a test. One pg test calling
   `getAnswerStates` with a reviewed submission would settle it in either direction,
   and writing that test is the cheapest next action in this pass.
2. **Whether any organization has approved any of the 1,215 seeded sources.** This
   decides whether the Library answers anything at all today, and therefore whether
   H-1 and H-2 are live or latent. It needs production data nobody in this session
   can see. The same question bounds `hasRetrievableLibraryEvidence`'s
   "misconfiguration" branch.
3. **Whether `verify-research-citations.mjs` or `check-source-retractions.mjs` has
   ever been run against a real database.** If they never have, M-5 is worse than
   written (the tables are empty as well as unread); if they run regularly, M-5 is
   an interface gap rather than a governance gap. Needs Actions history or operator
   testimony.
4. **Whether `/api/pilot/shadow/library/capability-coverage` has any consumer
   outside this repository.** I established there is no `.tsx` reader. A dashboard,
   a script or the research bridge consuming it would move H-3's severity up, not
   down.
5. **Whether `apps/research-bridge` is deployed and reachable.** M-4's blast radius
   depends on it. Same class of unknown as Pass 3's "what drives the SHADOW job
   queue in production", and probably answerable by the same person.
6. **Whether the 34 conflicts and three escalated decisions in
   `cross_track_conflict_ledger.csv` are represented anywhere in the loaded corpus.**
   `docs/RESEARCH_EVIDENCE_REGISTRY.md` says the registry "is not loaded into the
   database" and that the loaded corpus "is derived from these same claims". I did
   not open the CSVs to check whether a chunk derived from a conflicted claim
   carries `CONTESTED PRACTICE`, because reading 1,193 rows of research claims was
   out of proportion to the question. If they do not, H-2 is worse: the conflict
   would be invisible to `deriveEvidenceTier` as well as to the Library.

---

## Direct answer to the question this pass was sent to answer

**Can a claim become "evidence" in this system without passing any check?**

Not without a role. Not by submitting a link — that part of the architecture is
real, and I verified it rather than taking it from the handoff file.

But **yes, without passing any check on the claim itself.** The only gate between a
source and a citation a coach reads is `requireEvidenceReviewer` plus one button
labelled "Approve + verify", pressed on a screen showing a title, a publisher and
the word `active`. The route derives `verified` from `approved`, one actor writes
both attributions in one statement, and the database then records that two facts
were independently established. Nothing automated is consulted: not the citation
resolver that exists, not the retraction check that exists, not a second reviewer.
Below that, one surface grades claims "Backed by approved Library evidence" by
counting rather than by the codebase's own quality rule and hides the transfer
status while doing it, one surface counts unapproved and rejected and retracted
sources as capability coverage, and the research requirement that records a gap in
what the gym knows about a child's training can be closed permanently by one click
from a minor.
