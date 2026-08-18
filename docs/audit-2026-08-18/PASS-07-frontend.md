# Pass 7 — Frontend & design system

Branch `docs/full-spectrum-audit-2026-08-18`, pinned to `origin/main` at `04dd116b`.
Read-only pass. No application code was modified.

Inputs read for de-duplication before anything was written: `AGENT_KERNEL.md`;
`docs/capabilities/NETWORK_STATUS.md` (read from `origin/docs/agent-handoff-briefs` —
it is not on `main` or on this branch); `docs/HANDOFF_VISUALS.md` (same branch);
`design-system/ppbf.css` header and its `.stamp` / `.alert` / `.badge` sections;
`docs/FRONTEND_STYLE_CONTRACT.md`; and
`docs/PLATFORM_AUDIT_2026-08-17_FULL_SPECTRUM.md` §§2.1–2.4 from
`origin/claude/app-audit-ux-ui-report-78o4cm`.

**Owner decision honoured, not reported as a defect:** the six Capability Console
pages (`/admin/macro-analytics`, `/board/dashboard`, `/admin/communications`,
`/admin/curriculum`, `/coach/operations`, `/admin/retro-lab`) are deliberately
left unstyled. Nothing below asks for them to be styled. What is reported is a
separate question — whether they say they are fabricated — and one finding
concerns the fact that the recorded basis for that decision is measurably wrong
about that.

---

## Method

### What was counted, mechanically, across the whole surface

| Surface | Count |
|---|---|
| `apps/web/app/**/page.tsx` on disk | 126 |
| `apps/web/components/*.tsx` excluding `*.test.tsx` | 86 |
| `apps/web/src/components/**/*.tsx` excluding tests | 7 |

The audit README and both prior audits say 125 screens; there are 126 `page.tsx`
files, one of which (`app/store/[organizationId]/page.tsx`) is a dynamic segment.
`app/launch/page.tsx` is a 45-byte re-export of `/operations`. Both are
documented in `components/buildingMapCoverage.test.ts`. I report 126 because that
is what `find` returns.

The seven files under `apps/web/src/components/` are outside the brief's stated
scope of "86 `apps/web/components/*.tsx`", but they are the entire body of the
six Capability Console screens — the page files are 14–21-line wrappers. A pass
about fabricated-data disclosure that stopped at the wrapper would report six
screens as empty. They are included and called out as such wherever they appear.

### Classification, then sampling

Nothing here was established by reading 211 files. The sequence was:

1. **Grep for off-token colour.** Full Tailwind named-palette regex (all 22
   palettes × 16 utility prefixes, with variant prefixes), plus bracketed hex
   (`bg-[#…]`), plus bare hex string literals, plus `bg-black`/`text-white`.
   Counted per file with `grep -o | wc -l`, not `grep -c` (which counts lines and
   under-reports a file with several utilities on one line — it reported
   `/shadow/page.tsx` at 93 when the true occurrence count is 171).
2. **Classify every page and component by fetch-vs-literal.** A Python pass over
   all 212 non-test files counting `fetch(` call sites against object-literal
   fields whose names are display-shaped (`name:`, `label:`, `status:`,
   `amount:`, `count:` …). Files with zero fetches and ≥5 display literals became
   the fabricated-data candidate set (10 files). Files with hardcoded currency or
   4-digit figures in JSX were swept separately (4 hits, all in the console
   cluster).
3. **Grep for disclosure vocabulary** (`fabricat`, `sample data`, `mock-only`,
   `Not Yet Implemented`, `invented`, `demonstration`, `placeholder data`) across
   app + components + src/components, then intersect with (2).
4. **Resolve every internal `<Link href>`** against the route set built from the
   `page.tsx` inventory, including dynamic-segment matching.
5. **Diff every design-system-namespaced class token** used in a `className`
   attribute anywhere under `apps/web` against the union of selectors defined in
   `design-system/ppbf.css` and `apps/web/app/globals.css`.
6. **Count clients that branch on the server's typed refusal vocabulary**
   (`status === 409`, `payload.code`).

### The sample, and how it was chosen

Files were opened in full or in substantial part only where step 1–6 flagged
them, plus a deliberate control group of files the classifier said were *clean*,
to test whether the classifier was blind.

**Opened (25 route files, 12 `components/*.tsx`, all 7 `src/components`):**

- All six Capability Console wrappers and all seven of their components — the
  entire fabricated-data candidate set.
- The four other zero-fetch/high-literal candidates: `/simulator`,
  `/source-control`, `/guardian`, `/admin/organizations/test`.
- The three surfaces the visual brief names as its own jobs:
  `/admin/portrait-review`, `components/RevenueFundingCenter.tsx`,
  `/operations`.
- The two competition-entry surfaces named in Job 1 of that brief:
  `/operations/external-competition`, `/operations/wrestling-league`, plus
  `/coach/transfer-check` as the "coach not scoped" case.
- Every file the class-diff or link-resolver flagged: `app/retro-lab/page.tsx`,
  `components/GymWallModule.tsx` (grep only), `components/WallOfNames.tsx`
  (grep only), `components/Chalkboard.tsx` (grep only), `app/auth/link/page.tsx`
  (grep only), the nine `/coach`-linking pages (grep only).
- The three orphan components.
- **Control group, expected clean, opened anyway:** `components/ProfilePortrait.tsx`,
  `components/TrainingCard.tsx`, `components/BoardMemberDashboard.tsx`,
  `app/page.tsx`, `app/knowledge-graph/page.tsx`, `app/admin/consent/page.tsx`.
  One of these (`admin/consent`) refuted a finding the classifier had produced.

**Not opened: 101 of 126 route files and 74 of 86 components.** They were
classified by grep and by the six mechanical passes above and by nothing else. No
claim in this document rests on a file I did not open, and no file I did not open
is asserted to be sound — it is asserted to be *unflagged by six specific
mechanical checks*, which is a weaker statement and is the only one available.

**Nothing was executed.** No dev server, no `npm run sweep`, no test run. Every
statement about rendering is inferred from source.

---

## Every screen rendering fabricated data

"Fabricated" here means: a figure, name, status or record shown to a user that
came from a literal in the source rather than from a fetch. It does *not* include
labels, nav copy, or explanatory prose about what a surface is for.

Disclaimer = prose on the screen saying the content is not real.
Stamped = a `.stamp` from the design system's Law 7 family carrying that claim.

| Screen | Where the literals live | What is fabricated | Disclaimer? | Stamped? |
|---|---|---|---|---|
| `/admin/macro-analytics` | `src/components/analytics/MacroCommandCenter.tsx` | 3 named staff with SafeSport + background-check status; "Total Athlete Count 113"; per-lane athlete counts and weekly attendance; readiness Green/Yellow/Red distribution; 8-week readiness trend bars; "7 risk flags active"; board governance snapshot; three deload recommendations including "Red-zone athletes: lock contact rotations until clearance review" | **NO** | **NO** |
| `/board/dashboard` | `src/components/board/BoardViewportSwitcher.tsx` | 3 budget rows totalling $255,000 allocated; $89,500 grant pipeline; meeting-minutes approval queue; policy review queue with risk scores; 8,720 training-floor minutes with a capacity percentage derived from it | **NO** | **NO** |
| `/admin/communications` | `src/components/communications/MediaAndCommsHub.tsx` | 3 film timestamps with coaching focus text; pre-filled annotation, tactical-note and athlete-reflection drafts; "Mock Video Player" | **NO** | **NO** |
| `/admin/curriculum` | `src/components/curriculum/CurriculumProgressionEngine.tsx` | skill prerequisite tree with certification status; drill→lesson map; badge awards naming athletes "Lena Cho" and "Jonah Ruiz"; an `Issue Mock Badge` button that appends more of them | **NO** | **NO** |
| `/simulator` | `app/simulator/page.tsx` | 7 coaching scenarios, each with current state, proposed change, expected outcome and a **risk grade rendered on the Layer 11 safety ladder** (`badge--cleared` / `badge--restricted` / `badge--locked`) | **NO** | **NO** |
| `/operations` (System Diagnostics panel) | `app/operations/page.tsx` | a static "Signed & Active" certification over four readiness/ΔRPE boundary claims and five role-isolation compliance claims | **NO** | a `stamp--green` that **asserts** the claims rather than disclosing them |
| `/admin` → Revenue tab | `components/RevenueFundingCenter.tsx` | 3 accounts, 3 revenue items, 6 payment integrations — every row self-labelled "Placeholder", every amount `$0.00`, every address `@example.placeholder`; `initialDonationRecords` is deliberately empty with a comment saying why | **Row-level only** (naming); no page-level statement | **NO** — the tab renders outside both of the page's two brass stamps |
| `/coach/operations` | `src/components/coach/FloorOperationsDesk.tsx` | athletes, clearances, attendance figures, matchups | **YES** | **YES** |
| `/admin/retro-lab` | `src/components/core/PunxsyEcosystemCore.tsx`, `DevToolsQAConsole.tsx` | 12-role matrix, QA event log with fixed timestamps, telemetry | **YES** (red banner, from `PunxsyEcosystemCore` only) | **NO** — not a `.stamp` |
| `/source-control` | `app/source-control/page.tsx` | 5 promotion lanes, version history, 7 publish destinations | **YES** | **YES** (`stamp stamp--brass`) |
| `/source-control/publication-workflow` | same page | publication stages | **YES** | **YES** (`stamp stamp--brass`) |
| `/retro-lab` | `app/retro-lab/page.tsx` | "Sample ticket", "Sample row A/B/C", seeded ledger lines | **YES** (eyebrow: "component samples, not records") | **NO** |
| `/admin/organizations/test` | `app/admin/organizations/test/page.tsx` | 6 gym capabilities in a setup wizard | **YES** (env-gated, renders a "Test Wizard Disabled" notice by default) | **NO** |
| Board seat pages (8) | `components/BoardMemberDashboard.tsx` | per-seat module lists | **YES** | **YES** (`stamp stamp--flat`, on every planned card *and* on the module block) |
| `ParentHub` sections (7) | `components/ParentHub.tsx` | — content removed; sections render as explicit empty states | **YES** | **YES** (`PLANNED \| NOT YET IMPLEMENTED` ×7) |
| `CoachWorkspace` sections (7) | `components/CoachWorkspace.tsx` | — content removed | **YES** | **YES** (`stamp stamp--brass stamp--flat` ×7) |
| `/coach/review-queue`, `/coach/environment/passbook-check`, `/coach/video-analysis` | page files | — content removed | **YES** | **YES** |
| `/director/dashboard` | `app/director/dashboard/page.tsx` | — fabricated escalation queue removed, replaced by prose saying it used to be there | **YES** | n/a |

**Undisclosed count: 6 screens render fabricated or unverified content with no
disclaimer** — `/admin/macro-analytics`, `/board/dashboard`,
`/admin/communications`, `/admin/curriculum`, `/simulator`, and `/operations`'s
diagnostics panel. Five of those six carry no stamp either; the sixth carries a
stamp that certifies rather than warns. A seventh, the Revenue tab, discloses
only through the word "Placeholder" appearing inside each row.

Of the six, **four were already reported** by the 2026-08-17 full-spectrum audit
§2.4 (`/board/dashboard` 🔴, `/admin/macro-analytics` 🔴, `/admin/curriculum`
grouped with the needs-a-fix set, `/operations` 🟡). **Two are new to this pass:
`/admin/communications` and `/simulator`.** Neither appears in that audit, in
`NETWORK_STATUS.md`, or in `docs/design/PLACEHOLDER_MAP.md`.

The counter-observation worth recording: **the disclosure discipline in
`apps/web/components/` is genuinely strong.** `ParentHub`, `CoachWorkspace`,
`BoardMemberDashboard` and `RevenueFundingCenter` between them carry 21 separate
stamps and several long comments explaining what was deleted and why. The
undisclosed set is entirely one batch of prototype consoles plus two pipeline
pages. This is not a codebase-wide habit, and the prior audit's "pattern verdict"
on that point holds up under a second measurement.

---

## Design-system conformance

### Law 2 — the measured off-token colour count is **not 0**

`docs/HANDOFF_VISUALS.md` states: *"A repo-wide pass took off-system colour
utilities across all 125 route files from 191 to 0. Keep it at 0."* Measured on
this branch:

| Category | `app/**/page.tsx` | `components/*.tsx` | `src/components/**` |
|---|---|---|---|
| Tailwind named-palette utilities (all 22 palettes) | **176** | **0** | **415** |
| Bracketed raw hex (`bg-[#09090b]`, `hover:bg-[#2a1a1a]`) | **26** | **0** | (included above) |
| Bare hex string colour literals | **4** | **0** | 0 |
| **Total route-file off-token colour references** | **206** | **0** | — |

Distribution across the 126 route files — 8 files carry all of it, 118 carry none:

| File | Palette utils | Hex utils | Hex literals | Total | Owner-decision exempt? |
|---|---|---|---|---|---|
| `app/shadow/page.tsx` | 171 | 16 | 4 | **191** | **No** |
| `app/admin/page.tsx` | 0 | 4 | 0 | **4** | **No** |
| `app/board/dashboard/page.tsx` | 1 | 1 | 0 | 2 | Yes |
| `app/admin/communications/page.tsx` | 1 | 1 | 0 | 2 | Yes |
| `app/admin/macro-analytics/page.tsx` | 1 | 1 | 0 | 2 | Yes |
| `app/admin/curriculum/page.tsx` | 1 | 1 | 0 | 2 | Yes |
| `app/coach/operations/page.tsx` | 1 | 1 | 0 | 2 | Yes |
| `app/admin/retro-lab/page.tsx` | 0 | 1 | 0 | 1 | Yes |

**Excluding the six owner-decision pages entirely, the count is 195, not 0** —
191 of them in `app/shadow/page.tsx` and 4 in `app/admin/page.tsx`.

`apps/web/components/` measures **0** on every colour category. That half of the
claim is true and is the strongest single result of this pass.

Three separate things are tangled in the "191 → 0" claim and they should be
untangled before anyone tries to re-verify it: the count depends on whether you
count files or occurrences, whether `bg-[#09090b]` counts as a "utility", and
whether the six exempt pages are in scope. On the most generous reading available
— occurrences, excluding the exempt six — it is 195. On no reading is it 0.

### Law 2 — specific misuses on non-exempt surfaces

- `app/shadow/page.tsx:100-103` maps all four evidence tiers to the same
  off-token red. See Findings.
- `components/DevelopmentPipelineBanner.tsx:47` paints a *completed* pipeline
  stage in `--locked-ink`, the ink of the safety ladder's locked rung. See
  Findings.
- `src/components/curriculum/CurriculumProgressionEngine.tsx:179` uses
  `text-emerald-400` for `Skill Certification: READY` — a saturated green that is
  not `--cleared`, standing in for a clearance state. Inside the exempt six, so
  recorded here rather than as a finding.

### Law 8 — arbitrary sizing

`text-[NNpx]` occurrences: **52** in route files, **12** in `components/`, **38**
in `src/components/`. Non-token radii (`rounded-2xl`, `rounded-xl`, `rounded-[NNpx]`):
**10**, in 6 files. Both violate `FRONTEND_STYLE_CONTRACT.md`'s "Nothing is sized
by eye" and its guardrail 3. `app/admin/page.tsx:1203` carries `text-[14px]` and
`hover:bg-[#2a1a1a]` in the same class list, on the same four buttons.

### Law 7 — refusal treatment

`ppbf.css` ships a complete refusal vocabulary: `.stamp` (`--stamp-red` #A81E22),
`.stamp--sm`, `.stamp--brass`, `.stamp--flat`, `.stamp--lg`, `.stamp--green`,
`.stamp--press`, per-material ink restatements at lines 630–646, and a print
block. 42 `className` sites across 22 files use it, and several carry comments
citing Law 7 by name — `app/shadow/scout/page.tsx:465` (*"governance refusal — a
static ink stamp, never a toast"*), `components/BoardRoleGate.tsx:148`,
`components/BoardMemberDashboard.tsx:219-221`.

The gap is not the vocabulary; it is the boundary. **The server distinguishes a
governance refusal from a fault, and every client throws that distinction away.**
`src/server/pilot/http.ts`'s `jsonError` has typed branches for `PilotError`
(carrying an ALL-CAPS `code` and its own status), `MedicalStatusBlockedError`
(409) and `GuardianConsentMissingError` (409), each with a comment explaining
that the refusal is expected and safe to disclose. Measured on the client side:

- Route files that branch on `response.status === 409`: **1 of 126**
  (`app/admin/people/page.tsx:687`, and it does it well).
- Route files or components that read `payload.code`: **0**.
- `alert alert--critical` usages across app + components: **64**, in 51 files.
- Distinct `alert-title` strings: **13**. The most common is `Failed`, used **23**
  times.

So a `MedicalStatusBlockedError` — the exact "a child's body" refusal the visual
brief calls the most serious of its six gates — arrives at the user as the same
`✕ FAILED` banner as a 500. Full finding below.

### Invented CSS classes

`components/designSystemClasses.test.ts` walks **every** `.ts`/`.tsx` file under
`apps/web` (`sourceFiles(join(REPO, 'apps', 'web'))`, line 87), so it is
file-complete — `src/components/`, `scripts/` and `app/` are all in scope. It is
not *namespace*-complete: it only checks tokens beginning with one of the 14
`OWNED_PREFIXES` at lines 32–47. Six classes referenced in shipped markup are
defined in neither `ppbf.css` nor `globals.css` and are invisible to it. Full
finding below.

---

## Dead ends

| Dead end | Where | Effect |
|---|---|---|
| `/coach` has no `page.tsx`, no route handler, no redirect | 9 coach pages link to it | The only "back" affordance on nine coach screens is a 404 |
| `MediaAndCommsHub` has zero `<button>`, zero `<form>`, zero `onSubmit`, zero `fetch` | `src/components/communications/MediaAndCommsHub.tsx` | 11 text inputs — including a public enquirer's name and email, an athlete reflection, and a "VAMilitary Records" paste box labelled "Activates adaptive kinetic limiters" — accept typing and discard it on navigation |
| `<ThemeToggle />` mounted, nothing reads `data-theme` | `app/retro-lab/page.tsx:77` | A visible control that changes a scoreboard label and nothing else; the page tells the user the opposite |
| Board dashboard's manual-override Acknowledge | `src/components/board/BoardViewportSwitcher.tsx:85-91` | `setTrainingMinutes((value) => value)` — a no-op. **Known**: reported by the 2026-08-17 audit §2.4 |
| 3 orphan components with no importer | `PaymentSetupBubble.tsx`, `SkeletonLoader.tsx`, `TutorialButton.tsx` | 313 lines of dead UI, two of which `docs/CANVAS_CONTEXT_PACK.md` instructs future agents to use |
| `RevenueFundingCenter`'s two `href` targets are `/help#…` anchors | `components/RevenueFundingCenter.tsx:390,396` | Not dead — `/help` exists. Recorded because the visual brief expects links to `/admin/grants` and `/admin/memberships` here and there are none |

**Checked and clear:** all 103 `href` values in `components/buildingMap.ts`
resolve to a real page. Every other internal `<Link href>` in `app/`,
`components/` and `src/` resolves. The prior audit's finding that all ~324
`fetch()` call sites resolve to a real `route.ts` was not re-run; API-without-UI
cases are enumerated in `NETWORK_STATUS.md` and the prior audit §3 and are not
re-reported here.

---

## Findings

### [HIGH] `/simulator` renders invented coaching guidance graded on the Layer 11 safety ladder, ungated and undisclosed

Seven hardcoded scenarios, each proposing a change to a child's training and
grading its risk. The grade is rendered on the safety ladder's own components.

`apps/web/app/simulator/page.tsx:13-19`:

```
  {
    title: 'Training Load',
    currentState: 'Load spread balanced across weekly cycle.',
    proposedChange: 'Shift one recovery session to additional technical sparring prep.',
    expectedOutcome: 'Potential higher output but tighter recovery margins.',
    riskRating: 'High',
  },
```

`apps/web/app/simulator/page.tsx:57-64`:

```
/* Law 2/3: a risk rating is a genuine graded status, so it rides the status
   ladder -- and every rung carries a glyph plus an uppercase label so the
   scale survives greyscale board packets. */
function riskBadge(risk: 'Low' | 'Moderate' | 'High') {
  if (risk === 'Low') return { className: 'badge badge--cleared', glyph: '✓', label: 'Low Risk' };
  if (risk === 'Moderate') return { className: 'badge badge--restricted', glyph: '▲', label: 'Moderate Risk' };
  return { className: 'badge badge--locked', glyph: '✕', label: 'High Risk' };
}
```

The comment is right about Law 2 and Law 3 and wrong about the premise: the
rating is not "a genuine graded status", it is a literal on line 18.

The page has no `requirePageRole`, no `RoleSessionGate`, and no auth import of
any kind; `components/buildingMap.ts:284` lists it as `roles: OPEN`, which that
file's own header (line 24) defines as *"a surface with no role gate at all
today"*. It is a door in the global nav, in the `floor` room.

**Refutation attempted, three ways, all failed:**

1. *Is there a disclaimer elsewhere on the page?* No. The full 159 lines were
   read. The closest is a `plaque` reading `ENGINE: FRONT-END ONLY`
   (`app/simulator/page.tsx:70`) and the header line *"Run front-end what-if
   scenarios to evaluate expected outcomes and risk before audit and promotion
   stages"* (line 84). Both describe where the computation happens, not where the
   content came from — and "evaluate expected outcomes and risk" reads as a claim
   that it does.
2. *Is it in a layout that carries one?* No. Of the four `layout.tsx` files in
   the app (`app/`, `app/athlete/`, `app/board/`, `app/wall/`), none contains any
   disclosure vocabulary, and `/simulator` is under none of them but the root.
3. *Is this already reported?* `NETWORK_STATUS.md` lists under "Unclaimed": *"Scenario
   Simulation and Source Governance are islands with zero data edges, whose own copy
   claims hand-offs that no code implements."* That is the **island** problem —
   no data edges. It does not mention fabricated content, risk grades, the safety
   ladder, or the missing disclosure. The 2026-08-17 audit's §2.4 dedicated
   fabricated-data sweep does not list `/simulator` at all.

**The comparison that makes this a miss rather than a judgement call:**
`/source-control` is the same shape by the same hand — zero fetches, hardcoded
lanes, same `DevelopmentPipelineBanner`, same `ShadowChatButton` — and it carries
both halves. `apps/web/app/source-control/page.tsx:96-99`:

```
          <span className="stamp stamp--brass">{capabilityStatus}</span>
          <p className="t-body max-w-[80ch]">
            Shows how cards would move through Draft, Review, Approved, Published, and Archived states before ecosystem release. Every card, version, and count on this page is a sample, not live promotion state.
          </p>
```

**Who is misled and how.** Any signed-in user, including an athlete or a
guardian, since the surface has no gate. A coach opening the Simulator from the
nav sees the platform's own safety-ladder red beside "Shift one recovery session
to additional technical sparring prep" and can reasonably read it as this
platform's assessment of that change for this gym. Adding sparring at the expense
of recovery is precisely the decision class the Layer 11 gate exists to
constrain, and the red badge here is not connected to it.

---

### [HIGH] `/operations` stamps "Signed & Active" over safety guarantees that two other passes of this same audit found unenforced

`apps/web/app/operations/page.tsx:301-306`:

```
              <div className="mat-leather rounded-[var(--r-md)] p-[var(--s4)]">
                <span className="stamp stamp--green">Signed &amp; Active</span>
                <p className="t-body mt-[var(--s4)]">
                  Certification Status: Signed and Active. Logical paths, equations, role boundaries, and sandbox behavior are aligned for SHADOW core build execution.
                </p>
              </div>
```

The claims it certifies are literals above it. `apps/web/app/operations/page.tsx:126-131`:

```
const shadowBoundaryChecks = [
  'Readiness upper bound test resolves to 10.0 and remains stable at clamp.',
  'Readiness lower bound test resolves to 1.0 and remains stable at clamp.',
  'Any readiness score below 5.0 triggers protective route and drill constraints.',
  'Delta RPE lockout engages when discrepancy is 2 or greater until rationale is provided.',
];
```

and `apps/web/app/operations/page.tsx:167-172` (`shadowComplianceChecks`):

```
  '12-role viewport segregation prevents cross-role data leakage.',
  'Athlete view cannot mount finance/admin controls.',
  'Board and governance view cannot parse raw individual biometric streams.',
```

**What this audit already established about those two claims:**

- Finding **F-08** (pass 4, this audit): `readinessMath.ts` has zero callers and
  the stored readiness score is taken raw from the request body. Verified
  independently here: `grep -rn readinessMath` across `apps/web` returns exactly
  two hits, `src/server/pilot/readinessMath.ts` and its own test file. The clamp
  the panel certifies lives in a module nothing calls.
- Finding **F-20** (pass 2, raised to CRITICAL on review): `/api/pilot/safety-flags`
  lets any coach read the whole gym's open safety queue and resolve a flag on any
  child. That is cross-role data reaching a role that should not have it, which
  is what line 167 says cannot happen.

**Refutation attempted:** *Is the panel marked as illustrative?* No. It is a
`<details>` collapsed by default (`app/operations/page.tsx:234`) — which the
2026-08-17 audit correctly counted as a mitigation and the reason it rated this
🟡 — but nothing inside says the content is not a live check, and the summary
reads *"System Diagnostics and SHADOW Certification"*. *Is it admin-only?* No.
`operationsRoles` (line 203) is every role in `components/roleRoutes.ts` — athlete,
coach, parent, admin, staff, volunteer and all eight board seats — plus
`platform_owner`.

**Why the severity moves up from the prior audit's 🟡.** Two reasons, both new
information rather than a re-reading of the same facts. First, the specific
claims are now known to be false, not merely unbacked — that is a cross-pass
result none of the individual passes could produce. Second, the treatment is a
**Law 7 inversion**: `.stamp--green` is the ink `ppbf.css` reserves for
"approved, compliant" (`--stamp-green`, line 148), and the code comment at
`app/operations/page.tsx:295-300` shows the author reaching for it deliberately —
*"A signed certification is a governance decision, so Law 7 gives it ink: a stamp
on the page, in the approved green the system reserves for exactly this."* The
reasoning is sound and the premise is wrong: the system reserves that ink for a
governance decision that was actually made. Nothing signed this. Governance ink
spent on an unverified self-assertion is worse than plain text, because the
system has trained its readers that ink means a decision.

**Who is misled and how.** A parent opening Mission Control and expanding the
panel reads that role isolation prevents cross-role data leakage on the same day
this audit's CRITICAL says a coach can clear another child's concussion-rest
flag. A board member preparing a packet reads a green certification of readiness
clamps that no request path applies.

---

### [HIGH] The recorded basis for the "leave the consoles alone" decision is measurably wrong: one of six carries the stamp, not six

This finding is **not** a request to style the six pages and takes no position on
the owner decision. It concerns one factual sentence that decision is written on.

`docs/HANDOFF_VISUALS.md` (branch `origin/docs/agent-handoff-briefs`), Job 3:

```
That is the right call and worth understanding rather than just obeying,
because it changes what "finished" means for this subsystem. All six already
carry a brass "Planned — Not Yet Implemented" stamp and a "every figure below
is fabricated sample data" disclaimer, so the **honest** problem is solved: no
admin can mistake an invented SafeSport clearance or board figure for a real
one.
```

Measured against the six pages and all seven of their components:

| Page | `.stamp` present | Disclaimer present |
|---|---|---|
| `/coach/operations` | **yes** | **yes** |
| `/admin/retro-lab` | no | yes — a red alert banner, not a stamp |
| `/admin/macro-analytics` | **no** | **no** |
| `/board/dashboard` | **no** | **no** |
| `/admin/communications` | **no** | **no** |
| `/admin/curriculum` | **no** | **no** |

The only true instance is `apps/web/src/components/coach/FloorOperationsDesk.tsx:123-127`:

```
        <p className="mt-3"><span className="stamp stamp--brass stamp--flat">Planned — Not Yet Implemented</span></p>
        <p className="mt-2 text-xs text-zinc-400">
          Every athlete, clearance, attendance figure, and matchup below is fabricated sample data.
          Nothing on this desk reads or writes real records — do not act on anything it shows.
        </p>
```

The sentence in the brief reads as if it were generalised from that one file.

The named counterexample is the worst case. `apps/web/src/components/analytics/MacroCommandCenter.tsx:27-49` is a three-row staff table with invented safeguarding clearances:

```
const staffRecords: StaffRecord[] = [
  {
    id: 'st-001',
    name: 'Avery Hall',
    certificationTracker: 'Level 2 Coaching Ops',
    safeSportStatus: 'Current - Renewal due in 64 days',
    backgroundCheckStatus: 'Cleared - 2026 cycle',
  },
```

rendered under real column headers at lines 147-148:

```
                  <th className="border border-zinc-800 p-2 text-left font-medium text-zinc-400">SafeSport Status</th>
                  <th className="border border-zinc-800 p-2 text-left font-medium text-zinc-400">Background Checks</th>
```

The whole 219-line file contains no occurrence of "planned", "sample",
"fabricated", "placeholder", "mock" or "not yet implemented". The brief's
sentence names this exact case — *"no admin can mistake an invented SafeSport
clearance … for a real one"* — as the thing that is already handled, and it is
the one that is handled least.

**Refutation attempted, four ways:**

1. *Is the stamp in the page wrapper rather than the component?* No. All six
   wrappers were read in full; they are 14–21 lines and contain a role gate and a
   `<main>` and nothing else.
2. *Is it in a shared layout?* No. None of the four `layout.tsx` files contains
   any disclosure vocabulary.
3. *Is `IMMUNITY_GATE` the disclaimer?* `MacroCommandCenter.tsx:25` defines
   `const IMMUNITY_GATE = 'Pending Coach Verification Flag {"verified_by_jason": false}'`
   and renders it in red beneath every SafeSport and background-check cell
   (lines 158, 162). It is the nearest thing to a warning on the page and it does
   not say the row is invented — it says the row is *pending verification*, which
   is a claim about a real record's state. It makes the fabrication more
   convincing, not less.
4. *Has it been fixed since the brief was written?* The brief is dated
   2026-08-17; this branch is pinned to `04dd116b` of the same date. Both were
   read at the same commit.

**Who is misled and how.** Not a user of the platform — the reader of the brief.
Any agent picking up the visual lane is told the honesty problem is solved on
these six pages, so an agent that finds a fabricated SafeSport clearance on
`/admin/macro-analytics` will check the brief, conclude it is a known and
accepted state, and move on. That is what a stale coordination surface costs, and
`NETWORK_STATUS.md`'s own instruction — *"Correct this file when it is wrong
about you"* — is the applicable rule. The owner decision itself ("skip styling,
wire real data instead") is untouched by this and remains correct; what needs
correcting is the sentence claiming the disclosure work is already done, because
that sentence is the reason nobody is expected to do it.

---

### [MEDIUM] `/admin/communications` collects a public enquirer's name and email, an athlete's reflection and pasted military records into eleven inputs that have no save path and no disclosure

`src/components/communications/MediaAndCommsHub.tsx` is 191 lines. It contains
**zero** `<button>`, **zero** `<form>`, **zero** `onSubmit` and **zero**
`fetch(`. Every one of its eleven controls is a bare `<input>` or `<textarea>`
bound to `useState`.

`apps/web/src/components/communications/MediaAndCommsHub.tsx:43-59`:

```
          <h2 className="text-xs uppercase tracking-[0.2em] text-slate-200">[L16] Public Portal Mockup [V-BOARD-PUBLIC]</h2>
          <p className="mt-2 text-xs text-zinc-500">External non-sensitive marketing intake shell</p>
          <div className="mt-3 grid gap-2 text-xs">
            <label className="text-zinc-400" htmlFor="public-first-name">First Name</label>
            <input
              id="public-first-name"
              value={publicFirstName}
              onChange={(event) => setPublicFirstName(event.target.value)}
              className="border border-zinc-800 bg-black p-2 text-slate-200"
            />
```

and `:154-162`:

```
            <div className="border border-zinc-800 bg-black p-2">
              <label htmlFor="va-military-records" className="text-zinc-400">📂 Va90to100 / VAMilitary Records</label>
              <p className="mt-1 text-[11px] text-zinc-500">Activates adaptive kinetic limiters</p>
              <textarea
                id="va-military-records"
                value={vaMilitaryRecords}
                onChange={(event) => setVaMilitaryRecords(event.target.value)}
                className="mt-2 min-h-[120px] w-full border border-zinc-800 bg-black p-2 text-slate-200"
              />
```

The word "Mockup" appears once, inside a section heading at line 43, alongside
build tags. It is the only signal on the page, it applies to one of four
sections, and it sits in the same visual register as `[L16]` and
`[V-BOARD-PUBLIC]`, which are internal build labels rather than user-facing
warnings. Line 156's "Activates adaptive kinetic limiters" is a positive claim
that pasting a record here does something to a training constraint. Nothing
happens.

The page is reachable by `organization_admin`, `admin` **and `staff`**
(`app/admin/communications/page.tsx:10`), a wider gate than the other five
consoles.

**Refutation attempted:** *Is it a controlled component feeding a parent that
saves?* No — it is a default export taking no props, mounted directly with no
callbacks (`app/admin/communications/page.tsx:15`). *Is the field data at least
seeded to look empty?* Three fields are pre-filled: an athlete reflection
(*"I felt stable in the first two rounds, but rushed exchanges after fatigue
onset."*, line 28), a tactical note (line 27), and a timestamp annotation (line
26) — so a staff member arrives to what looks like existing saved content and can
reasonably conclude that typing into it also persists.

**Who is misled and how.** A staff member takes an enquiry from a parent at the
front desk, types the name and email into the Public Portal panel, navigates
away, and the enquiry is gone with no error and no warning. The same shape
applies to an athlete's own words in the reflection block.

**New.** Not in the 2026-08-17 audit's §2.4 sweep (which covers `/board/dashboard`,
`/admin/macro-analytics`, `/operations`, `/coach/operations`, `/admin/retro-lab`
and `admin/curriculum`, but not `/admin/communications`), not in
`NETWORK_STATUS.md`.

---

### [MEDIUM] The server's typed refusal vocabulary is discarded at the UI boundary — a medical block and a 500 render identically

`src/server/pilot/http.ts` deliberately distinguishes governance refusals from
faults, and says so. Lines 98-107:

```
  if (error instanceof MedicalStatusBlockedError) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }

  // T-008: same reasoning as MedicalStatusBlockedError above -- missing
  // guardian consent is an expected, safe-to-disclose precondition failure
  // on a DIFFERENT resource (the guardian's consent record), not a fault of
  // this request. A 400/403 would misdescribe it; 500 would hide the reason.
  if (error instanceof GuardianConsentMissingError) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
```

and `PilotError` (lines 84-89 of the same file, definition in
`src/server/pilot/errors.ts:39-45`) carries an ALL-CAPS machine `code` whose own
comment says it exists *"so a caller can branch on the code rather than the
prose"*.

No caller branches on it. Measured across all 126 route files and 86 components:
**1 file** tests `response.status === 409`; **0 files** read `payload.code`.

The universal treatment, on the surface the visual brief names as gate #1 —
entering a child into an external competition — is
`apps/web/app/operations/external-competition/page.tsx:285-292`:

```
          {errorMessage && (
            <div className="alert alert--critical mt-[var(--s5)]" role="alert">
              <span className="alert-icon" aria-hidden="true">✕</span>
              <div className="alert-body">
                <p className="alert-title">Failed</p>
                <p className="alert-msg">{errorMessage}</p>
              </div>
```

fed by `:228-229`:

```
        const err = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `Entry failed (${response.status})`);
```

The identical block appears at `app/operations/wrestling-league/page.tsx:266-272`
(the league-roster half of the same gate) and `app/coach/transfer-check/page.tsx:116-122`
(the "coach not scoped to athlete" case). `Failed` is the `alert-title` on 23
distinct sites.

`docs/HANDOFF_VISUALS.md` Job 1 anticipates exactly this: *"Without design work
they fall back to whatever generic error surface each page happens to have, which
is the wrong treatment for all six."* What that brief does not record, and what
this pass adds, is that **the server-side half of the work is already done** —
the refusal is already typed, already 409, already carries a code — so the design
work has a discriminator to hang off and does not need one invented. Any page
that wanted to render a stamp instead of a banner could do it today by reading
`status` and `code` off the response it already parses.

**Refutation attempted:** *Do the safety gates in question actually reach these
screens yet?* Partly. PR #452 (per `NETWORK_STATUS.md`, green and not a draft)
adds the training-hold gate to `addCompetitionEntry`; on this branch that gate
does not exist, so today's refusals on these two screens are tenancy and
validation failures rather than safety ones. That bounds the *current* harm and
does not weaken the finding: when #452 merges, its refusal lands in the `✕ FAILED`
box unless this is fixed first, and `MedicalStatusBlockedError` and
`GuardianConsentMissingError` already reach clients on other routes today.

**Who is misled and how.** A coach told `✕ FAILED` beside an ✕ glyph and a
critical-red rule reads a system malfunction and retries, or asks an admin to
retry. A refusal that reads as a fault invites a workaround; a refusal that reads
as a decision does not. That is the whole content of Law 7.

---

### [MEDIUM] Nine coach screens' only "back" control points at `/coach`, which is not a route

`apps/web/app/coach/transfer-check/page.tsx:177` — identical at
`intervention-executions/page.tsx:422`, `intervention-review/page.tsx:376`,
`intelligence/page.tsx:169`, `one-percent-club/page.tsx:337`,
`behavior-standards/page.tsx:268`, `intervention-protocols/page.tsx:307`,
`attempt-log/page.tsx:278`, `floor-groups/page.tsx:336`:

```
            <Link href="/coach" className="btn btn--ghost">Back to Coach Workspace</Link>
```

`app/coach/` contains 24 subdirectories and **no files at its own level** — no
`page.tsx`, no `route.ts`, no `layout.tsx`, no `default.tsx`. There is no
`middleware.ts` in `apps/web`, no `redirects` block in `next.config`, and no
`/coach` rule in `staticwebapp.config.json`. The Coach Workspace itself is mounted
at `/coach/environment/intake-router` (`app/coach/environment/intake-router/page.tsx:9`).

**Refutation attempted, three ways:**

1. *Does `buildingMap` have a `/coach` door that implies the route?* No — all 103
   `href` values in `components/buildingMap.ts` resolve to real pages, and
   `/coach` is not among them.
2. *Does `buildingMapCoverage.test.ts` catch this?* No, and this is the
   mechanism worth recording. That suite is genuinely good — it asserts pages
   have doors, doors have pages, no route is both settled and pending, and no
   exclusion outlives its route. Every one of those runs from the **nav catalog**
   outward. None of them looks at an `<a href>` inside a page body, so a link
   typed into JSX is outside the guard entirely.
3. *Does `staticwebapp.config.json`'s `navigationFallback` rescue it?* Possibly,
   in the Azure Static Web Apps deployment only: it rewrites unmatched paths to
   `/index.html`. I could not establish whether that deployment path is the live
   one for these routes, several of which declare `export const dynamic =
   'force-dynamic'` and cannot be statically exported. **I am not claiming a
   production 404; I am claiming there is no route and no redirect in the Next.js
   app.** Pass 11 owns the deploy question.

**Who is misled and how.** A coach on `/coach/transfer-check` — a safety surface —
finishing a check and pressing the only navigation control on the screen.

---

### [LOW] Six CSS classes in shipped markup exist in no stylesheet, and the guard that exists cannot see them

`components/designSystemClasses.test.ts` scans every file under `apps/web`
(line 87) but only checks tokens starting with one of 14 owned prefixes
(lines 32-47: `room--`, `corridor-`, `catalog-`, `commands-`, `tcard-`, `alert--`,
`btn--`, `mat-`, `pap--`, `seal--`, `stamp--`, `badge--`, `light--`, `light-at--`).
Six classes outside those namespaces are referenced in markup and defined in
neither `design-system/ppbf.css` nor `apps/web/app/globals.css`:

| Class | Referenced at | Nearest defined neighbour |
|---|---|---|
| `ledger-tape__edge--top` | `app/retro-lab/page.tsx:278` | `.ledger-tape__edge` — globals.css:666 |
| `ledger-tape__edge--bottom` | `app/retro-lab/page.tsx:287` | same |
| `gym-wall-head` | `components/GymWallModule.tsx:117` | none |
| `gym-wall-frame` | `components/GymWallModule.tsx:123,153` | none |
| `chalkboard-open` | `components/Chalkboard.tsx:289` | none |
| `wall-names-year` | `components/WallOfNames.tsx:161` | `.wall-names-year-plate` — globals.css:1270 |
| `t-h1` | `app/auth/link/page.tsx:98` | `.t-command`, `.t-body`, `.t-data` … — ppbf.css:538-568 |

`apps/web/app/auth/link/page.tsx:98`:

```
      <h1 className="t-h1 mb-[var(--s4)]">The Bell</h1>
```

`ppbf.css` has no `.t-h1`. The type ladder is the six voices at lines 538-568 and
the `--t-xs … --t-4xl` scale; `t-h1` belongs to neither, so the magic-link landing
page's only heading renders at the browser's default `h1` in the inherited family.

**Refutation attempted:** every candidate was re-checked with an exact-boundary
grep against both sheets and against every `.css` file in the repo outside
`node_modules` and `.next`. `.wall-names-years` and `.wall-names-year-plate` exist;
`.wall-names-year` does not — a plain `\b` grep matches the `-plate` rule and
produces a false negative, which is why the first pass looked clean.

Severity is LOW because the visible effect is a missing treatment rather than a
wrong one. The reason to record it is the mechanism: the guard's own header says
*"It is deliberately narrow: only prefixes the design system owns, so Tailwind
utilities and one-off app classes cannot produce noise."* That trade is defensible,
but it means `docs/HANDOFF_VISUALS.md`'s claim — *"A class that is not in
`ppbf.css` does not exist … `designSystemClasses.test.ts` fails the build on
invented CSS classes — that test is the guard"* — is true only for 14 namespaces,
and six live counterexamples exist today.

---

### [LOW] `app/admin/page.tsx` — the admin hub — carries four raw hex values and four eyeballed type sizes

`apps/web/app/admin/page.tsx:1203`, repeated verbatim at 1211, 1219 and 1227:

```
                  className="inline-flex h-11 items-center border border-[color:var(--brass-700)] bg-[var(--hide-900)] px-4 text-[14px] font-bold text-[color:var(--bone-100)] transition hover:bg-[#2a1a1a]"
```

These are the CONSENT, LOAD ROSTER, EQUIPMENT and CUSTOMIZE buttons on the admin
hub. Everything in the class list comes from a token except two things: the hover
fill is a raw hex, and the size is `14px` rather than a rung of the √φ ladder.
`#2a1a1a` is not any token in `ppbf.css`; the nearest are `--hide-800: #2A1F18`
and `--brick-900: #2A1712`.

This is the only non-exempt raw hex in the app outside `/shadow`, and it sits on
the highest-traffic admin surface. `FRONTEND_STYLE_CONTRACT.md` guardrail 1 is
*"No new hardcoded hex values in `apps/web/app` or `apps/web/components`."*

**Refutation attempted:** is `#2a1a1a` a token by another name? No — grepped as
both `2a1a1a` and `2A1A1A` across `ppbf.css` and `globals.css`, zero hits.

---

### [LOW] `/shadow` maps four evidence tiers to one identical off-token red, in a `Record` whose comment explains why they should differ

`apps/web/app/shadow/page.tsx:94-104`:

```
// Law 7 gives a refusal ink, and the sheet resolves .stamp's ink per ground:
// stamp-red on paper/canvas, locked-ink on the leathers. A message bubble is
// neither -- its ground is the evidence-tier fill above -- and the leather
// panel around it would force the light ink onto the one LIGHT bubble
// (RESEARCH_NEEDED), where it cannot read. Stated per tier instead.
const STAMP_INK_BY_TIER: Record<ShadowEvidenceTier, string> = {
  PROVEN: '#dc2626',
  EMERGING: '#dc2626',
  EXPERIMENTAL: '#dc2626',
  RESEARCH_NEEDED: '#dc2626',
};
```

The comment's entire justification for the map is that one tier needs a different
ink from the others. All four values are identical, so the map does the thing the
comment says would not work, and the specific failure it describes —
`RESEARCH_NEEDED`'s light bubble getting an unreadable ink — is what it now
produces, since it is the same dark red as the three dark bubbles.

`#dc2626` is Tailwind `red-600`. The refusal ink in this system is
`--stamp-red: #A81E22` (`ppbf.css:147`), which also equals `--locked`. Law 2
reserves saturated red for the safety gate.

`/shadow`'s off-system styling as a whole is **known** — the 2026-08-17 audit
§2.3 traced the seven-page console cluster and identified it as a regression from
a prior conversion pass, not a design-system gap. This specific map is not in that
report and is recorded because the comment makes it a self-refuting artefact
rather than an unconverted leftover, which changes what fixing it means.

---

### [LOW] The pipeline banner paints a completed stage in the safety ladder's locked ink

`apps/web/components/DevelopmentPipelineBanner.tsx:44-50`:

```
                  isCurrent
                    ? 'border-[color:var(--brass-300)] bg-[var(--hide-700)] text-[var(--bone-200)]'
                    : isComplete
                      ? 'border-[color:var(--brass-700)] bg-[var(--hide-800)] text-[var(--locked-ink)]'
                      : isUpcoming
```

`--locked-ink` (`ppbf.css:116`) is the readable text colour of the `locked` rung —
the Layer 11 state that means an athlete may not train. Here it means "this
pipeline stage is done". The banner is mounted on `/source-control`, `/simulator`
and the other pipeline pages.

`FRONTEND_STYLE_CONTRACT.md` scope note 4 calls this class of misuse *"the
highest-priority drift"* and records that the `--red-primary` version of it was
purged. This is the same shape via a different token, which is presumably why the
purge missed it.

**Refutation attempted:** is `--locked-ink` neutral enough to be chrome? It is
`#F3C9C6`, a pale pink, and it is a *pair member* — `ppbf.css:116` defines it on
the same line as `--locked: #A81E22` precisely so the two travel together. Using
half a status pair as decoration is what Law 2 forbids.

---

### [LOW] Three components with no importer, two of which the docs instruct future agents to use

`components/PaymentSetupBubble.tsx` (101 lines, plus a 4-case test suite in
`components/paymentSetupBubble.test.tsx`), `components/SkeletonLoader.tsx` (139
lines), `components/TutorialButton.tsx` (73 lines). Grepped for their identifiers
across `app/`, `components/` and `src/` excluding test files: zero importers.

`docs/CANVAS_CONTEXT_PACK.md:75-76`:

```
- `SkeletonLoader` — loading placeholders (use these, don't invent spinners)
- `TutorialButton` / `TutorialCard` — in-app help
```

`docs/archive/FRONTEND_BACKEND_AUDIT.md:690` records `TutorialButton` at "30+"
usages. It is now at zero, and `TutorialCard` — its sibling in the same
instruction — is still live (`app/help/page.tsx`).

`PaymentSetupBubble` is the more interesting one: it has a passing test suite
pinning behaviour nothing exercises, and it is the only file in `components/`
using a non-Fibonacci radius (`rounded-2xl`, line 59).

Pass 12 owns docs-vs-code; this is recorded here as the frontend half of the same
fact, so the two can be reconciled rather than each fixing one side.

---

### [LOW] `/retro-lab` ships a theme toggle that does nothing, and tells the user it does something

`apps/web/app/retro-lab/page.tsx:71-77`:

```
              <p className="mt-1 max-w-2xl text-sm text-[var(--gray-dark)]">
                Toggle the theme, press stamps, and watch the ledger. Existing pages pick up the retro
                palette automatically via CSS variables.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <ThemeToggle />
```

`components/ThemeProvider.tsx:13-21` says the opposite, in its own words:

```
/* The platform ships ONE look: the golden-era design system in
   design-system/ppbf.css, applied unconditionally by app/globals.css.

   This provider is kept wired but inert on purpose — a second theme is a
   planned feature, not a current one. Nothing reads data-theme any more (the
   [data-theme="retro"] rules that used to gate the golden-era styling are now
   unconditional), and ThemeToggle is no longer mounted in the global header.
```

Verified: `grep -rn 'data-theme'` across `design-system/ppbf.css` and
`apps/web/app/globals.css` returns zero hits. The toggle writes
`document.documentElement`'s `data-theme` and localStorage, and the page's own
scoreboard reports `THEME: RETRO` / `THEME: TACTICAL` back to the user
(`app/retro-lab/page.tsx:59, 88-90`), so the control gives feedback that a change
occurred while no rule anywhere responds to it.

The provider's comment is accurate about the *header*; `ThemeToggle` is mounted
here instead. `FRONTEND_STYLE_CONTRACT.md` guardrail 2 — *"no second palette —
there is one look, and no `[data-theme]` toggle"* — is satisfied by the
stylesheets and contradicted by this one mount.

---

### [LOW] `TrainingHoldBanner` fails silent in both directions — including the direction where a held child sees nothing

`apps/web/components/TrainingHoldBanner.tsx:44-58`:

```
        const response = await fetch(`${apiBase()}/api/pilot/training-holds`, {
          credentials: 'include',
          signal: controller.signal,
        });
        if (!response.ok) return;
        const payload = (await response.json()) as { hold?: AthleteFacingHold | null };
        if (payload.hold) setHold(payload.hold);
      } catch {
        // Render nothing on failure: an unreachable API is not a hold.
      }
    })();
    return () => controller.abort();
  }, []);

  if (!hold) return null;
```

This is the only component the loading/error/empty sweep flagged across the 15
fetch-backed safety surfaces, and **the refutation largely succeeds**, so it is
recorded at LOW with that stated. The file's own header (lines 10-13) explains
the choice: *"renders nothing when there is no active hold (or when the fetch
fails — an error here must never dress itself up as 'you are held')"*. Telling a
child they are held when they are not is a real harm and a false positive here is
worse than a false negative. The component is informational and gates nothing.

What the choice does not consider is the third option. There are three states —
held, not held, and not known — and the component collapses the third into the
second. An athlete under an active `all_training` hold whose workspace cannot
reach the API sees a workspace that looks exactly like a cleared athlete's. Pass
4's finding that *"no coach-facing screen shows the hold at the door"* means this
banner is a larger share of the visible signal than its severity suggests. A
one-line "we could not check your status right now" is available and is neither
of the two states the comment weighs against each other.

**The other 14 safety surfaces are clean.** `/admin/safety-flags`,
`/admin/safety-review`, `/admin/escalations`, `/admin/waiver-status`,
`/admin/portrait-review`, `/admin/video-review`, `/admin/video-compliance`,
`/admin/compliance-center`, `/admin/athlete-consent`, `/admin/consent`,
`/parent/safety`, `/parent/consent`, `/board/compliance-monitoring` and
`/board/escalation-monitoring` each carry an error branch, a loading branch and an
empty state. `/admin/consent` was initially flagged by the sweep and refuted on
reading — it uses `rosterError` / `waiversError` / `saveError` rather than the
`errorMessage` name the heuristic looked for, and handles all three fetches.

---

## Minors' data on screen — what each component assumes about what it was handed

Scope note: this section reports **only** what a component assumes about its
inputs. Pass 2 owns authorization and pass 3 owns consent; nothing here re-opens
either.

**The portrait path is the strongest work in this codebase and should be recorded
as such.** `components/ProfilePortrait.tsx:25-28`:

```
 * It is also the privacy fallback, and that is deliberate. A viewer who may not
 * see a child's face gets exactly what a viewer of a member with no photo gets.
 * There is no "hidden" badge, no lock glyph, nothing that says a photograph
 * exists -- because saying so is itself a disclosure about that child.
```

Its `photoAvailable: false` path *never requests the photo route at all* (line 35),
so a refusal produces no network trace either. `next/image` is imported **nowhere**
in `app/`, `components/` or `src/` — the constraint in `docs/HANDOFF_VISUALS.md`
Job 2 about the optimizer's shared cache is honoured globally, not just at the one
route that documents it.

What the component assumes: that `photoAvailable` was decided by someone who
consulted `profileVisibility.ts`. Traced its three callers —
`components/FightCard.tsx:54,88`, `components/ParentHub.tsx:521`,
`components/CoachWorkspace.tsx:1791` — and all three carry the value through from
a fetched payload (`payload.card.photoAvailable`, `face.photo_available`); none
hardcodes `true`. `ParentHub.tsx:295` initialises it to `false` before the fetch
resolves, which is the safe default.

Seven components receive minors' data as props and perform no fetch of their own,
so each is entirely dependent on its caller's scoping:

| Component | Receives | Mounted by |
|---|---|---|
| `ProfilePortrait.tsx` | `accountId`, `name`, `initials`, `photoAvailable` | FightCard, ParentHub, CoachWorkspace |
| `PhotoSlot.tsx` | slot + uploaded source | GymWallModule, AthleteWorkspace, ParentHub |
| `FightCard.tsx` | card payload incl. coach and athlete identity | ProfileHeader, ProfileSettings, ParentHub, PrintableFightCard |
| `PrintSheet.tsx` | print payload | PrintRoom, PrintableFightCard, PrintableCertificate |
| `PrintableFightCard.tsx` | as above | PrintRoom |
| `PrintableCertificate.tsx` | as above | PrintRoom |
| `RoleSummaryPanels.tsx` | role + identity string only | ParentHub and role landings |

`PrintableFightCard.tsx:28` is worth quoting because it is the component
declining data it was given: *"The photograph is deliberately dropped even when
`photoAvailable` is true."* A print artefact leaves the building on paper, and the
component treats that as a different question from on-screen visibility.

`components/RoleSummaryPanels.tsx:465-470` records a removal rather than a
capability:

```
  // This card intentionally shows no canned question/answer example. A prior
  // version displayed a hardcoded sample exchange (including, in the coach
  // case, specific fabricated athlete names and injury/readiness flags) as if
  // it were a live SHADOW response. Every response shown to a user must come
  // from the real chat below/linked here, never a static placeholder that
  // could be mistaken for real guidance about a real athlete.
```

**The one place a minor's data is on screen and the screen is admittedly wrong**
is `/admin/portrait-review`, and it is already documented. On this branch the page
renders `full_name` and `uploaded_at` and two buttons
(`app/admin/portrait-review/page.tsx:143-162`) and never displays the photograph
the admin is attesting to. `docs/HANDOFF_VISUALS.md` Job 2 describes this exactly
and says a PR is adding the image and a view-gate. **Confirmed as still open at
`04dd116b`, not re-reported as new.**

Two invented child names do render, on `/admin/curriculum`
(`src/components/curriculum/CurriculumProgressionEngine.tsx:129-130`, "Lena Cho"
and "Jonah Ruiz", produced by `issueMockBadge`). They are fictional, so no real
child is exposed; they are counted in the fabricated-data table, not here.

---

## Checked and found sound

Recorded because a pass that reports only defects gives a false picture of the
surface, and because several of these are places another agent would otherwise
spend an afternoon.

- **`apps/web/components/` is at zero off-token colour.** All 86 files, all 22
  Tailwind palettes, all bracketed hex, all bare hex literals. Measured, not
  spot-checked.
- **`next/image` appears nowhere** in `app/`, `components/` or `src/`. The
  session-scoped-portrait constraint holds globally.
- **All 103 nav doors resolve**, and `buildingMapCoverage.test.ts` guards the
  relationship in both directions with four separate assertions plus two
  anti-rot checks (no exclusion for a dead route, no door for a dead page).
- **14 of 15 fetch-backed safety screens** carry a loading branch, an error
  branch and an empty state.
- **`components/BoardMemberDashboard.tsx`** is the model for the whole
  fabricated-data problem: a page-level explanation (line 213), a per-card stamp
  on planned items only (line 222), a block-level stamp over the module lists
  (line 246), and a Law 7 stamp on the disabled-intelligence refusal (line 270).
  Eight board seat pages inherit all of it.
- **`app/source-control/page.tsx`** and **`app/source-control/publication-workflow/page.tsx`**
  both carry a brass stamp and a plain sentence naming every fabricated element.
- **`components/RevenueFundingCenter.tsx:191-196`** deliberately ships an *empty*
  donation list with a comment explaining that a seeded amount would be read as
  money the gym received. That is the right instinct applied without being asked.
- **`app/guardian/page.tsx`** renders no data at all and says so on screen
  (lines 68-73), then links to the surface that does. A page that could easily
  have faked a snapshot and does not.
- **`app/director/dashboard/page.tsx:8-10, 27`** replaced a fabricated escalation
  queue with prose saying it used to be there — a retraction left visible rather
  than a quiet deletion.
- **`app/launch/page.tsx`** (a one-line re-export) and
  **`app/admin/safety-escalations/page.tsx`** (a redirect) are both documented in
  `buildingMapCoverage.test.ts`'s exclusion list with reasons.
- **`app/admin/organizations/test/page.tsx:16-26`** gates the disabled wizard at
  the component boundary with a comment explaining that an early return inside
  the wizard would make hook order depend on an env flag.
- **`app/simulator/page.tsx:60-63`** — the same function this pass reports as a
  HIGH — is nonetheless correct about Law 3: every rung carries a glyph and an
  uppercase label. The defect is the data, not the treatment.

---

## Could not establish

- **Whether `/coach` returns a 404 in the deployed environment.**
  `staticwebapp.config.json`'s `navigationFallback` rewrites unmatched paths to
  `/index.html`, which may serve something. Several of the routes involved declare
  `export const dynamic = 'force-dynamic'` and cannot be part of a static export,
  so it is unclear which artefact is actually served. Establishing this needs
  deployment knowledge that pass 11 has and this pass does not. The claim made
  here is narrower and is certain: there is no `/coach` route and no redirect in
  the Next.js app.
- **What any of these screens actually looks like.** No dev server was started,
  no `npm run sweep` was run, no screenshot taken. `FRONTEND_STYLE_CONTRACT.md`
  is explicit that the unit suite cannot see the class of fault sweep catches and
  that several regressions have shipped past 2,600 green tests while being visible
  on screen. Everything in the Law 2 and Law 8 sections is a source measurement,
  not a rendering verdict.
- **Whether the 101 unopened route files and 74 unopened components contain
  fabricated data that the six mechanical checks missed.** The classifier keys on
  display-shaped object literals and on zero-fetch files. A page that fetches real
  data and interpolates one invented constant into it would not be flagged. The
  targeted sweep for hardcoded currency and 4-digit figures in JSX returned only
  4 hits, all in the console cluster, which is weak evidence that this shape is
  rare — not evidence that it is absent.
- **Whether `/simulator`'s lack of a role gate is intentional.**
  `components/buildingMap.ts:24` describes `OPEN` as advisory only and says the
  real gate lives elsewhere; `/simulator` has no `requirePageRole` and no
  `RoleSessionGate`, but whether some upstream mechanism gates it is pass 1's and
  pass 2's question. The finding's severity does not depend on the answer — an
  undisclosed fabricated risk grade is a HIGH for a coach whether or not an
  athlete can also reach it — but the blast radius does.
- **Whether the six console pages are reachable from any in-app navigation.** The
  2026-08-17 audit records that nothing links to `/board/dashboard` and treats
  that as mitigating. I did not re-verify that for the other five, and
  `components/buildingMap.ts` does list doors in the office, floor, board and
  night rooms whose relationship to these six I did not trace.

---

## Cross-references for pass 13

Three things here are only visible between passes and are flagged for synthesis:

1. **`/operations`'s certification panel** asserts, in governance ink, two things
   that passes 2 and 4 of this same audit found false (F-08 readiness clamps
   unwired; F-20 cross-role safety-queue access). Neither pass could see the
   assertion; this pass could not have known the assertions were false.
2. **The Law 7 gap has a ready-made discriminator.** The server already types and
   codes its refusals; the UI already parses the response body it would need. Any
   fix to the six gates in `HANDOFF_VISUALS.md` Job 1 should be one change at the
   fetch boundary, not six page-level designs. That observation needs both the
   API pass and this one to make.
3. **`docs/HANDOFF_VISUALS.md` is wrong in two measurable places** — the "0
   off-system colour" baseline and the "all six carry a stamp" premise — and it is
   the standing brief for anyone who picks up the visual lane. It sits on
   `origin/docs/agent-handoff-briefs`, the same unmerged branch as
   `NETWORK_STATUS.md`, which this audit already recorded as a coordination
   defect. Pass 12 should decide whether that file is docs or contract.
