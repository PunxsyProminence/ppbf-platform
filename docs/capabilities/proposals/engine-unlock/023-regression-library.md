# Engine Unlock Proposal — Module 023 Regression Library

## Status

PROPOSAL — awaiting owner approval. No code in this proposal.

The module stub (`docs/capabilities/modules/023-regression-library.md`) currently says nothing: Status DRAFT, Active false, and every section (Intent, Dependencies, Acceptance criteria) is the unfilled scaffold template from the 2026-08-03 stub-creation script — only the audit log has an entry, and it is that same scaffold note.

## (a) What the engine computes and shows

**This module computes nothing.** "Regression Library" names a piece of coaching *content* — an easier variant of a movement that preserves the drill's intended lesson — not a calculation over athlete records. That distinction is load-bearing for the rest of this proposal, so it is stated plainly up front: there is no formula, threshold, or model anywhere in this proposal. If built, module 023 is a **read-only browse/search surface over already-authored regression content**, exactly the shape of module 114 (Coach Cue Library): `listCueLibrary`-style org-scoped read, no computation, no generation.

What it would show, using real columns:
- `pilot.drill_library` rows (`drill_id`, `name`, `category`, `discipline`, `target_behavior`, `difficulty`) — the drill being regressed.
- `pilot.drill_scale_levels` rows where `scale_level = 'A'` — per the v3 schema's own doctrine, A is "simplified picture, controlled success; the target behaviour is felt and repeated cleanly," the *only* structure in the current schema that resembles a "regression": same drill, same `target_behavior`, reduced `demand_description`/`constraint_applied`, with `coach_watch_point` and `authoring_state` (`'authored'` vs `'scaffold_needs_coach_review'`).
- `pilot.drill_cues` rows attached to that drill (`cue_text`, `cue_family`, `focus_type`) — coaching language for delivering the regressed version.
- `pilot.drill_stop_rules` rows — when to stop even the regressed version.

**What it does NOT do:**
- Does not decide, infer, or suggest that a *specific athlete* needs a regression. That is module 62 (Skill Regression Engine) — a separate, also-unbuilt, computation-shaped module — and module 023's stop/hold sibling explicitly disclaims this: `pilot_slice_postgres_training_holds_migration.sql` states "content regression belongs to capabilities #23/#62," and `082-stop-hold-regress-engine.md` states "Does not own skill-content regression — that is #23 Regression Library / #62 Skill Regression Engine."
- Does not gate or restrict training intensity. That is module 82 (`pilot.training_holds`, already built), which is an enforcement mechanism, not content.
- Does not compute failure rates, readiness, or any derived signal from `pilot.training_attempts` to auto-trigger a regression recommendation.
- Does not invent an easier variant of a movement that no human authored. There is currently **no table anywhere in the schema** storing a "drill X is the regression of drill Y" relationship between two distinct movements. `pilot.drill_scale_levels` A/B/C is same-drill demand scaling authored at drill-creation time by a human (or an AI draft explicitly requiring floor validation via `field_provenance`) — it is not a cross-drill substitution catalog, and building the latter is new authored content, not a data-accumulation feature.

## (b) Data prerequisites

The real prerequisite here is **authored content**, not accumulated athlete data. Both tables below are framed accordingly, per instruction.

**PER ORG — content prerequisite**

| Signal | Source table.column | Minimum records | Over what timespan | Why this threshold |
|---|---|---|---|---|
| At least one drill has an authored (not draft) regression variant | `pilot.drill_library.active` (=true) joined to `pilot.drill_scale_levels.scale_level='A'`, `.authoring_state='authored'` | ≥ 1 | N/A — content state, not time-windowed | An org with zero authored A-level rows has nothing to browse; "library" implies at least one entry, not a schedule to wait out. |
| The parent drill has cleared floor validation | `pilot.drill_library.field_provenance` = `'PPBF source manual v3'` (human-authored), not one of the two DRAFT provenance strings | all rows shown | N/A | The v3 migration's own comment: literature-grounded and coaching-craft rows are DRAFT and "REQUIRE FLOOR VALIDATION" before reaching an athlete-facing or even coach-facing production surface. Showing an unvalidated draft as "the regression" would be presenting unreviewed AI-authored content as coaching doctrine — refused by the honesty doctrine. OWNER_DECISION: whether validated-only is a hard gate or a visibly-labeled soft one. |
| A cross-drill (not same-drill) regression relationship exists | **No table.column exists today.** | — | — | This is the content prerequisite that does not yet exist at all: nothing in the schema links one *distinct* drill to another as its easier substitute. Building this is a new authoring surface, not a threshold to reach. See open question 1. |

**PER ATHLETE — data prerequisite**

| Signal | Source table.column | Minimum records | Over what timespan | Why this threshold |
|---|---|---|---|---|
| Athlete has an active assignment of a drill that has an authored regression | `pilot.drill_assignments.athlete_id` + `.drill_id` → **cannot currently join to `pilot.drill_library`** | — | — | `pilot.drill_assignments.drill_id` is a composite FK to `pilot.drills` (the older, four-field catalog created by `pilot_slice_postgres_drills_migration.sql`), **not** to `pilot.drill_library` (the v3 catalog that actually holds `drill_scale_levels`/`drill_cues`/`drill_stop_rules`). These are two separate, unmerged tables per the v3 migration's own header ("This is a NEW, SEPARATE table ... neither migrates into the other here"). There is structurally no way today to compute "the regressable drills this athlete is currently assigned" — this is a VERIFIED_GAP, not a threshold. See open question 2. |
| (if the gap above is closed) count of the athlete's active assignments referencing a drill with an authored A-level row | hypothetical, post-fix | ≥ 1 | current assignments only (no historical minimum — this is existence, not a trend) | Once linked, the unlock condition is existence, not volume: one relevant assignment is enough to make "your regression view" meaningful; there is no honesty reason to require more than one, since this is a content lookup, not a statistical claim. |

Per-athlete accumulated *data* (session counts, attempt counts, readiness history) has **no role** in this module's unlock at all — that would be conflating a content browse feature with the data-threshold pattern used by computation modules like 020. Flagging that conflation explicitly so it is not copied in review.

## (c) LOCKED state

What the coach/athlete sees before content exists (org-level, since content is org-wide, not athlete-personal):

> "Regression Library — 0 of \[N\] active drills have an authored simplified variant yet."

Real counts only: a live count of `pilot.drill_library` rows with `active=true` versus the count of those that also have a `pilot.drill_scale_levels` row with `scale_level='A'` and `authoring_state='authored'`. No XP, no levels, no percentage-complete bar implying inevitability — just "X of Y drills have a regression on file."

The specific unblocking action, stated as what it is: a coach or curriculum author records an A-level demand row for a drill (an insert into `pilot.drill_scale_levels` with `authoring_state='authored'`, going through whatever authoring surface the owner approves — see open question 1). This action already has schema support; only the *browsing* module described here is missing, so the LOCKED state's call to action points at content authorship, not at waiting for more athlete data to accumulate — because none is required.

At the athlete level, if the FK gap in (b) is closed and an athlete has zero currently-assigned drills with an authored regression, the athlete sees nothing resembling a locked feature at all — a coaching-content browse with zero relevant entries is simply empty, not a countdown, and should say so plainly ("No regression variants are on file for your current drills") rather than imply progress toward an unlock.

Engagement doctrine followed: no streaks, no gamified progress toward "unlocking" this feature. It either has content to show or it does not.

## (d) What unlocks

### At athlete level (own record only)

If the schema gap in (b) is closed, an athlete (or their coach, viewing with them) may see: for each drill **currently assigned to that athlete**, the authored A-level demand description, coach watch-point, and cues for that drill — filtered to the athlete's own active assignments, never a general gym-wide catalog browse. This is the athlete-safe framing required by the doctrine: the athlete is shown a personally-filtered slice of shared coaching content, not their own computed data, and not other athletes' assignments or any comparison across athletes.

**Never unlocks for the athlete, at any level:** a system-generated suggestion that *they specifically* should use a regression right now. That is a coach judgment call (module 62's domain, unbuilt, and even if built would still require a human decision per the platform's no-auto-approval rule) or a training-hold decision (module 82, humans only place/lift holds). This module may show that a regression *exists* for a drill; it may never say "you should use it" — that sentence, from a model, to a minor, is exactly what the no-AI-auto-approval-of-progression rule forecloses.

### At org / coach level

Full browse/search over the org's regression content, org-scoped, staff roles (`coach`, `organization_admin`, `admin`) — mirroring module 114's role posture: grouped by drill/category, filterable, with drill attribution, and with the DRAFT/floor-validation state of each row visibly labeled rather than hidden. Authoring stays wherever the owner decides it lives (see open question 1) — this module is display-only, matching the "authoring stays on the drill" precedent set by module 114.

**Stays locked forever, regardless of data or content volume:**
- No AI-authored regression content reaches an athlete-facing or production coach surface without passing `field_provenance = 'PPBF source manual v3'` or an explicit human floor-validation step — draft content is labeled draft, never silently promoted.
- No model ever proposes a regression for a named athlete without a coach's explicit action creating that record (this module has no write path at all in the current proposal; it is read-only).
- No cross-athlete view, ranking, or "athletes who needed a regression" list, at any role, ever.
- No effectiveness/success score attached to a regression variant (echoing `pilot.drill_version_outcomes`'s own refusal to hold an effectiveness score for drill versioning generally — the same non-invented-metric doctrine applies here).

## (e) Open questions for the owner

1. **Who authors regression content, and what counts as "the" regression?** Two structures currently compete for the name:
   - **Option A — reuse `pilot.drill_scale_levels` scale_level='A'.** Cheapest: the v3 schema already has this, some rows may already be seeded from the source manual, and "A" is explicitly documented as the simplified/controlled-success version of the same drill. Downside: this is demand-scaling *within* a drill, not a substitute movement — it will not cover a case like "this athlete cannot yet do a pull-up at all, show the assisted-row regression" where the honest content is a genuinely different drill.
   - **Option B — build a new explicit drill-to-drill "regression_of" link, authored by coaches/curriculum staff.** Correct in principle, matches the module's actual intent, but is net-new schema and a net-new authoring workflow — real scope, not a browse feature.
   - **Option C — defer module 023 entirely** (it already sits outside the P0–P2 priority order in `CAPABILITY_BUILD_PLAYBOOK.md`; P3 explicitly defers "advanced engines ... until design review").
   - **Recommendation:** ship Option A first as the literal, honestly-labeled MVP ("regression" = A-level demand reduction on the same drill, explicitly captioned as such, not as "an easier movement"), and treat Option B as a distinct future proposal once the owner decides regression content needs to cross drill boundaries. Do not silently blur A into "the" general-purpose regression concept in UI copy.

2. **The athlete-personal filter is structurally blocked today.** `pilot.drill_assignments.drill_id` FKs to `pilot.drills` (legacy catalog), not `pilot.drill_library` (the catalog that actually holds scale levels/cues/stop rules) — the two were built as separate, unmerged tables. Options:
   - **Option A — ship org/coach-level browse only in v1**, and mark the athlete-personal view explicitly blocked pending a schema decision. No new columns, no guessed joins.
   - **Option B — add a `drill_library_id` FK to `drill_assignments`** so assignments can point at v3 drills. Real schema work, out of scope for this proposal, and a decision the drills-migration author flagged as "a product decision outside this migration's scope."
   - **Option C — match by `drill_assignments.drill_name` against `drill_library.name` as a string join.** Fragile and exactly the anchor-ambiguity problem `pilot_slice_postgres_drills_migration.sql` was written to eliminate; not recommended.
   - **Recommendation:** Option A now; revisit Option B only if/when assignments are migrated onto `drill_library` for other reasons.

3. **Should this content ever reach athletes directly, or coach-only like module 026's ledger?** Coaching-cue precedent (module 114) reached athletes are not addressed either — module 114's stub doesn't specify a role gate beyond "coach system." Options:
   - **Option A — coach/staff-only**, matching modules 26/62/82's posture that content about training adjustments is a staff tool.
   - **Option B — athlete-visible, filtered to their own current assignments** (per (d) above), on the theory that seeing "there's an easier way to do this drill and here's what good looks like" is pride-in-one's-own-training material, not clinical detail.
   - **Recommendation:** Option B, but only after open question 2 is resolved — an athlete-visible feature that cannot actually be scoped to the athlete's own assignments should not ship as athlete-facing at all.
