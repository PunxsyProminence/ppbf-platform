# Handoff → Research account

**Repo:** `PunxsyProminence/ppbf-platform` · **Read first:** `AGENT_KERNEL.md`, then `docs/capabilities/READINESS_PROVENANCE_FACTS.md` and `apps/web/src/server/pilot/formulas/registry.ts`.

You own the questions in this platform that **no amount of coding can close.**
A capability-network audit just mapped 34 capabilities and found 26 gaps. Most
are wiring problems being fixed in code right now. The six below are not — each
is blocked on real-world reference data, published standards, or a policy
decision that has to be *established* before any code is allowed to depend on
it. Writing code for these first would be the actual mistake.

This is a nonprofit youth boxing gym. Every item below concerns minors.

---

## The governing principle here, before anything else

This codebase has an unusually strict and well-enforced stance on invented
authority, and your work is the mechanism by which things *earn* authority.
Read `formulas/registry.ts` and `READINESS_PROVENANCE_FACTS.md` to see it in
action: a formula sits fully coded and unit-tested but deliberately **unwired**,
registered `experimental_unsupported` with `humanReviewRequired: true` and the
written prohibition *"Coefficients, input scales, fairness, and
clinical/safety validity are unproven. It must not clear, restrict, or prescribe
training."*

Correspondingly: **do not resolve any item below by picking a plausible number.**
A cited, sourced "we could not establish this" is a complete and valuable
answer. An uncited plausible answer is worse than no answer, because code will
then be built on it. Every deliverable below should carry its sources inline.

---

## 1. Act 153 / SafeSport clearance requirements → the clearance vocabulary

**Why it's blocking:** A complete clearance register exists in the
schema — `pilot.person_clearances`, `pilot.clearance_types`,
`pilot.activity_clearance_requirements`, and a `v_clearance_status` view — with
**zero callers anywhere in the app.** A PR is wiring it up. But
`clearance_types` is currently seeded with only four hand-written placeholder
rows by a migration, and `activity_clearance_requirements` has **no write path
at all**. Wiring a register to a vocabulary nobody validated just relocates the
problem.

Right now, granting a coach temporary coverage over a child checks only that
they are an active coach account — never their clearance. Volunteer records
carry a **free-text** `background_check_status` field an admin types into by
hand, which is a second, competing, unvalidated representation of the same fact.

**What's needed:**
- The actual clearance instruments Pennsylvania's **Act 153** requires for
  adults with youth contact (PA child abuse clearance, State Police criminal
  record check, FBI fingerprint check — confirm the real current set, who is
  exempt, and renewal intervals), plus **SafeSport** training requirements as
  they apply to a **USA Boxing** member club.
- Which *activities* require which clearances (this is what
  `activity_clearance_requirements` models): coaching on the floor vs.
  transporting a minor vs. being alone with a minor vs. board service vs.
  event-day volunteering.
- Renewal/expiry intervals per instrument, and what "lapsed" should mean
  operationally.
- **Deliverable:** a sourced reference table the seed migration can be rewritten
  from, plus a recommendation on what the platform should do when a clearance is
  missing or lapsed (refuse the assignment? flag it? both, depending on
  activity?). Cite statute and USA Boxing / SafeSport policy directly.

---

## 2. Travel waiver — what it must actually contain

**Why it's blocking:** `waiverCompliance.ts` already tracks a `travel` waiver
type org-wide, and a PR is now **gating competition entry on it** — an athlete
cannot be entered into a wrestling match or external competition without one.
That gate is only as good as the document behind it, and nobody has established
what that document must say.

**What's needed:** for taking a minor off-site to a competition in
Pennsylvania — the required consent elements, medical-treatment authorization
while away from guardians, emergency contact and authority-to-treat language,
transport authorization (including who may drive), duration/scope (single event
vs. season), and whether a guardian signature must be witnessed or notarized.
Flag anything that varies by whether the event crosses state lines.
**Deliverable:** the required-elements list with sources, and a note on what the
platform should *store* vs. what must exist on paper.

---

## 3. LEGACY-READINESS — can the formula be validated, or should it be retired?

**Why it's blocking:** This is the highest-value item on this list, because it
sits at the centre of a confirmed **HIGH-severity** finding: three separate
"readiness" pipelines exist for the same athlete and none of them connect.

- An athlete's own daily wellness self-report (energy/soreness/focus, 1–5) is
  stored and *explicitly never* feeds a formula score.
- The coach-facing GREEN/YELLOW/RED triage board reads a table populated
  **only by staff manually re-keying numbers during intake.**
- A third formula, registered as `LEGACY-READINESS`
  — `Readiness = max(1, min(10, (Sleep × 1.25) − (Soreness × 0.45) + (Discipline × 0.3)))` —
  is displayed on the operations page as a "certified" live equation but has
  **zero callers** and produces no number anyone ever sees.

So a coach sees a triage colour that is a staff member's typed opinion, with no
idea the athlete self-reported high soreness that morning.

**What's needed — and note the framing carefully:** the question is **not**
"wire this formula in." It is *"can these coefficients be justified for
adolescent athletes, or should the formula be formally retired?"*
- Where does this coefficient set come from? Is there any published basis for
  `1.25 / 0.45 / 0.3`, or is it invented? (Assume invented until proven
  otherwise.)
- What *does* the literature support for subjective-wellness readiness scoring
  in **adolescent** athletes specifically — and is there a validated instrument
  the gym could adopt instead of a bespoke formula?
- Fairness: does any candidate instrument behave differently across age, sex, or
  training age in ways that would matter for a mixed youth roster?
- **Deliverable:** one of three clear recommendations, with citations — (a) adopt
  a named validated instrument, (b) a validation protocol this gym could
  actually run to establish its own, or (c) retire `LEGACY-READINESS` and
  formally document that a governed readiness score does not exist. **(c) is a
  perfectly good answer.** Do not recommend wiring the current coefficients in.

---

## 4. `assessment_protocols` reference data

**Why it's blocking:** The table exists and, thanks to recent provenance work,
already carries a real measurement-properties vocabulary —
`reliability_status`, `validity_status`, `evidence_class`, defaulting toward
*"not established"*. It has **no write path**, so it is an empty frame with the
right shape and nothing in it.

**What's needed:** for the assessments a youth boxing gym would plausibly run
(conditioning, movement screening, skill checks), the actual protocols with
their **published reliability and validity figures** and an honest evidence
class per protocol. Anything you cannot source should be recorded as
not-established rather than filled in — that is the schema's own default and its
intent. **Deliverable:** seed-ready rows, each with its citation and its
measurement properties, plus an explicit list of what you could not establish.

---

## 5. The four blocked formula-registry entries

**Why it's blocking:** `registry.ts` has four entries pre-wired — registry
metadata, types, and `requiredObservationKinds` all present — that cannot run:
**Training Monotony**, **Strain**, **Typical Error**, and **Recommendation
Priority** (CORE-06/07/09, BF-10). They are blocked on two things: a missing
upstream **daily training-load observation stream**, and a policy approval
nobody has sought.

**What's needed:**
- What each of these four actually requires as input, in real units, at what
  cadence — i.e. specify the daily-load observation the platform would have to
  start collecting, precisely enough to design a capture surface from.
- Whether each is **appropriate for minors at all.** Monotony and strain come
  from adult endurance-athlete literature; whether they transfer to adolescent
  boxers is a real question, not a formality.
- Published thresholds — and whether *adolescent-specific* thresholds exist. If
  a metric only has adult norms, say so plainly; that is a finding.
- **Deliverable:** per formula, a go / no-go recommendation with sources, and for
  any "go", the observation spec and the threshold set with its population.

---

## 6. Are the platform's existing youth safety thresholds right?

**Why it's blocking:** Unlike items 1–5 this one is **live in production logic
today**, which makes it the one to check first if you only have time for one.
The formulas engine already computes and stores per-athlete **contact exposure**
and **acute:chronic workload ratio**, and other constants gate real behaviour
(a readiness score below 5.0 triggers protective route/drill constraints; a
delta-RPE of 2 or more engages a lockout until a rationale is provided; a
readiness reading older than 24h is discarded as stale).

Nobody has verified these numbers against published youth guidance.

**What's needed:** for **adolescent boxers specifically** — sparring/contact
exposure limits per week and per session (USA Boxing rules, and any published
guidance on youth head-impact exposure), whether the standard adult
acute:chronic workload ratio bands apply to youth at all, and whether a 24-hour
readiness freshness window is defensible. **Deliverable:** for each constant,
either a citation supporting it, a recommended corrected value with citation, or
an explicit "no published basis exists for a youth population" — and flag
immediately, not at the end, anything you believe is currently set unsafely.

---

## Working agreement

- Deliverables go in `docs/research/` (that directory is treated as yours —
  other agents are instructed not to touch it) as markdown with inline
  citations. Draft PR per item; do not mark ready for review.
- Do **not** change application code, migrations, or any formula's coefficients
  or thresholds. Your output is the evidence base a *separate*, owner-approved
  change would later cite. Recommend; don't implement.
- Prioritise **6 → 1 → 2 → 3 → 5 → 4**: item 6 is already governing live
  decisions about children's training, and items 1 and 2 are actively blocking
  gates being merged this week.
- Where the honest answer is "this cannot be established from published
  evidence," say exactly that and stop. That answer is a deliverable, not a
  failure — and in this codebase it is the answer that gets respected.
