# SHADOW OBSERVATION-CAPTURE VOCABULARY SPEC (v0 · DRAFT · DESIGN-ONLY)

Owner / final authority: Jason / Punxsy Prominence
Produced by: algorithm design lane. No application code, no migrations, no PR modifications, no D10 contact, no Phase B execution.
Every category set below is CANDIDATE until Jason ratifies it (§15).

---

## 1. Control State

- **Main:** e2a55705a2767a1ae8b7e87606eacde7cf6aa1da — the merge commit of #337 (owner-attested)
- **#337:** MERGED / live in main
- **#354:** CLOSED / UNMERGED / superseded
- **#358:** OPEN / MERGEABLE — the live Phase A inference PR (head 8d62eb53367d5ff463a0bc87980845f7896d7751)
- **#355:** OPEN — single-case intervention statistics, stacked on #358
- **#357:** OPEN — observer reliability, stacked on #355
- **Drift corrected:** YES — internal ledger updated; prior statements "#337 untouched and unmerged" and "awaiting an unnamed ChatGPT Phase A PR" are retracted. The live Phase A PR is #358.
- **Verification honesty:** ordered re-fetch of GitHub was attempted from this surface this session and failed (unauthenticated API, rate-limited; repo private). The control state above is therefore **owner-attested, adopted under authority precedence #1**, not independently machine-verified from this seat. No observable difference exists from here, so no DRIFT ALERT is raisable; the first lane with repo access should confirm the five facts above before ratification of this spec.

## 2. Purpose

- **Measurement problem:** SHADOW cannot infer better than PPBF measures. Today an observation's meaning depends on which coach wrote it, in what mood, mixing what-happened with why-they-think-it-happened. Recurrence, attribution, reliability, drift, intervention effect, retention, and transfer all silently degrade when the unit of observation is not stable across coaches, sessions, and time.
- **Algorithm capabilities supported:** deterministic pattern formation (#337), recurrence inference (#358), attribution/stratification, observer reliability (#357), longitudinal drift/baselines, single-case intervention analysis (#355), retention and transfer separation, future calibration of policy values.
- **Explicit non-goals:** no new statistics, no thresholds, no schemas or migrations, no UI, no medical/psychological constructs, no personality or readiness constructs, no D10 contact.

## 3. REDUNDANCY ALERT

Repo inspection is not possible from this seat, so this register is issued as **mandatory verification instructions** rather than verified reuse claims. Rule: if the existing construct is adequate, REUSE — do not create a parallel SHADOW ontology.

| Proposed construct | Likely existing construct (VERIFY IN REPO) | Semantic difference to check | Reuse/consolidation recommendation |
|---|---|---|---|
| SessionRef / session identity | session-script / block / run structures | Does a "run" already identify session+block+round granularity? | REUSE the finest existing granularity as `orderingKey`; do not mint a new session ID |
| Observation record | formulas/ observation model; observation ids consumed by decision outcomes | Whether existing observations carry polarity, observer, source | EXTEND the existing observation type conceptually; never a parallel table |
| Behavior/error/success tags | assessment protocol structures; any drill/skill taxonomy; existing UI labels | UI labels are NOT canonical ontology by default (authority firewall) | If an assessment taxonomy exists, seed the behavior registry FROM it, with Jason ratifying each carried code |
| Context mode (isolated…competition) | session-type / drill-type enums; Quick/Heavy classifier feature inputs | Classifier features may encode task complexity, not observation context | Map, don't merge: classifier features stay classifier features |
| Observer identity | any existing coach/user attribution on notes | Whether attribution is a login artifact vs a semantic field | Promote to semantic field; reuse identity system |
| Session-RPE / load | any RPE/load terminology in repo or docs | Whether RPE exists anywhere yet | If absent, this spec introduces it (session-level only) |
| Intervention / outcome | shadow decision lifecycle (recommendation → decision → outcome) | Organizational decisions ≠ coaching interventions — DO NOT merge (standing semantic boundary) | New concept, but link outcomes via the existing observation-ids mechanism |
| Evidence source / tier | shadowEvidence + evidence-tier vocabulary | Library/citation evidence ≠ coaching observation | REUSE tier vocabulary; keep populations distinct |
| Transfer/retention markers | none known | — | Introduce as DERIVED, not captured |

**Duplicate constructs rejected in advance:** a second session ontology; a SHADOW-only athlete ID; a capture-side "confidence" field; any new decision-outcome object.
**Package note:** repo-canonical `SHADOW_ML_ALGORITHM_STACK.md v1.1` remains **PACKAGE NOT VERIFIED** from this seat. This spec cites the authored v1.1 held by this lane; the verification pass must diff the repo copy against it and raise drift before ratification. `MASTER_INDEX.md` and `SHADOW_AUTHORITY_MODEL.md` were never visible to this seat and must be checked for pre-existing vocabulary decisions that override any candidate here.

## 4. Observation Model

- **Observation:** one record that a defined behavior (stable code) was observed with a stated polarity, by an identified observer, from an identified source, within an identified session/ordering position and context envelope. It records WHAT WAS SEEN only.
- **Opportunity:** a moment in which the behavior's observable definition could have manifested. The denominator concept. Mostly implicit; made explicit only in designated focus/co-rated rounds (§9, §10).
- **Counterexample:** successful contrary execution **within a genuine opportunity** — an affirmative record, never inferred from silence.
- **Context:** the axis values in force at capture (mode, round, partner class, session type). Context supports association; it asserts no cause.
- **Interpretation:** a human hypothesis LINKED TO observations ("possible fatigue-linked breakdown"). Stored separately; may be wrong; never overwrites or edits the observation.
- **Intervention:** a deliberate coaching action with a declared target behavior, start event, exposure log, and fidelity notes.
- **Outcome:** later observations falling in declared post-intervention windows. Computed relationship — never an edit to the originals, never a captured opinion field.
- **Retention:** outcome observations in a declared retention check after a gap, with the cue deliberately not re-coached that session.
- **Transfer:** outcome observations whose context mode differs from the context in which the intervention was trained. Derived, never hand-tagged.

**Core separation (the one rule that carries everything): A. what was observed ≠ B. context ≠ C. interpretation ≠ D. intervention ≠ E. outcome.** One coach note that fuses them is a story; five separated records are data.

## 5. Minimum Observation Envelope

| Field | Meaning | Required? | Controlled/free/derived | Unknown allowed? | Authority |
|---|---|---|---|---|---|
| athleteRef | Which athlete | REQUIRED | controlled (roster) | no | existing roster |
| sessionRef | Which session | REQUIRED | controlled | no | existing session structure |
| orderingKey | Round # or time-in-session position | REQUIRED | controlled | yes (`?`) | session structure |
| observerRef | Who recorded it | REQUIRED | controlled | no | identity system |
| source | HUMAN_LIVE / HUMAN_VIDEO / MACHINE | REQUIRED | controlled | no | this spec |
| behaviorCode | Stable code from the registry | REQUIRED | controlled | no | behavior registry (Jason-ratified) |
| polarity | OCCURRED / COUNTEREXAMPLE / NO_OCCURRENCE_WITH_OPPORTUNITY / NOT_OBSERVABLE / NO_OPPORTUNITY | REQUIRED (last three only expected in focus rounds) | controlled | via NOT_OBSERVABLE | this spec |
| contextMode | Task context class (§6 axis) | REQUIRED | controlled (CANDIDATE set) | yes | Jason ratifies set |
| taskRef | Specific drill/task | OPTIONAL | controlled if taxonomy exists | yes | existing drill taxonomy |
| partnerClass | Stance / relative experience band / relative size band | OPTIONAL | controlled | yes / N.A. | Jason ratifies bands |
| partnerRef | Partner identity (internal roster link only) | OPTIONAL | controlled | yes / N.A. | roster + privacy policy |
| note | Free text supporting context | OPTIONAL | free | — | never canonical |
| coRatingGroupId | Links independent ratings of the same unit | OPTIONAL | controlled | yes | §9 protocol |
| interventionRef | Links exposure to an active intervention | OPTIONAL | controlled | yes | §10 protocol |
| sessionRPE | Athlete-reported 0–10, once, end of session (separate session-level record, not per-observation) | REQUIRED at session level | controlled scale | yes | this spec + youth wording Jason ratifies |
| sessionMinutes | Session duration | REQUIRED at session level | controlled | yes | session structure |

Absence of a record asserts nothing. Blank is never zero.

## 6. Context Axis Register

| Axis | Status | Purpose | Measurement risk | Recommendation |
|---|---|---|---|---|
| Drill/task type | OPTIONAL | Fine-grained stratification | Taxonomy sprawl | Use existing drill taxonomy if present; else defer detail to contextMode |
| Isolated vs constrained vs live (contextMode) | **REQUIRED** | The load-bearing stratification + transfer axis | Category boundary disputes | CANDIDATE set: ISOLATED_DRILL / PARTNER_DRILL / CONSTRAINED_LIVE / OPEN_LIVE / SPARRING / COMPETITION — Jason ratifies, smallest defensible set wins |
| Fatigue band | **REJECT as captured** | — | Fake precision; coaches cannot validly observe physiological state | Exists only as a future DERIVED construct (§8) |
| Session-RPE | REQUIRED (session-level) | Load context; only validated self-report available at zero cost | Youth comprehension; gaming | One question, end of session; youth-appropriate wording ratified by Jason |
| Round # / time-in-session | REQUIRED | Objective within-session position; the honest fatigue proxy | Minimal | Capture as orderingKey |
| Partner identity | OPTIONAL | Attribution edge cases | Minors' privacy; dossier creep | Internal roster ref only; UNKNOWN/N.A. freely allowed |
| Partner style/stance | OPTIONAL | Stratification (e.g., southpaw) | Low | Class attributes preferred over identity |
| Coach/observer | REQUIRED | Reliability (#357), source diversity | None | Non-negotiable from day one |
| Machine/video source | REQUIRED (as `source`) | Keeps machine out of human-agreement stats | Conflation | Enum, not boolean |
| Session type | REQUIRED-lite | Training vs competition split | Low | Fold into contextMode (COMPETITION) + session metadata |
| Competition vs training | REQUIRED | Injury/exposure and generalization boundaries | Low | Covered by contextMode |
| Intervention exposure | REQUIRED once interventions exist | SCD phases (#355) | Forgetting to log | Lightweight tally (§10) |
| Before/after intervention | **DERIVED** | Phase assignment | Hand-tagging drifts | Computed from timestamps vs start event — never hand-coded |
| Retention session | OPTIONAL flag (scheduled) | Retention checks | Re-cueing contaminates | Declared per §10, with no-recue rule |
| Transfer context | **DERIVED** | Transfer evidence | Hand-tagging bias | Computed: outcome contextMode ≠ trained contextMode |

## 7. Behavior Vocabulary Contract

- **Stable identity:** opaque stable code + human label + category (CANDIDATE categories: defense / offense / footwork / ring-craft / engagement — unratified) + observable definition + polarity semantics + aliases + version + state (active/deprecated/superseded).
- **Atomicity rule:** one observable event per code. No conjunctions, no causal clauses, no mental-state verbs. "Gets tired and loses focus because confidence is low" fails three ways; "lead hand does not return to guard after jab" passes. (Examples are design illustrations, not approved PPBF tags.)
- **Observable-definition rule:** a code ships only with a definition two coaches could apply to the same round independently and usually agree — the definition is the reliability instrument.
- **Diagnosis/causation firewall:** canonical tags name behavior, never diagnosis, cause, character, or state of mind. "Because," "confidence," "lazy," "scared," "hurt" cannot appear in a canonical tag; they belong (if anywhere) in interpretation records.
- **Alias/version rule:** meanings are immutable. A changed meaning = a NEW code with a `supersedes` link; the old code deprecates but historical observations keep their original meaning forever.
- **Deprecation rule:** deprecated codes stop being offered for capture but never vanish from history or analysis.
- **Free-text relationship:** notes are welcome, searchable, and feed future propose-only extraction — but are never parsed into canonical fields without a human confirm event.
- **Governance (owner decision):** any coach may propose a code; Jason ratifies; the registry is versioned. Start small: a coach-drafted starter registry of ≤10 codes beats an AI-drafted 100.

## 8. Fatigue / Load Model

- **What can be observed:** round number, time-in-session, exposure counts (rounds sparred, drills completed), visible task degradation *as behavior codes* (e.g., a hands-drop code occurring late) — not "fatigue" itself.
- **What can be self-reported:** session-RPE (0–10, end of session). Optionally per-round RPE in designated focus rounds only — sparingly, it costs attention.
- **What can be derived:** session load = RPE × minutes; within-session position bands (early/mid/late thirds from orderingKey) — positional facts, not physiological claims; rolling exposure summaries.
- **What cannot yet be claimed:** any objective "fatigue state." A derived FATIGUE-PROXY band (e.g., late-position + high-load) may be defined later as an explicitly DERIVED construct, ratifiable only when local evidence links the proxy to performance decrement. Session-RPE never silently becomes an objective fatigue fact — that transformation is prohibited.

## 9. Observer Reliability Capture Protocol (supports #357)

- **Unit of rating:** (sessionRef, designated round/block, athleteRef, behaviorCode). Reliability is computed per unit, never per vibe.
- **Independent rating requirement:** both observers watch the same designated round, record on separate sheets/devices, and submit before comparing. No conferring until both are in. Late edits after seeing the other rating invalidate the unit.
- **Co-rating protocol:** co-rated rounds are scheduled and few (cadence = owner decision, not a spec constant). During co-rated rounds only, observers use the full polarity set including NO_OCCURRENCE_WITH_OPPORTUNITY — this is where opportunity denominators actually get measured.
- **Machine-source handling:** MACHINE/HUMAN_VIDEO sources are excluded from human inter-rater statistics; human-vs-video comparison is its own separate track.
- **Missingness:** a missing rating is missing — never imputed, never counted as agreement.
- **Disagreements:** both records persist untouched. Disagreement is data (it feeds contested/attribution machinery); it is never resolved by deleting a record.

## 10. Intervention / SCD Capture Protocol (supports #355)

- **Baseline:** ordinary capture during the pre-intervention period. No special baseline fields; the phase is derived from the start event. Required counts of baseline sessions/observations are POLICY questions (promotion policy sheet), not vocabulary — deliberately not baked in here.
- **Intervention exposure:** an intervention record = {athleteRef, target behaviorCode, cue/action description, start event}; each session it's applied adds a lightweight exposure tally.
- **Fidelity:** per-session Y / PARTIAL / N — was the cue applied as intended. One mark, not an essay.
- **Outcome direction:** never captured as opinion. Computed later from observations in derived post-phase windows.
- **Retention:** a scheduled session flagged RETENTION for that intervention, with the operational rule "do not coach that cue this session." Observations there are ordinary observations; the flag does the work.
- **Transfer:** derived — post-phase observations whose contextMode differs from the trained context. No hand-tagged "transfer" field exists.

## 11. Attribution Boundary

- **Context association:** "occurs mostly in OPEN_LIVE, late rounds, vs southpaw partners" — a stratified pattern the data can genuinely show.
- **Causal attribution:** "fatigue causes it," "southpaws cause it" — claims requiring the contested/attribution machinery, counterexample handling, and human review. The vocabulary never encodes them.
- **Prohibited inference:** context label → cause; association → trait; occurrence → character. Context axes are nouns of circumstance; they are never verbs of cause. Any capture-side field implying causation is rejected by this spec.

## 12. Paper / Spreadsheet Protocol (usable tomorrow)

**Session sheet (one page):**
- Header: date · sessionRef · coach (observer) · session type · minutes · athletes present (roster codes).
- Observation lines (one row each, ~10–15 seconds to write):
  `round | athlete | behavior code | polarity (✓ occurred · ✗ counterexample · ○ no-occurrence-with-opportunity [focus rounds only] · ? not observable) | context mode letter | partner (code or N.A.) | note (optional)`
- Footer, per athlete: session-RPE ("How hard was today, 0–10?") — one number.
- Printed rule on every sheet: **"Record what you saw, not why it happened."**

**Intervention half-sheet (separate, one per active intervention):** athlete · target behavior code · cue description · start date · per-session exposure tally · fidelity Y/P/N.

**Co-rating:** designated round announced in advance; two coaches, separate sheets, no talking until both hand in; those rounds use the full polarity set.

**Mandatory fields:** athlete, behavior code, polarity, context mode, observer (header), session (header). **Optional:** round, partner, note. **Unknown:** written `?` — a blank is not a zero, ever. Interpretations, if a coach wants them recorded, go on the back of the sheet referencing line numbers — never in the observation row.

## 13. Future Machine Contract (design only — no schemas, no migrations)

Reuse existing repo types wherever they exist; names below are semantic placeholders:

- **ObservationEnvelope** — the §5 table, as fields on (an extension of) the existing observation model. UNKNOWN semantics: explicit `UNKNOWN`/`NOT_APPLICABLE` values, never null-means-no.
- **ContextEnvelope** — contextMode (controlled), taskRef (existing taxonomy), orderingKey, partnerClass, partnerRef (privacy-scoped), competition flag. Source of truth: session structure + this spec's ratified sets.
- **BehaviorDefinition** — code, label, category, observableDefinition, polaritySemantics, aliases[], version, state, supersedes. Source of truth: Jason-ratified registry. Authority owner: Jason.
- **ObservationSource** — HUMAN_LIVE / HUMAN_VIDEO / MACHINE + observerRef/modelRef + (for machine) version. Authority: this spec; machine entries carry AI-interpretation tier by default.
- **InterventionExposure** — interventionRef, sessionRef, exposureTally, fidelity. Authority: coaching staff records; Jason ratifies the construct.
- **OutcomeObservation** — not a new record type: ordinary ObservationEnvelopes selected by derived phase/retention/transfer logic, linked through the existing observation-ids mechanism on decision outcomes.

Every controlled set carries: name, semantic definition, controlled/free/derived class, required/optional, source of truth, UNKNOWN semantics, authority owner — as instantiated in §5/§6.

## 14. Measurement Defects Exposed in Current Algorithm

**Defect 1 — Missing denominators (opportunity blindness).**
Current assumption: recurrence inference (Beta-Binomial-style) presumes trials, i.e., opportunities. Capture problem: coaches realistically log occurrences, not opportunities; absence of a record is ambiguous across "didn't happen," "couldn't happen," and "wasn't watched." Algorithm impact: occurrence-only streams bias recurrence posteriors by exposure — a busy athlete looks worse. Corrective work: opportunity-aware polarity captured in focus/co-rated rounds (this spec) + an engine rule that absence-of-record is NEVER counterevidence + exposure-aware normalization where denominators are absent. Requires code change now: **NO** — but #358's cross-review must confirm how its inference treats absence; if it treats silence as evidence, that is an ALGORITHM INPUT DEFECT to raise on the PR.

**Defect 2 — Non-independent repeat ticks.**
Current assumption: observations are independent trials. Capture problem: one breakdown episode can generate several ticks in one round. Impact: inflated certainty. Corrective: define the observational unit as one behavior-per-round-episode unless genuinely distinct opportunities; sheet guidance enforces it. Code change now: **NO** (capture-side rule; #358 review notes it).

**Defect 3 — Observer pooling without source.**
Current assumption: pooled observations are exchangeable. Capture problem: pre-#357 there is no reliability adjustment, and any record missing observer identity can't ever be adjusted. Impact: observer bias reads as athlete signal. Corrective: observer + source REQUIRED from day one (this spec); #357 consumes it later. Code change now: **NO**.

**Defect 4 — Legacy/free-text ingestion.**
Current assumption: none yet, but pressure will come. Problem: historical notes lack controlled axes and polarity; they cannot enter recurrence streams. Corrective: legacy material routes to Library/staging only (already the Phase B design); restated here as a vocabulary boundary. Code change now: **NO**.

**Defect 5 — Session-RPE granularity.**
Assumption risk: treating one end-of-session RPE as a per-round fatigue signal. Corrective: orderingKey is the only within-session position variable; RPE stratifies sessions, not rounds. Code change now: **NO** — written into the vocabulary.

## 15. Owner Decisions Required

1. Ratify the contextMode category set (or a smaller one).
2. Ratify behavior-registry governance: coaches propose, Jason ratifies, versioned; and commission the coach-drafted starter registry (≤10 codes).
3. Ratify session-RPE youth wording and its use at session level.
4. Set the co-rating cadence (scheduling, not statistics).
5. Ratify the partner-data policy: class-attributes-only vs identity-linked (minors default: class-only unless a concrete need exists).
6. Adopt (or amend) the paper sheet for a pilot.

## 16. Recommended Ratification Sequence

- **Adoptable immediately as measurement semantics** (they assert no empirical claims): the A–E separation; observation/opportunity/counterexample definitions; polarity set; unknown-is-not-zero; free-text-is-not-canonical; meaning-immutable versioning; the attribution boundary; the fatigue non-claims.
- **Owner ratification before use:** contextMode set; starter behavior registry; RPE wording; partner policy; co-rating cadence; the paper sheet itself.
- **Research/calibration later, never by default:** any derived fatigue band; any opportunity-sampling statistics; any numeric anything.

## 17. Smallest Useful Next Action

Run **one week of paper capture in a single program** using the §12 sheet, with a coach-drafted starter registry of no more than ten behavior codes, including one scheduled co-rated round — then return the filled sheets for defect review before anything is digitized.

---

# STATE DELTA

**Changed:** control ledger corrected to owner-attested state (main = e2a5570…, #337 merged, #358 live Phase A inference, #355/#357 stacked); Observation-Capture Vocabulary Spec v0 drafted, design-only.
**Superseded:** prior ledger entries "#337 open/unmerged" and "awaiting an unnamed ChatGPT Phase A PR"; the prior default STATE DELTA field set for this deliverable.
**Current algorithm stack:** main (#337 pattern-formation foundation) → #358 Phase A inference → #355 single-case intervention statistics → #357 observer reliability; #354 closed/superseded. Owner-attested; independent re-fetch from this seat failed (unauthenticated) — first repo-capable lane confirms.
**Next:** cross-review of #358 when its diff + deliverable report arrive (standing checklist applies; extensions for #355/#357 review are now queued, and §14's Defects 1–3 are named review probes for those PRs); coach starter registry + one-week paper pilot per §17.
**Package/spec gate:** repo-canonical SHADOW_ML_ALGORITHM_STACK.md v1.1 remains NOT VERIFIED from this seat — verification pass must diff it against the authored copy; this vocabulary spec is DRAFT pending §15 ratifications.
**Research/calibration gate:** nothing ratified; no thresholds introduced; derived fatigue band defined but explicitly unratified; #345 boundary intact — research state changes nothing here.
**Safety/D10:** untouched. The capture envelope contains no medical, psychological, personality, or clearance constructs by design; partner data minimized for minors; interpretation layer firewalled from canonical data.
