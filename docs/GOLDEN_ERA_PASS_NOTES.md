# Batch: admin-consoles

## Files converted (all under `apps/web/app`, all ink ground)

1. **`admin/shadow/page.tsx`** (2125 lines, kept as one file per instruction)
   - Finished the partial SHADOW-console pass. The file was already token-clean
     (no hexes, no legacy aliases) but full of hand-rolled panels and 37
     ambiguous `text-[var(--x)]` utilities that Tailwind v4 silently drops.
   - All `border-4 border-brass bg-[var(--hide-950)]/70` panels → `.mat-leather`
     panels on the Fibonacci radius/space scales; the flagship Data Intake +
     Command Console section is now a riveted `.frame` + `.frame-in .mat-leather`.
   - Console log stream → `.mat-slate` board with `.t-data` (auditable mono
     voice) entries; command bar and pending-import queue → `.mat-leather--raised`.
   - Every hand-rolled chip → `.badge` with glyph + uppercase label (Law 3):
     intake status (Pending ▲ restricted / Approved ✓ cleared / Rejected ✕
     locked / Imported ◉ monitor), document security verdicts (clean/quarantined/
     unreviewed), feature unlock state, library flag outcomes, feedback
     helpfulness, and the Jason-review gate. `reviewStateChip`/`statusChipClasses`
     became `reviewStateBadge`/`statusBadge` (pure style helpers; no logic change).
   - Green-tinted chrome purged (Law 2): `rgba(63,125,78,…)` panel borders,
     `--cleared-ink` metric numbers, green-bordered approve buttons, rust/red
     button faces on plain chrome actions. Metric values are bone; chrome is brass.
   - All small hand-rolled `h-9`/`h-11` buttons → `.btn--lever`; primary submits
     (Submit Command, Upload PDF) → `.btn`; footer links → `.btn btn--ghost`.
   - All selects/inputs/textareas → `.select`/`.input`/`.textarea` with
     `.field` + `.t-label`; error paragraphs → `.alert alert--critical` with
     ✕ glyph (metrics refusal note kept `role="status"`, now `.alert--warning` ▲).
   - Type voices: `.t-eyebrow` for panel eyebrows, `.t-command` (inline
     `fontSize` off the √φ ladder, matching `app/admin/page.tsx`) for headings,
     `.t-body`/`.t-muted`/`.t-data` elsewhere. All ambiguous `text-[var(--x)]`
     removed.
   - Logic, fetches, keyboard shortcuts (V/A/R/I), refs, telemetry, refusal
     copy, and `role` attributes untouched.

2. **`admin/platform/page.tsx`** — was fully legacy (canvas-tan ground, white
   rounded-[28px] cards, `--red-highlight` hovers, `--safety-locked` feedback).
   Rebuilt as an ink console/dashboard: `room--office` main on `--hide-950`,
   `.mat-leather` sections, `.btn`/`.btn--ghost`, `.field`+`.t-label`+
   `.input`/`.select`, KPI tiles on hide-900, feedback → `.alert` with
   ✓/✕/◉ glyphs. Loading and access-denied branches converted too.

3. **`admin/platform/overview/page.tsx`** — same legacy canvas-white treatment;
   now ink with a `.mat-leather` table shell, `.t-label` column heads, `.t-data`
   metric cells, `.alert--critical` load error, per-gym error cells carry a ▲
   glyph instead of red-only text.

4. **`admin/compliance-center/page.tsx`** — table shape inside
   `RoleStandaloneView` (room="clinic", unchanged). Severity and workflow
   status now ride the badge ladder (critical ✕ locked, high ▲ restricted,
   medium ◉ monitor, low ✓ cleared; new ▲ / acknowledged ◉ / escalated ✕ /
   resolved ✓ / dismissed ◉) instead of paper-tinted card backgrounds with
   ink-on-cream text. Filter chips at 44px with `aria-pressed`; escalation
   modal is a riveted `.frame`; empty state uses `.empty`. The two
   colour-only helper functions were replaced by badge maps (style-only).

5. **`admin/public-interest/page.tsx`** — table shape in `RoleStandaloneView`.
   Header → `.mat-leather` (removed the one hardcoded `#111`), review-state
   chip → `.badge` (new ▲ restricted, contacted ✓ cleared, archived ◉ monitor),
   rows → `.mat-leather--raised`, actions → `.btn--lever` at 44px, error →
   `.alert--critical`, filter chips at 44px with `aria-pressed`.

6. **`admin/volunteer-management/page.tsx`** — was on the family canvas ground
   (`--canvas-tan`, `--black`, `--gray-dark`, `--accent-strong`); PAGE_MAP says
   ink. Now `room--office` ink main (same pattern as `app/admin/page.tsx`),
   `.mat-leather` header/form panels, KPI tiles, volunteer cards as
   `.mat-leather--raised` with a status `.badge`, form fields as
   `.field`+`.t-label`+`.input`/`.textarea`, create → `.btn`, row status
   actions → `.btn--lever` at 44px.

## Verification

- Greps across all six files: zero `#hex`, zero `--red-primary`, `--canvas-tan`,
  `--safety-locked`, `--gray-*`, `--olive-*`, `--white*`, `--text-sm|lg`,
  `--black`, `--accent*`, `--shadow-*`; zero ambiguous `text-[var(--x)]`; zero
  off-scale radii (`rounded-full/2xl/[28px]` etc.); zero leftover `h-9`/`h-11`
  hand-rolled controls. (One `#123` match in shadow is a comment referencing an
  issue number, not a hex.)
- `npm run typecheck` passes (exit 0). Note: one transient failure during the
  run came from `components/ParentHub.tsx`, which a concurrent workstream was
  editing — not a file in this batch; it resolved before the final run.
- `npx eslint` on the six files: no errors, no warnings.

## DS gaps found (things ppbf.css could grow)

- **No compact danger control.** `.btn--danger` exists only at full `.btn`
  size; there is no `.btn--lever` danger rung for row-level destructive
  actions (Quarantine, Reject). I kept those as plain `.btn--lever` — the
  uppercase label carries the meaning — but a sanctioned compact destructive
  variant would let queue rows keep Law 2 signal without hand-rolling.
- **No neutral/idle badge rung.** The ladder is cleared/monitor/restricted/
  locked; states like "archived"/"dismissed"/"inactive" have no neutral rung,
  so they borrow `badge--monitor`. A fifth, hide-toned rung (e.g.
  `badge--filed`) would stop monitor blue from meaning both "watching" and
  "closed".
- **`.alert` inherits `margin: var(--s5) 0`,** which is heavier than ideal for
  inline field-level errors inside compact panels; a `.alert--tight` modifier
  would help.
- **`.t-command` sizes only via inline `style={{ fontSize }}`** because the
  sheet is unlayered and beats Tailwind's `text-[length:…]` utilities for
  properties both set; heading sizes therefore ride inline styles (the
  `app/admin/page.tsx` precedent). Sized variants (`.t-command--lg/--xl`)
  would remove the inline styles.

## Deliberately left / notes

- `admin/shadow` keeps its pre-existing nested `<main>` inside
  `RoleStandaloneView`'s `<main>` — pre-existing markup; changing the element
  is a structural edit outside a reskin.
- The shadow page's brass informational notes (platform-owner read-only
  refusal, retry-promotion notice) remain brass text: they are chrome-voiced
  guidance, not safety states, and now carry no saturated status colour.
- `RoleStandaloneView`, `FeatureSurface`, `globals.css`, `ppbf.css` untouched,
  as required. No exports renamed; all fetches, handlers, telemetry, keyboard
  shortcuts, test hooks, and ARIA retained (a few `aria-pressed`/`role="group"`
  and `.t-label` field labels were added, none removed).
- `npm run sweep` was not run: it needs a running dev server, which this batch
  did not start (other agents are concurrently editing the same app). Risk:
  contrast regressions the greps cannot see; recommend a sweep of
  `/admin/shadow`, `/admin/platform`, `/admin/platform/overview`,
  `/admin/compliance-center`, `/admin/public-interest`,
  `/admin/volunteer-management` against a baseline ref once the tree settles.
- Concurrent workstreams are editing sibling files in the same checkout
  (`admin/people`, `admin/pin`, `admin/organizations`, `components/ParentHub`,
  …). Mid-session I observed file-state churn on this batch's files; final
  on-disk state was re-verified converted (greps + typecheck + lint above ran
  against it).
# Batch report: admin-tables

## Files converted (all under `apps/web/app`)

| File | Shape / ground | What changed |
|---|---|---|
| `admin/people/page.tsx` | table, ink, `room--office` | Ported off canvas-tan/white to ink leather. Header is a `.mat-leather` panel (`.t-eyebrow` + `.t-command` + `.t-body`); roster table sits in `.frame`+4 `.rivet`s with `.frame-in .mat-leather` and `divide-[color:var(--hide-700)]` rows. Sign-in status is now a `.badge` (ok→`--cleared` ✓, pending→`--restricted` ▲, blocked→`--locked` ✕) instead of colored text. "Created athlete" hand-off panel is framed, with `.t-label`/`.t-data` tiles for Sign-in ID and Starting PIN. All three forms use `.field`+`.t-label`+`.input`/`.select`; radio cards follow the admin-hub raised-leather selected pattern; guardian unlink confirm is `.btn--danger` / `.btn--ghost`; submits are `.btn`. Tabs follow the admin-hub active-tab pattern (`--accent-strong`/`--accent-ink`). All logic, fetches, retry/lock semantics, ARIA (`role="alert"`, `role="status"`), and ids untouched. |
| `admin/athletes/page.tsx` | table, ink, `room--office` | Same header/panel treatment; "Choose an athlete" list framed with rivets; row meta (id · dob · coach) in `.t-data` mono; inactive rows carry `.badge--locked` ✕ INACTIVE; filter is a `.field`+`.input`; correction + deactivate forms on `.mat-leather` with DS controls. |
| `admin/organizations/page.tsx` | stepped form, ink, `room--office` | Wizard reworked: framed header, brass step dial (done = brass fill, current = brass ring), steps as `.mat-leather` sections with brass-400 active border; feature checkboxes as raised-leather cards; access-denied/loading screens on ink; completion carries `.stamp--green stamp--lg` in place of the 🎉 emoji; ❌ feedback prefix replaced with the ✕ glyph. Logic (postJson targets, gating, step flow) untouched. |
| `admin/organizations/test/page.tsx` | stepped form, ink, `room--office` | Same treatment as the live wizard; 🧪 banner replaced with `.badge--restricted` ▲ TEST MODE on a raised panel; disabled-route notice on ink. |
| `admin/pin/page.tsx` | table, ink, `room--office` | Directory list framed with rivets at the φ split (`lg:grid-cols-[1.618fr_1fr]`); athlete rows are leather cards, selected = raised + brass border; key states ride the badge ladder per the brief — Active→`--cleared` ✓, No PIN / No account (pending keys)→`.badge--restricted` ▲, Inactive→`--locked` ✕. PIN forms use `.field`/`.t-label`/`.input font-mono`; primary action `.btn`, account-create `.btn--ghost`. |
| `admin/board-seats/page.tsx` | table, ink, `room--board` | The eight-seat roster framed with rivets; seat names in `.t-command`, holders in `.t-data` mono with `.badge--cleared` ✓ HOLDS THE SEAT / `.badge--restricted` ▲ UNFILLED; primary-conflict alert on rust with `.btn` (hand over) + `.btn--ghost`; assign form on `.mat-leather` with DS selects and raised radio cards. Server-mirroring `canManage` logic, handover ordering, and reload-before-report behavior untouched. |
| `admin/export/page.tsx` | prose + action, ink, `room--office` | Download control framed with rivets, `.btn` full-width; result line in `.t-data`; column list (auditable) in `.t-data` mono with brass rules; caveat lists in `.t-body` with hide-600 rules; back link `.btn--ghost`. |
| `admin/feedback/page.tsx` | queue, ink, `room--office` | Safeguarding cards are `.mat-leather--raised` with a `--restricted` border and `.badge--restricted` ▲ "Safeguarding — a person must read this"; the section banner likewise. Meta chips are mono hide-900 tags; triage status now renders as a badge via a small presentational `triageBadge()` map (new→▲ restricted, triaged/planned→◉ monitor, done→✓ cleared, declined→✕ locked) so state is never color-alone. The `--red-primary` border on the withheld-body note (chrome misuse of the safety red) is gone — it is a neutral hide-600 rule now. Triage controls use `.select`/`.textarea`/`.btn`. |

## Verification

- `npm run typecheck` — passes (one transient failure appeared mid-run in `components/AthleteWorkspace.tsx`, a file owned by a concurrent batch and not touched here; it cleared on re-run and the final run is green).
- `npx eslint` over all eight files — no errors, no warnings.
- Greps over the eight files: zero hex literals, zero `--red-primary`, `--canvas-tan`, `--safety-locked`, `--gray-*`, `--olive-*`, `--white*`, `--black`, `--text-sm/lg`, zero ambiguous `text-[var(...)]`/`border-[var(...)]`.
- Component tests: `people`, `athletes`, `board-seats`, `export`, `feedback` suites all pass (43/43). One assertion initially broke because I had prefixed the feedback load-error with a ✕ glyph inside the same text node; removed the prefix (the original had none either).

## Judgment calls worth knowing

- **Badge ladder for non-safety states.** Account/credential/appointment states (Deactivated, No PIN, Inactive, Unfilled, triage statuses) are rendered on the four badge rungs. Law 2 reads "safety state or queue outcome"; I treated these as queue/account outcomes, which is how the DS's own coach-review-queue preview uses the rungs. If the ladder is meant to be strictly Layer-11 safety, these pages need a neutral badge rung (see gaps).
- **Error banners** follow the converted `admin/page.tsx` model exactly (`--rust-900` ground, `--brass-700` border, `--locked-ink` text). Success notices use `--cleared` border + `--cleared-ink` text with a ✓ glyph.
- **Rooms**: `room--office` everywhere except `admin/board-seats`, which takes `room--board` (the sheet's own "rosters, seats, assignments" wall).
- Long sentences inside badges (e.g. "Linked to no athlete — would see nothing") are kept verbatim from the logic layer; they read fine but a badge is designed for short labels.

## DS gaps found (things ppbf.css could grow)

1. **A neutral/idle badge rung.** Four saturated rungs exist, but admin surfaces keep needing an "administrative, not safety" state chip (Deactivated, Unfilled, Archived). Today the choice is misusing a rung or hand-rolling a chip.
2. **A small-button variant.** Row actions want something shorter than `.btn`'s stencil 15px/44px; the coach-review-queue preview hand-rolls `.btn-sm` locally. A `.btn--sm` in the sheet would stop every page re-inventing it (I used full `.btn--ghost` instead of inventing one).
3. **Success/notice banner component.** The `--cleared`-tinted confirmation strip is now hand-assembled identically on four pages (and on the model admin page). A `.notice`/`.notice--cleared` panel would remove the repetition.
4. **Tab strip component.** The active/inactive tab pattern (accent-strong face vs hide-900 ghost) is copied from `admin/page.tsx` here; it is at least three pages old and belongs in the sheet.

## Deliberately left

- No logic, fetch, handler, gating, or ARIA changes anywhere; no export renames; no route changes.
- Feedback page's status `message` line stays plain text (it mixes success and failure strings from one state variable; classifying it visually would require logic changes).
- Labels in the two wizards keep their original lack of `htmlFor` (parity with the pre-conversion markup).
- `npm run sweep` not run — it needs a running dev server plus a baseline ref, neither of which this batch had.

## Risks

- Concurrent batches are editing sibling files in the same tree; the repo-level typecheck result can wobble as their edits land (observed once, resolved).
- Badge-rung semantics above are the one interpretive call a reviewer may want to reverse; every instance carries glyph + label, so a palette-only re-decision is cheap.
# Batch: board — conversion report

## Files converted

- `apps/web/app/board/page.tsx` — hub kept its `room--board` ink pattern; header rewritten as dark ink on the room's plaster upper wall (√φ ladder + Fibonacci space), aggregate-boundary box moved onto `.mat-leather`.
- `apps/web/app/board/BoardSeatDirectory.tsx` — seat cards moved to `.mat-leather--raised` with `t-eyebrow`/`t-command`/`t-label`/`t-body`; the way-in link is `.btn.btn--ghost`; the "held by another seat" refusal is now a static `.stamp` (`✕ SEAT HELD`) + `t-muted` explanation (Law 7).
- `apps/web/app/board/BoardSummaryPanel.tsx` — the workspace palette was still on legacy `--black`/`--canvas-tan*`/`--gray-dark`; both variants now resolve to the same leather materials (both call sites are on ink). KPI tiles are raised-leather with `t-label` labels, mono ladder-sized figures, `t-data` for the measured-at timestamp and rate details, and a `.stamp.stamp--flat` for k-anonymity `Suppressed` values — never a blank or zero. `variant` prop kept for API compatibility.
- `apps/web/app/board/BoardSeatWorkspace.tsx` — read; pure delegation to `BoardMemberDashboard`, no visual code, deliberately untouched.
- Nine seat pages (`president`…`at-large`) + `layout.tsx` — read; thin delegations with no visual mass, untouched by design.
- `apps/web/components/BoardMemberDashboard.tsx` — header rewritten for the plaster wall (dark ink, `.plaque` for the seat chip); tabs on the ladder; `planned` cards and the Seat Modules marker now carry `BOARD_PLANNED_STAMP` as a `.stamp` instead of an eyebrow; "Board intelligence unavailable" wears a `✕ DISABLED` stamp; the not-your-seat interim view sits on a raised-leather panel inside `room--board`; remaining raw Tailwind spacings moved to `--s*` tokens.
- `apps/web/components/RoleSummaryPanels.tsx` — all four KPI rows share one vocabulary: neutral cells on `.mat-leather--raised` with `t-label` + mono ladder-size figures; safety cells (readiness, injuries, attendance, program/board alerts) keep their saturated bands (Law 2) and now always carry a glyph beside the uppercase label (Law 3: `✓ ▲ ✕`); attendance `null` renders as a neutral "Unavailable" cell, never a colored band. Legacy `--status-ready`/`--status-warning` aliases replaced with `--cleared`/`--restricted` direct tokens.
- `apps/web/components/BoardSeatEvidence.tsx` — panels to `.mat-leather` / rows to `.mat-leather--raised`; register rows speak `t-data` (auditable), notes `t-muted`; failed-read panel converted, kept as prose (a failed load is an error, not a governance refusal, so no stamp).
- `apps/web/components/BoardRoleGate.tsx` — gate states now stand in `room--board` on a raised-leather panel; the unverified state carries a static `✕ NOT VERIFIED` `.stamp` (Law 7) with a brass `.btn` Retry.
- `apps/web/app/board/compliance-monitoring/page.tsx` — was `room--clinic` on **canvas** (a room on canvas, plus `--black`/`--canvas-tan*`/`--safety-locked`/`--gray-dark`/`bg-white` throughout). Now `room--clinic` on the ink ground per the room pattern (kept clinic rather than board: the sheet assigns clinic to clearance/safety, and this is the safeguarding register). Severity tiles are neutral leather unless a measured count > 0, in which case Critical/High wear the locked/restricted band with `✕`/`▲` glyphs; **suppression renders as a `.stamp.stamp--flat` ("Suppressed"), never an empty cell or zero**; the "Read this zero correctly" note is pinned `.mat-paper`; filter chips use the `mat-brass--patina` selected treatment; back link is `.btn.btn--ghost`; timestamps in `t-data`.

## Verification

- `npm run typecheck` — passes.
- `npx eslint` over all batch files — no errors.
- Greps over batch files: zero `#hex`, zero `--red-primary`, `--canvas-tan`, `--safety-locked`, `--gray-*`, `--olive-*`, `--white*`, `--black`, `--text-sm|lg`, and zero ambiguous `text-[var(--x)]` forms.
- Tests: all 10 board-adjacent suites pass (123 tests), including `BoardSummaryPanel`, `compliance-monitoring/page`, `BoardMemberDashboard`, `BoardRoleGate`, `boardSeatEvidence`, hub `page`, `rabbitHole` (HelpPanel), `athleteWorkspace`, `parentHubChildSwitch`.

## Not mine / pre-existing in the shared tree

- `components/coachWorkspaceHonesty.test.tsx` has 1 failing test ("Development shows no certification or expiry date") caused by a **sibling batch's** in-flight edit to `components/CoachWorkspace.tsx` (the `PLANNED | NOT YET IMPLEMENTED` text got split across elements). Confirmed by stashing this batch's files: the failure persists without them, and the committed baseline passes. Left for the coach batch.

## DS gaps found (things ppbf.css should grow)

1. **No KPI/stat-tile component.** `.tile` is a navigation object (cursor:pointer, hover lift, dashed inner border) and `.plaque` is a small inline chip; neither is a stat cell (label + big figure + note). Every dashboard batch will re-compose `mat-leather--raised + t-label + mono figure` by hand — worth a `.stat` (or `.tile--stat`) with a `-val`/`-note` pair.
2. **`.t-data` has no display size.** The data voice is pinned at 13px by an unlayered `font:` shorthand, so a Tailwind `text-[length:...]` cannot scale it for a KPI figure (unlayered author styles outrank layered utilities). I composed `font-mono text-[length:var(--t-xl)] font-bold text-[color:var(--bone-100)]` instead; a `.t-data--lg`/`--xl` rung would remove the workaround.
3. **Type-voice colors can't be re-inked for light walls.** `room--board`'s plaster upper half wants dark ink, but `.t-eyebrow`/`.t-body`/`.t-command` pin light colors that utilities cannot override (same layering reason). Headers on the plaster are composed by hand in this batch; a `.on-plaster` restatement (like `.on-canvas`) next to the room would close it.
4. **`.stamp` size is fixed.** `font-size: var(--t-sm)` is unlayered, so the long `BOARD_PLANNED_STAMP` text cannot be stepped down on small cards; it wraps instead (legible, just loud). A `.stamp--sm` rung would help card-scale stamps.

## Deliberately left

- The nine seat `page.tsx` files, `layout.tsx`, `BoardSeatWorkspace.tsx`: no visual code to convert.
- `boardWorkspaceConfig.ts` / all copy, fetches, handlers, ARIA, redirect logic: untouched (reskin, not rewrite). Test-pinned strings (`Suppressed`, `None filed`, filter labels, `BOARD_PLANNED_STAMP`, boundary statement) preserved verbatim; where glyphs were added they sit in separate `aria-hidden` spans so accessible names and exact-text queries are unchanged.
- `BoardSeatEvidence`'s failed-read state stays prose rather than a stamp: it is a load failure, not a governance refusal, and stamping it would spend Law 7's ink on the wrong meaning.
- Room choice for `compliance-monitoring` is `clinic` (safety register) rather than `board`; flagged here in case the suite is wanted uniform.

## Risks

- Sibling batches are editing the same tree concurrently (50+ modified files not in this batch); merge order may touch shared components (`RoleSummaryPanels` consumers `AthleteWorkspace`/`CoachWorkspace`/`ParentHub` are being converted in parallel).
- `RoleSummaryPanels` renders inside family-facing surfaces still on canvas ground; the raised-leather KPI cells carry their own dark ground so they read anywhere, but the saturated safety bands keep light `t-command` text as before — unchanged behavior, will want a pass when the family ground converts.
- `npm run sweep` (contrast) not run: needs a running dev server; recommend sweeping `/board`, a seat page, and `/board/compliance-monitoring` against a baseline ref before merge.
# Batch report: coach

## Files converted (ink ground throughout)

1. **`apps/web/components/CoachWorkspace.tsx`** (~1507 lines; renders coach/review-queue and coach/environment/intake-router)
   - Removed its own `min-h-screen bg-[--hide-950]` root paint so the `room--floor` wall supplied by `RoleStandaloneView` is visible behind the workspace.
   - All panels are now materials: `.mat-leather` sections, `.mat-leather--raised` cards, dark-inset sub-cards (`rgba(0,0,0,.28)` + brass hairline), `.mat-paper` for the two `AnnouncementBanner`s — the old wrappers painted `bg-[--bone-200]` under text inheriting `--bone-200`, i.e. bone-on-bone invisible notices; paper fixes that because `.mat-paper` carries its own dark ink.
   - Every status is now a `.badge` with glyph + uppercase label via a local `StatusBadge` (Law 3): pain severity (critical/high → locked ✕, moderate → restricted ▲, low → monitor ◉), readiness (GREEN ✓ / YELLOW ▲ / RED ✕ / UNKNOWN → neutral chip ◌), task priority and task status, injury flag (replaced the 🚨 emoji with `badge--locked`). Neutral chip exists because Law 2 forbids a saturated rung for "unknown"/"low".
   - Buttons: `.btn` for primary actions (SHADOW chat, scheduler, live floor, save review, decision-loop link), `.btn--ghost` for secondary and every Retry; the old `bg-[--locked] text-white` retry buttons are gone (red stays on the *error panel borders*, which the file's own comments justify as safety-signal loss warnings).
   - Every `PLANNED | NOT YET IMPLEMENTED` marker that was set in `--locked-ink` (spending the safety gate's red on chrome — the exact drift the contract calls out) is now `.stamp .stamp--brass .stamp--flat`.
   - Athlete-review form now uses `.field`/`.t-label`/`.input`/`.select`/`.textarea` (labels added — a11y gain, no logic change). Type voices: `.t-eyebrow`/`.t-command`/`.t-body`/`.t-muted`/`.t-label`/`.t-data`; spacing moved to `--s*`; radii to `--r-*`.
   - Kept: all fetches, handlers, state, honest-empty-state copy, `ui.tabContainer`/`tabButton*`/`modeButton*`/`panelSpaced` from `uiStyles.ts` (already DS-native), `readinessDotClass` rung-fill dots.

2. **`apps/web/app/coach/decision-loop/page.tsx`** (core feature) — was entirely legacy (`--canvas-tan`, `--black`, `--gray-dark`, `--safety-locked`, white cards). Now ink: `room="clinic"` via the `RoleStandaloneView` room prop (medical/clearance surface), `.mat-leather` sections with `.mat-leather--raised` row cards, all forms on `.field`/`.input`/`.select`/`.textarea`. Removed the nested `<main>` inside RoleStandaloneView's `<main>` (invalid HTML) → `<div>`. Statuses render as `StatusBadge`: accepted/cleared/active/match → cleared ✓; provisional/pending/partial → restricted ▲; rejected/not_cleared/miss → locked ✕; expired/superseded/confounded → neutral ◌. Buttons: Accept/Record Decision/Evaluate Outcome `.btn`; Reject/Load Outcomes/Flag Near-Miss/back-link `.btn--ghost`; **Set Status is the one `.btn--danger`** — it operates the medical gate itself (commented in-file).

3. **`apps/web/app/coach/drills/page.tsx`** — was canvas-tan/white with off-scale `rounded-2xl`/`rounded-xl`. Now `room--office` ink (applied directly on `<main>`, same pattern as `app/admin/page.tsx`), `.mat-leather` form panel, `.mat-leather--raised` drill cards, `.plaque` for difficulty, DS fields, `.btn` submit. Save confirmation is a cleared-green bordered note with a ✓ glyph; load-failure keeps the locked border + `--locked-ink` (the copy itself says "this is a failure to load, not an empty library").

4. **`apps/web/app/coach/progression-intelligence/page.tsx`** — panels → `.mat-leather`, forms → DS fields, buttons → `.btn`/`.btn--ghost`. The drill-completion bar stays a plain brass-on-black meter, **no `.gauge`** — completion has no danger threshold, so per Law 2 it gets no arc (commented in-file). `GAP_RABBIT_HOLE_CLASS` moved off `--canvas-tan-light` onto `.mat-paper` (paper note on leather, carries its own ink).

5. **`apps/web/app/coach/sports-medicine/page.tsx`** — canvas-tan → `room--clinic` ink (admin-page pattern), `.mat-leather` cards, `.stamp--brass` for the planned marker, `.btn--ghost` back-link, `.t-data` for entity IDs (Law 4).

6. **`apps/web/app/coach/environment/intake-router/page.tsx`** — thin shell; only change is `room="floor"` so it matches review-queue (both render CoachWorkspace).

7. **`apps/web/app/coach/environment/passbook-check/page.tsx`** — nested `<main>` → `<div>`, header → `.mat-leather--raised` + `.t-command`, red "PLANNED" text → `.stamp--brass`, field → `.field` + `.input--kiosk` (coach tablet on the floor ≥ `--tap`).

8. **`apps/web/app/coach/video-analysis/page.tsx`** — active player wrapped in `.frame` + 4 `.rivet`s (the one riveted brass frame on the screen, per the "player plus frame annotation" note in PAGE_MAP); upload form on DS fields; library rows `.mat-leather--raised` with status badges (quarantined → `badge--restricted` "Held for review" ▲, ready → `badge--cleared` "Released" ✓, else `badge--monitor`); Release is the brass `.btn`, Watch-first/Play are `.btn--ghost`; ML placeholder section gets `.stamp--brass`.

9. **`apps/web/app/coach/video-publications/page.tsx`** — panels/forms as above; publication `status:`/`checks:` chips are now real `.badge`s with glyphs (published/approved ✓, pending_review ▲, rejected/failed ✕, draft/archived/pending ◉ monitor); Publish `.btn`, everything secondary `.btn--ghost`.

10. **`apps/web/app/coach/review-queue/page.tsx`** — already a correct thin shell (`room="floor"`, `showShellHeader={false}`); untouched.

## Verification

- Grep across all ten files: **zero** hex literals, zero `--red-primary`, `--canvas-tan*`, `--safety-locked`, `--gray-*`, `--olive-*`, `--white*`, `--black`, `--text-sm|lg`, `text-white`, `bg-white`.
- `npx eslint` on all ten files: clean, no output.
- `npm run typecheck`: the **only** error in the repo is `components/AthleteWorkspace.tsx — TS2304 getGoalStatusTone` — a file in the athlete batch that a parallel agent was actively editing while I ran the check (the error's line number moved between runs). None of my files produce errors; every other file in the project compiles. Re-run once the athlete batch settles.

## DS gaps found (things ppbf.css could grow)

1. **A neutral badge rung.** `.badge` ships exactly four rungs, all saturated. Real data has non-states — UNKNOWN readiness, "low" priority, draft/archived lifecycle — which Law 2 forbids from wearing a rung. I restated the same neutral chip (bone on `rgba(0,0,0,.28)` with a `--hide-600` hairline, ◌ glyph) in two files (`CoachWorkspace.tsx`, `decision-loop/page.tsx`). A `.badge--neutral` in the sheet would remove the duplication; other batches will hit the same need.
2. **A small/inline stamp size.** `.stamp` at `--t-sm` with a 3px border is heavy as an inline "planned" marker inside a panel heading row; a `.stamp--sm` (t-xs, 2px border) would fit metadata rows better. I used the default size rather than fighting it with utilities (unlayered component beats layered utility anyway).
3. **An inline error/notice pattern.** Error boxes (locked border + `--locked-ink` text + retry) are hand-rolled the same way in every converted page; a `.notice--locked` component would stop the copy-paste. Left as page-level markup per the existing app convention.

## Deliberately left

- `uiStyles.ts` `ui.tab*`/`ui.modeButton*`/`ui.panelSpaced` consumption in CoachWorkspace: those helpers already emit DS classes (`mat-leather`, `--accent`, brass hairlines); replacing the references would be churn, and the brief forbids editing the file itself.
- Locked-red borders on data-load error panels in CoachWorkspace (pain reports, roster, floor plans, SHADOW queue): the file's own safety comments justify them — a failed read there can hide a child's pain report, which is safety-adjacent, and each carries text, not colour alone.
- `RoleSummaryPanels.tsx` (CoachSummaryPanel/HelpPanel) and `ShadowChatButton`/`AnnouncementBanner` internals: shared components outside my list (already converted per the contract's scope notes). I only changed the classNames my pages pass in.
- Duplicate-navigation questions (e.g. "Back to Coach Workspace" links that duplicate shell nav): behaviour, not skin.

## Risks

- `ShadowChatButton` is restyled by passing `className="btn"` / `"btn btn--ghost"`; its `buttonClasses()` drops conflicting defaults only for claimed *utility* properties, but since `ppbf.css` is unlayered it wins over the remaining Tailwind base classes. Verified against the sheet's cascade reasoning; worth an eyeball in the browser.
- Decision-loop got `room="clinic"` and sports-medicine `room--clinic`, drills `room--office`, the CoachWorkspace pages `room--floor` — room choices follow the sheet's own table (clinic = medical/clearance/safety, office = records, floor = gym floor). If the design owner wants all coach surfaces on one room, it's a one-word change per page.
- `npm run sweep` (needs a running dev server) was not run; recommend a baseline-diffed sweep of `/coach/*` before merge.
# family-floor — athlete + family surfaces conversion

Batch: athlete/* (ink, kiosk / Law 5) and parent/* + guardian (warm canvas,
`.on-canvas`). References used: `design-system/screens/athlete-kiosk.html`,
`design-system/screens/guardian-portal.html`, model pages `/schedule` and
`/admin` for the room pattern.

## Files converted

| File | Ground | What changed |
|---|---|---|
| `apps/web/components/AthleteWorkspace.tsx` | ink, `room--floor` | Full reskin of all 11 tabs. Bordered rectangles → `mat-leather` / `mat-leather--raised`; type → `t-command` / `t-eyebrow` / `t-label` / `t-data` with working copy at `--t-md`; all buttons → `.btn` / `.btn--kiosk` / `.btn--ghost` at ≥ `--tap`; inputs → `.input/.select/.textarea` + `input--kiosk`; tab nav → floor-sized brass-on/off controls (local `KIOSK_TAB_*`, replacing `ui.tab*`); range inputs given `min-h-[var(--tap)]` hit areas, checkboxes 21px in tap-height label rows. Errors → `.alert alert--critical` with ✕ glyph + retry `.btn--ghost`; loading → `.working`; goal/task states → `.badge` rungs with glyphs; rabbit-hole lessons → `mat-paper` notes. Red misuse removed: Check Out button no longer wears `--locked`, "PLANNED / NOT YET IMPLEMENTED" markers moved from `--locked-ink` to the label voice, SafeSport notice → `alert--warning` (▲), task priority "High" → bone + ▲ instead of locked ink. All fetches, handlers, state, ids and ARIA untouched; added `role="status"`/`role="alert"` and a few `aria-label`s on previously unlabeled goal-form inputs. |
| `apps/web/app/athlete/dashboard/sparring/page.tsx` | ink, `room--floor` | Kiosk form: kiosk-bar-style header with `.plaque`, `mat-leather--raised` capture panel, `.field`+`.t-label`+`.input--kiosk` everywhere, submit → `.btn btn--kiosk`, stat readouts → raised leather blocks with `t-label`/`t-data`, contact readout → `.plaque`. Submit button no longer rust-filled. |
| `apps/web/app/athlete/progression-intelligence/page.tsx` | ink, `room--floor` | Was a white/paper page; now ink dashboard. Severity/status chips → `.badge` rungs with glyphs (critical ✕ locked, high/medium ▲ restricted, low ✓ cleared; in-progress ◉ monitor, etc.; deferred/cancelled take a neutral chip so they borrow no safety hue). Completion progress bar → `.gauge` with ticks + needle and **no `.gauge-arc`** (completion has no danger threshold — Law 2); percent still printed (Law 3). Stats summary stays as leather record blocks, not gauges, since plain headcounts have no threshold. Rabbit-hole notes → `mat-paper`. Empty states → `.empty`. |
| `apps/web/app/athlete/video-analysis/page.tsx` | ink, `room--floor` | Panels → mats; Play/Close/back → `.btn`/`.btn--ghost` at ≥ `--tap` (kiosk-sized player controls); errors → `alert--critical` with glyph; ML placeholders → label voice. |
| `apps/web/components/ParentHub.tsx` | **canvas**, `.on-canvas` | Root wrapper is now the canvas ground itself. Panels → `mat-paper`; type → the canvas-restated `t-*` voices; tabs/child-selector → local `TAB_*` (brass "on", paper-chip "off"), replacing `ui.tab*`/`ui.mode*`; quick actions → `.btn`/`.btn--ghost`; progress bars → brass fill on recessed paper track; assignment/milestone states → `.badge` + glyph with paper-mixed card tints; attendance outcomes → `-deep` rungs + ✓/▲/✕ glyphs; children-load failure → locked-bordered box with `badge--locked` + ghost retry. All "PLANNED" markers moved off `--locked-ink` onto the label voice. ShadowChatButton rust overrides dropped so its currentColor default adapts to canvas. Logic/fetch/state untouched. |
| `apps/web/app/parent/dashboard/page.tsx` | canvas | No change needed — it is a pure wrapper around `ParentHub` (which now paints the canvas ground). Left byte-identical. |
| `apps/web/app/parent/progression-visibility/page.tsx` | **canvas**, `.on-canvas` | Dark bordered panels → `mat-paper` on the canvas ground; header → `t-eyebrow`/`t-command`/`t-body`; capability-status strings → label voice; error → `badge--locked` ✕ in a locked-bordered box mixed against `--canvas-warm`; back link → `.btn--ghost`. |
| `apps/web/app/guardian/page.tsx` | **canvas**, `.on-canvas` | FeatureSurface usage replaced with a DS-native layout built from `guardian-portal.html`: head-row (eyebrow / `t-command` / `t-body`), brass-rule governance banner, registry facts as `t-label` over `t-data` paper chips, split-major/minor paper panels ("What you can see here" with the three explainers as `details`, quick links as `.btn--ghost`). `ShadowChatButton` kept (it was rendered by FeatureSurface); every link the old page reached is still reachable (parent dashboard, progression visibility, guardian, /shadow, /operations, /login). FeatureSurface itself untouched. |
| `apps/web/components/TrainingCard.tsx` | (paper card) | The four raw hexes in the SVG seal replaced with `var(--hide-900)` via a single `SEAL_INK` const. Everything else was already DS-native (`.pap--card`, `.tcard-*`). 17/17 tests still pass. |

## Verification

- `npm run typecheck` — passes.
- `npx eslint` over all nine files — no errors.
- Greps over the nine files: **zero** `#hex`, zero `--red-primary`, `--canvas-tan`,
  `--safety-locked`, `--gray-*`, `--olive-*`, `--white*`, `--text-sm|lg`.
- Zero Tailwind stock text sizes (`text-xs/sm/...`) left in converted files;
  all sizes are `text-[length:var(--t-*)]` or `t-*` voices.
- Radii only from the Fibonacci scale (`--r-sm..xl`, `--r-pill`).
- Jest: `trainingCard` (17), `athleteWorkspace`, `parentHubChildSwitch`,
  `athlete/progression-intelligence/page`, `athlete/dashboard/sparring/page`
  — 60 tests, all passing.

## DS gaps found (things ppbf.css should grow)

1. **No token for the paper-card ink.** `.tcard-title`, `.tcard-count b`,
   `.commands-sheet-hd b` etc. all hardcode the same dark card ink as a raw hex
   inside ppbf.css. TrainingCard's SVG seal needed that colour and had to
   settle for `--hide-900` (nearest token, visually identical at 52px). A
   `--card-ink` (and `--card-ink-muted` for the `#6B5B44` family) token would
   let components reference it.
2. **`.alert` has no `.on-canvas` restatement.** All four alert variants set
   `color: var(--bone-100)`, which is invisible on cream. On the parent
   surfaces I had to fall back to the `/schedule` pattern (badge + tinted
   bordered box mixed against `--canvas-warm`) instead of using the component.
3. **`.working` has no canvas restatement** (`--brass-300` on cream ≈ 2:1). I
   used `t-muted` text for parent loading states instead.
4. **`.badge` neutral rung is missing.** States with no ladder meaning
   (deferred, cancelled, "Not Started") need a chip that is *deliberately* not
   on the ladder; both converted pages had to hand-roll one
   (`NEUTRAL_CHIP_CLASS`). A `.badge--neutral` (bone/patina) would close this.
5. **Range inputs have no kiosk component.** `.input--kiosk` covers text
   controls only; sliders on the floor got `min-h-[var(--tap)]` + brass
   `accent-color` by hand in three places. A `.range--kiosk` would keep those
   from drifting.

## Deliberately left / risks

- **RoleStandaloneView's family branch** (not editable, and correctly so per
  the brief) still paints `--canvas-tan` around the athlete pages, so the ink
  kiosk surfaces render as a full-height dark sheet inside the shell's cream
  margin — same geometry as before the conversion, now with the floor room's
  brick wall. When RoleStandaloneView's family branch is revisited (its own
  comment anticipates this), the athlete routes should get the ink main +
  `room--floor` at the `<main>` level and the inner wrappers here can drop
  their own `min-h-screen` grounds.
- **Shared components not in scope** (`RoleSummaryPanels`, `AnnouncementBanner`,
  `RabbitHole`, `ShadowChatButton`) adapt via the `t-*` voices and
  currentColor, and were verified to read on both grounds; the one soft spot is
  `RoleSpecificShadow`'s `--brass-400` prompt line inside the on-canvas
  ParentHub (~2.9:1 on cream). Fixing it means editing a file outside this
  batch, so it is flagged rather than patched.
- **Reference kiosk screen itself sets meta text below `--t-md`** (its `.note`
  is 12.8px), so I applied Law 5 as the reference does: working copy and all
  controls at ≥ `--t-md`/`--tap`, captions and audit metadata at `--t-sm`/`--t-xs`.
- Goal/assignment/milestone statuses now wear ladder badge rungs as *queue
  outcomes* (Active ◉ monitor, Completed ✓ cleared, Paused ▲ restricted).
  This matches the hues the code already used, componentized and given glyphs;
  if the team decides development states shouldn't touch the ladder at all,
  swapping to the neutral chip is a one-line change per mapping.
- `npm run sweep` was not run (needs a running dev server + baseline ref, per
  the contract's own guidance about diffing against a baseline); the greps,
  typecheck, lint and unit suites above all pass.
# Batch report: intelligence

## Files converted (all 10 assigned)

| File | Shape / ground | What changed |
|---|---|---|
| `apps/web/app/shadow/page.tsx` | custom console, ink, `room--night` | Full reskin. Header/scope/sessions panels are `.mat-leather` / `--raised`; the chat console is the page's one `.frame` + rivets. All off-ladder sizes (`text-[9px]`/`[10px]`/`text-xs`…) moved to the √φ ladder; type voices `.t-eyebrow`/`.t-command`/`.t-label`/`.t-body`/`.t-muted`/`.t-data`. Evidence-tier bubble ladder kept ("bigger shadow = more evidence") on tokens. Law 7: `filtered` state and `Human Handoff Required` are now `.stamp` marks on the message record. Law 2 red misuse removed everywhere it was chrome: mode eyebrow, LIVE lamp, New-chat button, selected session card, user bubbles, heavy-bag toggle, Ask button, nav links (armed *Confirm delete* keeps destructive red deliberately). Law 1: selected session card and engaged heavy-bag mode now wear brass ("on" position). Law 3: medal/glove/bolt/thumb emojis replaced with words (`getProfileTierLabel`, mode toggle, feedback buttons); degraded/queued get `.badge` glyph+label. All logic, fetching, polling, ARIA, aria-pressed added on the mode toggle. |
| `apps/web/app/shadow/scout/page.tsx` | custom, ink, `room--night` | Leather panels, `.plaque` chips, `.field`/`.input`/`.btn`. `StatusBadge` moved to the 4-rung `.badge` ladder with glyphs (pending = neutral chip off the saturated rungs). Law 7: safety-boundary-withheld results and withheld board summaries carry a `.stamp` "Withheld". Tier-distribution meter fills are brass (chassis), medal emojis dropped. |
| `apps/web/app/research/page.tsx` | custom hub, ink, `room--file` | FeatureSurface replaced with a DS layout; kept `DevelopmentPipelineBanner currentStage="research"` and `ShadowChatButton`. Intake cards are `.mat-paper` pinned (`.pin--brass`) to the cork wall; review states are ladder badges; requirement form is `.field`/`.input`/`.textarea`/`.btn` on leather; counts on `.mat-leather--raised` stat cards; stats as `.plaque` row. |
| `apps/web/app/research/chat/page.tsx` | conversation, ink, `room--file` | Chat lives in a `.frame`+`.frame-in .mat-leather` blotter; Library answers (approved evidence) render as `.mat-paper` slips in the `.t-typed` voice with mono source lists; user messages are raised leather; system notices recessed dark leather. Aside panels (notes, nav, SHADOW stream) are leather with `.btn--ghost` links; "LIVE" indicator is a brass `.plaque`, not red. |
| `apps/web/app/knowledge-graph/page.tsx` | custom, ink, `room--file` | FeatureSurface replaced (banner + ShadowChatButton kept). Four stream sections as leather panels; each node is a pinned `.mat-paper` record with a review-state `.badge` and `.t-data` entity id. |
| `apps/web/app/simulator/page.tsx` | custom, ink, `room--office` | FeatureSurface replaced (banner + ShadowChatButton kept). Scenarios are before/after `.mat-paper` typed sheets: Current State | Proposed Change split, Expected Outcome below, risk graded on the badge ladder (✓/▲/✕ + label). |
| `apps/web/app/rabbit-holes/page.tsx` | form, **moved to ink** (`room--office`) | Was legacy-canvas (`--canvas-tan`, `--black`, `--gray-*`, `--safety-locked`, `--olive-*`, `--accent-*` — all removed). Coach/admin authoring is a staff surface, so ink per "ink ground throughout". `.field`+`.t-label`+`.input`/`.select`/`.textarea`, `.btn` publish, published/retired as ✓-badge / neutral chip. |
| `apps/web/app/workspace/page.tsx` | dashboard, **moved to ink** (`room--office`) | Same legacy-canvas cleanup (`--canvas-tan*`, `--black`, `--gray-*`, `--white`, `--olive-dark`, `--shadow-sm` gone). Account facts in `.t-data` (Law 4), gym notices as `.mat-paper` slips, surface cards `.mat-leather--raised` with `.btn--ghost` openers. |
| `apps/web/app/evidence/page.tsx` | table-ish queue, ink (kept `RoleStandaloneView room="file"`) | Removed the page's one hardcoded hex (`bg-[#111]`). Cards on leather; approval state on the badge ladder; Law 7: rejected rows carry a static `.stamp` "Rejected", failed-extraction documents a `.stamp--flat` "Cannot Approve". Approve = brass `.btn`, Reject = `.btn--ghost` (a control, not a status — the outcome gets the stamp). |
| `apps/web/app/audit/page.tsx` | table, ink, `room--office` | FeatureSurface replaced (banner + ShadowChatButton kept). The trail is now the DS `.ledger` on `.mat-paper.aged` — mono voice throughout, append-only, zero row actions; event type on `.ledger-val`, entity id on `.ledger-id`. Failed-load vs empty distinction preserved (badge--locked alert + `.btn--ghost` retry vs torn paper note). `overflow-x-auto` keeps 412px safe. |

## Verification

- `grep -nE '#[0-9a-fA-F]{3,6}'` across all 10 files: **0** (was 1, in evidence).
- Legacy tokens (`--red-primary`, `--canvas-tan*`, `--safety-locked`, `--gray-*`, `--olive-*`, `--white*`, `--text-sm|lg`, `--black`, `--shadow-sm`, `--accent*`, `--status-ready`): **0** remaining (rabbit-holes + workspace together carried ~40).
- Off-ladder type (`text-[9|10|11|12|13|14|16px]`, `text-xs/sm/lg/xl…`), emoji state glyphs, ambiguous `text-[var(--x)]`: **0** remaining.
- `npx eslint` on the 10 files: clean.
- `npm run typecheck`: the only error in the tree is `components/AthleteWorkspace.tsx(1851): Cannot find name 'getGoalStatusTone'` — a file **outside this batch**, being edited concurrently by another conversion agent (the error's line number moved between two runs minutes apart). Zero errors in this batch's files.

## DS gaps found (things ppbf.css should grow)

1. **No paper-ground `.t-label`/`.t-eyebrow` restatement.** `.t-label` is bone-on-leather; `.on-canvas` restates it, but a `.mat-paper` panel inside an ink page gets neither. Hand-rolled once per page as `font-mono var(--t-xs) bold uppercase text-[color:var(--hide-600)]` (constant `PAPER_LABEL` where repeated). ppbf.css could add `.mat-paper .t-label { color: … }` next to the `.mat-leather .stamp` restatements.
2. **`.stamp` ink on light non-paper surfaces inside leather.** The sheet resolves stamp ink per material (`.mat-leather .stamp` → `--locked-ink`), but a light element *inside* a leather panel (the RESEARCH_NEEDED evidence bubble in `/shadow`) inherits the leather restatement and goes illegible. Handled with a one-line inline `STAMP_INK_BY_TIER` map + comment in `shadow/page.tsx`; a `.stamp--on-light` (or paper-context guard) in the sheet would remove it.
3. **No neutral (unsaturated) rung on `.badge`.** "pending" / "retired" / "unknown" are real states that must not ride the saturated ladder; each page hand-rolls the same neutral mono chip. A `.badge--neutral` would end the duplication (used in knowledge-graph, research, rabbit-holes, scout).
4. **`.ledger` assumes paper.** Fine here (audit sits on `.mat-paper`), but there is no ink-ground ledger voice if a future console wants one.

## Deliberately left / judgment calls

- **Ground promotion of `rabbit-holes` and `workspace` to ink** — directed by the task ("ink ground throughout"); both are staff surfaces, consistent with RoleStandaloneView's allowedRoles-derived rule.
- **Audit cards → `.ledger` table** — presentation only; identical fields, data, and load/empty/failed logic. PAGE_MAP names audit a table shape and the DS ships the exact component.
- **Armed "Confirm delete" in `/shadow` keeps `--locked-ink`** — genuinely destructive confirm (the `.btn--danger`/stamp-red family), not chrome.
- **Risk ratings (simulator) and job/review states on the badge ladder** — read as queue outcomes; every rung carries glyph + uppercase label so Law 3 holds in greyscale.
- **Emoji copy changes** (🥇→"Gold", 🥊→"Heavy Bag", 👍/👎→"Helpful"/"Not helpful") — visual-voice change only; handlers, titles, and payloads untouched.
- **`FeatureSurface.tsx` untouched** per brief; the four pages that consumed it no longer import it.

## Risks

- `npm run sweep` (contrast sweep against a running dev server) was not run — no dev server in this environment. Highest-value routes to sweep: `/shadow` (evidence-tier bubbles), `/research` and `/knowledge-graph` (dark headings on the cork `room--file` wall — mitigated with explicit `--hide-900` spans).
- The tree is being edited by parallel batch agents; the AthleteWorkspace typecheck failure above is theirs and will need their fix before CI is green.
- `/shadow` restored sessions and long conversations were reasoned about but not visually exercised against live data.
# Batch report: misc-ops

## Files converted

- `apps/web/app/dashboard/page.tsx` — was a nearly bare hide-950 page with a
  hand-rolled retry button. Now a riveted `.frame` around a `.mat-leather`
  panel (610px max width — Fibonacci), `t-eyebrow`/`t-command`/`t-body`
  voices, retry as `.btn`. The server-error state now carries
  `.badge.badge--locked` (✕ SESSION CHECK FAILED) per Law 3, plus a
  `.btn--ghost` "Back to sign in" link so a stuck user has somewhere to go.
  Redirect/session logic untouched.
- `apps/web/app/change-pin/page.tsx` — was legacy canvas-tan/white cards with
  `rounded-xl`/`rounded-2xl` and 48px inputs. Now ink ground (per PAGE_MAP),
  `.frame`+`.rivet` around `.mat-leather`, `.field`/`.t-label`/`.input
  .input--kiosk` so every PIN well clears `var(--tap)` (Law 5), submit is
  `.btn--kiosk`, refusal is `.badge--locked` with glyph, success state is a
  leather card with `.badge--cleared`. All validation/fetch/redirect logic,
  ids and `role="alert"` intact.
- `apps/web/app/activate/page.tsx` — already DS-native on `.on-canvas`. The
  only "hexes" left were two literal `#4caf50` mentions inside prose comments;
  reworded so the verification grep runs clean. No markup changes.
- `apps/web/app/help/page.tsx` — was mostly converted; finished the header:
  eyebrow → `.t-eyebrow`, h1 → `.t-command` at `--t-2xl`. The rest already
  uses `.mat-paper`, `.btn--ghost`, ladder-aliased text utilities. Note:
  PAGE_MAP describes help as "prose with a form at the end", but the current
  page has no form (content moved to helpContent/TutorialCard); nothing was
  invented.
- `apps/web/app/source-control/page.tsx` — FeatureSurface replaced with an ink
  table layout: leather panels with brass hairlines, KPI tiles
  (`.mat-leather--raised`), promotion lanes with `.t-data` for
  versions/canonical state (Law 4), `PLANNED | …` status as `.stamp--brass`
  (Law 7), `DevelopmentPipelineBanner currentStage="source-control"` and
  `ShadowChatButton` kept, quick links (including the two FeatureSurface
  auto-added: Operations Hub, Member Access) as `.btn--ghost`. `id="publish"`
  anchor preserved (DevelopmentPipelineBanner links to `/source-control#publish`).
- `apps/web/app/source-control/publication-workflow/page.tsx` — same
  treatment; the SHADOW requirements fetch, `useMemo` panel counts and all
  copy kept. The load error, previously bare `--locked-ink` text, is now
  `role="alert"` with `.badge--locked` + glyph (Law 3).
- `apps/web/app/operations/wrestling-league/page.tsx` — canvas-tan/black
  legacy → ink ground, `.t-command` headings, `.mat-leather--raised` cards,
  `PLANNED | NOT YET IMPLEMENTED` as `.stamp--brass`, back link as
  `.btn--ghost`.
- `apps/web/app/operations/external-competition/page.tsx` — identical
  treatment.
- `apps/web/app/notices/page.tsx` — remnants only, as instructed: the
  `--safety-locked` load-error line is now `.badge--locked` + glyph inside
  `role="alert"` (the red alias was doing chrome work); the preview card was
  `bg-white rounded-2xl shadow` (white is not a material, 16px is off the
  radius scale) and is now `.mat-paper rounded-[var(--r-md)]`. Everything
  else (LIFECYCLE_TONE chips, publish button on `--accent-*` chrome tokens)
  was already on sanctioned tokens and left alone.
- `apps/web/components/RevenueFundingCenter.tsx` — found already ~95%
  converted (mat-leather panels, DS buttons, t-* voices). Fixed: off-scale
  `py-[2px]` → `py-[var(--s1)]`; removed a visibly duplicated
  "Capability Visibility (Revenue)" `<h3>` that repeated the `<summary>` text
  inside the open `<details>`; gave the enabled "Open Capability" button the
  same `mt-[var(--s3)]` its disabled sibling had. No logic changes.

## Verification

- `npm run typecheck` — passes.
- `npx eslint` over all ten files — no errors, no warnings.
- Brief greps over the ten files — zero `#hex`, zero `--red-primary`,
  `--canvas-tan`, `--safety-locked`, `--gray-*`, `--olive-*`, `--white*`,
  `--text-sm|lg`.
- `npx jest app/notices/page.test.tsx app/operations/page.test.tsx` —
  10/10 pass (the only page tests covering touched routes).
- `npm run sweep` not run (needs a running dev server; not available in this
  environment).

## DS gaps found (candidates for ppbf.css, not worked around twice)

1. **`.mat-paper` has no type/field restatement outside `.on-canvas`.**
   `.t-label`, `.t-eyebrow`, `.t-muted` and `.input` are tuned against
   leather, and only the `.on-canvas` block re-inks them. A paper card on an
   *ink* page (the natural "form on a desk" idiom — exactly what change-pin
   wanted, and what login gets for free because its whole page is
   `.on-canvas`) renders bone-on-paper labels. I sidestepped it by putting
   the change-pin form on `.mat-leather` inside the frame instead of paper;
   a `.mat-paper .t-label { … }`-style restatement (or an explicit "paper
   only under .on-canvas" rule in the docs) would close the gap properly.
2. **No DS class for the inline alert panel.** The
   "bordered `--locked` box + `.badge--locked` + body text" refusal pattern
   is now hand-assembled identically in login, dashboard, change-pin and
   publication-workflow (including the model page's
   `bg-[rgba(168,30,34,0.06)]` wash, which is itself a raw rgba of
   `--locked`). An `.alert`/`.alert--locked` component would remove four
   copies of the same utility string.

## Deliberately left

- `notices` LIFECYCLE_TONE spends `--cleared`/`--restricted` on announcement
  lifecycle chips (live/scheduled). Arguably a Law 2 stretch (a scheduled
  notice is not a safety state or queue outcome), but the page is listed as
  converted, each chip carries an uppercase label, and my instruction was
  legacy-token remnants only — flagged here rather than changed.
- `RevenueFundingCenter`'s `statusTone`/`capabilityBadgeTone` chips report
  status in brass tones. Brass-as-status brushes Law 1, but it matches the
  deliberate pattern documented in `app/operations/page.tsx` (build state on
  the chassis, off the safety ladder); the chips carry uppercase labels. Left.
- `FeatureSurface.tsx` itself untouched (forbidden file); other routes still
  importing it are outside this batch.
- Tailwind `text-xs`…`text-4xl` utilities left in place where they already
  existed: `globals.css` re-points `--text-*` at the √φ ladder, so they are
  ladder-compliant by aliasing (confirmed by `src/design/typeLadder.test.ts`).

## Risks

- change-pin swaps canvas-tan ground for ink; if anyone expected the old warm
  look on that route, PAGE_MAP ("change-pin | ink") is the authority I
  followed. Its form sits on leather rather than paper for the contrast
  reason in gap 1.
- The two source-control pages lost FeatureSurface's aside ("Front-end
  status" filler panel). All navigational content (primary links + the two
  auto-appended quick links) and both shared banners were preserved; only the
  boilerplate copy panel is gone.
- `dashboard` now shows a "Back to sign in" link in the retryable state that
  did not exist before — navigation-only, no session mutation.
