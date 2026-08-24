# Handoff: research and evidence

A standing brief for an agent that owns the questions in this platform that no
amount of coding can close. Sibling of `docs/EXTERNAL_AUDIT_PROMPTS.md` and
`docs/HANDOFF_VISUALS.md`.

Read `AGENT_KERNEL.md` first, then `docs/capabilities/NETWORK_STATUS.md` (what
has already merged, what is in flight, and which items below are blocked on your
output rather than on code), then `docs/AI_COLLABORATION.md` for collision
control, then `apps/web/src/server/pilot/formulas/registry.ts` and
`docs/RESEARCH_EVIDENCE_REGISTRY.md`.

## Before you start

Private repository, nonprofit serving minors. Never commit or paste
`apps/web/.env.local`, any connection string, any `AZURE_*` value,
`PPBF_MS_CLIENT_SECRET`, `PPBF_PILOT_BOOTSTRAP_KEY`, any real athlete or
guardian name, any real PIN or account id, or anything from `scripts/data/`.

Every item below concerns minors.

## The governing principle

This codebase has an unusually strict stance on invented authority, and your
work is the mechanism by which a thing *earns* authority. See it in action in
`apps/web/src/server/pilot/formulas/registry.ts`: a formula sits fully coded and
unit-tested but deliberately **unwired**, registered `experimental_unsupported`
with `humanReviewRequired: true` and the written prohibition *"Coefficients,
input scales, fairness, and clinical/safety validity are unproven. It must not
clear, restrict, or prescribe training."*

So: **do not close any item below by picking a plausible number.** A cited "we
could not establish this" is a complete and valuable answer. An uncited
plausible answer is worse than nothing, because code will then be built on it.
Carry sources inline.

## Where your output goes

`docs/research/` — **this directory does not exist yet; create it.** Other
agents are instructed not to touch it. Markdown with inline citations, draft PR
per item, do not mark ready for review.

Do **not** change application code, migrations, or any formula's coefficients or
thresholds. Your output is the evidence base a separate, owner-approved change
would later cite. Recommend; do not implement.

**Priority order: 1 → 2 → 6 → 3 → 5 → 4.** Corrected 2026-08-24. This read
*"6 → 1 → 2 → 3 → 5 → 4"* on the stated ground that *"Item 6 already governs
live decisions about children's training"* — which is not true of most of item
6, and the section itself now carries the measurement. Of the constants it
covers, only the 24-hour readiness staleness window actually runs; the 5.0
readiness gate does not exist, and the delta-RPE lockout and the formulas engine
have no production caller.

Items 1 and 2 are blocking gates in review now, which is a real reason to take
them first. Item 6 stays high because an unwired constant becomes a live one the
moment somebody wires it, and knowing whether it is defensible is cheaper before
that than after — but it is no longer first, and no longer first for a reason
that was not so.

---

## 1. Act 153 / SafeSport requirements → the clearance vocabulary

A complete clearance register exists in the schema —
`pilot.person_clearances`, `pilot.clearance_types`,
`pilot.activity_clearance_requirements`, and a `v_clearance_status` view — with
**zero callers anywhere in the app.** A PR is wiring it up. But
`clearance_types` is seeded with only four hand-written placeholder rows by a
migration, and `activity_clearance_requirements` has **no write path at all**.
Wiring a register to a vocabulary nobody validated only relocates the problem.

Today, granting a coach temporary coverage over a child checks that they are an
active coach account and nothing else — never their clearance. Volunteer records
carry a **free-text** `background_check_status` field an admin types by hand: a
second, competing, unvalidated representation of the same fact.

Needed:

- The clearance instruments Pennsylvania's **Act 153** actually requires for
  adults with youth contact — PA child abuse clearance, State Police criminal
  record check, FBI fingerprint check; confirm the real current set, who is
  exempt, and renewal intervals — plus **SafeSport** training requirements as
  they apply to a **USA Boxing** member club.
- Which *activities* require which clearances (this is what
  `activity_clearance_requirements` models): coaching on the floor, transporting
  a minor, being alone with a minor, board service, event-day volunteering.
- Renewal and expiry intervals per instrument, and what "lapsed" should mean
  operationally.
- **Deliverable:** a sourced reference table the seed migration can be rewritten
  from, plus a recommendation on what the platform should do when a clearance is
  missing or lapsed — refuse the assignment, flag it, or both depending on
  activity. Cite statute and USA Boxing / SafeSport policy directly.

## 2. Travel waiver — what it must contain

`apps/web/src/server/pilot/waiverCompliance.ts` tracks a `travel` waiver type,
and a PR now **gates competition entry on it**: an athlete cannot be entered
into a wrestling match or external competition without one. That gate is only as
good as the document behind it, and nobody has established what the document
must say.

Needed: for taking a minor off-site to a competition in Pennsylvania — required
consent elements, medical-treatment authorization while away from guardians,
emergency contact and authority-to-treat language, transport authorization
(including who may drive), scope and duration (single event vs. season), and
whether a guardian signature must be witnessed or notarized. Flag anything that
changes when the event crosses state lines. **Deliverable:** the
required-elements list with sources, plus a note on what the platform should
*store* versus what must exist on paper.

## 3. LEGACY-READINESS — validate it, or retire it

The highest-value item here, because it sits at the centre of a confirmed
**HIGH-severity** finding: three separate "readiness" pipelines exist for the
same athlete and none of them connect.

- The athlete's own daily wellness self-report (energy, soreness, focus, 1–5) is
  stored and *explicitly never* feeds a formula score.
- The coach-facing GREEN/YELLOW/RED triage board reads a table populated **only
  by staff manually re-keying numbers during intake.**
- A third formula, registered `LEGACY-READINESS` —
  `Readiness = max(1, min(10, (Sleep × 1.25) − (Soreness × 0.45) + (Discipline × 0.3)))`,
  implemented in `apps/web/src/server/pilot/readinessMath.ts` — is displayed on
  the operations page as a "certified" live equation but has **zero callers** and
  produces no number anyone ever sees.

A coach therefore sees a triage colour that is a staff member's typed opinion,
with no indication the athlete self-reported high soreness that morning.

> Background: `docs/capabilities/READINESS_PROVENANCE_FACTS.md` documents this in
> full, but **it is not on `main`** — it arrives with the
> `fix/ct-readiness-provenance` branch. Read it there.

The question is **not** "wire this formula in." It is *can these coefficients be
justified for adolescent athletes, or should the formula be formally retired?*

- Is there any published basis for `1.25 / 0.45 / 0.3`, or is the set invented?
  Assume invented until proven otherwise.
- What does the literature support for subjective-wellness readiness scoring in
  **adolescent** athletes specifically — and is there a validated instrument the
  gym could adopt instead of a bespoke formula?
- Fairness: would any candidate instrument behave differently across age, sex, or
  training age in ways that matter for a mixed youth roster?
- **Deliverable:** one of three recommendations, with citations — (a) adopt a
  named validated instrument, (b) a validation protocol this gym could actually
  run, or (c) retire `LEGACY-READINESS` and formally document that a governed
  readiness score does not exist. **(c) is a perfectly good answer.** Do not
  recommend wiring the current coefficients in.

## 4. `assessment_protocols` reference data

The table exists and already carries a real measurement-properties vocabulary —
`reliability_status`, `validity_status`, `evidence_class`, defaulting toward
*not established*. It has **no write path**: an empty frame with the right shape.

Needed: for the assessments a youth boxing gym would plausibly run
(conditioning, movement screening, skill checks), the protocols with their
**published reliability and validity figures** and an honest evidence class
each. Anything you cannot source stays not-established — that is the schema's
own default and its intent. **Deliverable:** seed-ready rows, each with its
citation and measurement properties, plus an explicit list of what you could not
establish.

## 5. The four blocked formula-registry entries

`registry.ts` has four entries pre-wired — registry metadata, types and
`requiredObservationKinds` all present — that cannot run: **Training Monotony**,
**Strain**, **Typical Error**, **Recommendation Priority** (CORE-06/07/09,
BF-10). They are blocked on a missing upstream **daily training-load observation
stream** and a policy approval nobody has sought.

Needed:

- What each requires as input, in real units, at what cadence — specify the
  daily-load observation precisely enough to design a capture surface from.
- Whether each is **appropriate for minors at all.** Monotony and strain come
  from adult endurance-athlete literature; whether they transfer to adolescent
  boxers is a real question, not a formality.
- Published thresholds, and whether *adolescent-specific* thresholds exist. If a
  metric has only adult norms, say so plainly — that is a finding.
- **Deliverable:** per formula, a go / no-go recommendation with sources; for any
  "go", the observation spec and the threshold set with its population.

## 6. Are the existing youth safety thresholds right?

> **Corrected 2026-08-24.** This section previously opened: *"Unlike items 1–5
> this one is **live in production logic today**, which makes it first if you
> only do one"*, and listed a readiness score below 5.0 triggering "protective
> route and drill constraints", a delta-RPE lockout, and a formulas engine that
> "already computes and stores" contact exposure and acute:chronic workload
> ratio.
>
> **Most of that is not live, and the 5.0 threshold does not exist at all.**
> The urgency framing was the load-bearing error: it told a researcher to
> prioritise this item over items 1–5 on the strength of gates that are not
> running. Measured against `main` at `ed755ab7`:
>
> | Claimed | Actual |
> |---|---|
> | readiness < 5.0 constrains routes and drills | **No such threshold exists.** The real constants are `READINESS_GREEN_MIN = 7` and `READINESS_YELLOW_MIN = 4` in `readinessBoard.ts`, and they are display triage colours over a staff-typed score. They constrain nothing. |
> | delta-RPE ≥ 2 engages a lockout | The function exists (`readinessMath.ts#isDeltaRPELocked`) and is unit-tested. **It has no production caller.** |
> | the formulas engine computes and stores contact exposure / ACWR | `formulas/engine.ts` and `formulas/primitives.ts#acuteChronicWorkloadRatio` exist. **Nothing outside their own tests imports the engine.** `sparringExposure.ts` likewise has no route or page caller. |
> | a reading older than 24h is discarded as stale | **True and live.** `READINESS_FRESHNESS_HOURS = 24`, enforced in `getReadinessBoard`'s SQL. |
>
> `app/operations/page.tsx` already carried this correction for the 5.0 claim
> and the delta-RPE lockout; the research brief simply never received it. Two
> documents disagreeing about what gates a child's training is the kind of gap
> this correction exists to close.
>
> **What this does not change:** the research is still worth doing. An unwired
> constant becomes a live one the moment somebody wires it, and it is cheaper to
> know whether 24 hours, a 2-point delta, or an adult ACWR band is defensible
> for adolescent boxers *before* that happens than after. What changes is the
> priority claim and the reason — do this because the numbers are unverified,
> not because they are currently gating anything.

The formulas engine defines per-athlete **contact exposure** and
**acute:chronic workload ratio**, `readinessMath.ts` defines a delta-RPE
lockout, and `readinessBoard.ts` discards a readiness reading older than 24h as
stale (`READINESS_FRESHNESS_HOURS`). Of those, only the 24-hour staleness
window currently runs in production.

Nobody has verified any of these numbers against published youth guidance.

Needed, for **adolescent boxers specifically**: sparring and contact exposure
limits per week and per session (USA Boxing rules, plus any published guidance
on youth head-impact exposure); whether standard adult acute:chronic workload
ratio bands apply to youth at all; whether a 24-hour readiness freshness window
is defensible. **Deliverable:** for each constant, either a citation supporting
it, a recommended corrected value with citation, or an explicit "no published
basis exists for a youth population". **Flag anything you believe is currently
set unsafely immediately, not at the end of the work.**
