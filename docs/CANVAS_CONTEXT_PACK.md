# PPBF Canvas Context Pack

**Purpose:** Everything Canvas (or any design/build tool) needs to know to design
UI that fits the PPBF app — what the product is, who uses it, how it's structured,
what data exists, and the visual rules. Paste this whole file in as context, then
ask for the specific screen you want.

> **Companion file:** the exact colors, fonts, and component specs live in
> [`docs/BRAND_DESIGN_BRIEF.md`](./BRAND_DESIGN_BRIEF.md). This pack gives the
> *product & structure* context; the brief gives the *visual* rules. Give Canvas both.

---

## 1. What the product is

**Punxsy Prominence Boxing & Fitness (PPBF) Platform** — a nonprofit, safety-first
training and youth-development platform for a boxing/combat-sports gym. Boxing is the
hook; youth development (discipline, confidence, life skills) is the goal. Kids
participate free.

- **Stack:** Next.js (App Router) + React + TypeScript, Tailwind CSS v4, PostgreSQL backend.
- **Multi-organization:** every record is scoped to an `organization_id`; gyms are isolated from each other. Only "Platform Owner" sees across orgs.
- **AI assistant ("SHADOW"):** an evidence-based training assistant with strict safety/refusal rules, embedded across many screens.
- **Auth:** opaque session tokens in HTTP-only cookies; PIN-based login for athletes, Microsoft sign-in for staff/board.

## 2. Who uses it (roles → what they see)

Design for **role-specific workspaces**. Each role lands on its own home:

| Role | Lands on | What that space is for |
|---|---|---|
| **Athlete** | `/athlete/dashboard` | Training progress, sparring surfaces, video analysis, progression intelligence |
| **Coach** | `/coach/review-queue` | Review queue, intake routing, decision loop, sports-medicine, video publications |
| **Parent** | `/parent/dashboard` | Track a child's training progress & progression visibility |
| **Admin** | `/admin` | Capability/governance controls, people, orgs, compliance, volunteers |
| **Board** (+ 8 seats) | `/board` | **Aggregate-only** governance hub — compliance, summaries. No individual athlete PII. |
| **Platform Owner** | `/admin/platform` | Cross-organization oversight |

Board seats: President, Chair, Vice-Chair, Treasurer, Secretary, Program & Safety
Director, Community & Development Director, Director-at-Large. All open the aggregate
board hub; seat-specific access is server-authorized.

> **Design implication:** every screen exists *inside a role*. Tell Canvas which role
> a screen is for — an athlete screen is personal & motivational; a board screen is
> aggregate, governance-toned, and must never show individual PII.

## 3. Screen map (routes that already exist)

Restyling an existing route = **front-end only** (see §6). These are the live pages:

**Public / entry:** `/` (marketing home), `/login`, `/activate`, `/change-pin`, `/help`, `/launch`

**Athlete:** `/athlete/dashboard`, `/athlete/dashboard/sparring`, `/athlete/progression-intelligence`, `/athlete/video-analysis`, `/athlete/sign-in`

**Coach:** `/coach/review-queue`, `/coach/decision-loop`, `/coach/environment/intake-router`, `/coach/environment/passbook-check`, `/coach/progression-intelligence`, `/coach/sports-medicine`, `/coach/video-analysis`, `/coach/video-publications`

**Parent:** `/parent/dashboard`, `/parent/progression-visibility`

**Admin:** `/admin`, `/admin/people`, `/admin/organizations`, `/admin/platform`, `/admin/platform/overview`, `/admin/compliance-center`, `/admin/public-interest`, `/admin/shadow`, `/admin/volunteer-management`, `/admin/pin`

**Board:** `/board`, `/board/[seat]` (president, chair, vice-chair, treasurer, secretary, safety-director, community-director, at-large), `/board/compliance-monitoring`

**SHADOW & knowledge:** `/shadow`, `/shadow/scout`, `/research`, `/research/chat`, `/evidence`, `/knowledge-graph`, `/audit`, `/simulator`

**Operations:** `/operations`, `/operations/external-competition`, `/operations/wrestling-league`, `/schedule`, `/source-control`, `/source-control/publication-workflow`, `/guardian`

## 4. Existing building-block components

New UI should reuse or match these (in `apps/web/components/`):

- `GlobalRoleHeader` — sticky top bar: role badge, nav, logout (present on every page after login)
- `AthleteWorkspace`, `CoachWorkspace`, `ParentHub`, `BoardMemberDashboard` — the big per-role screens
- `RoleSummaryPanels`, `FeatureSurface`, `RevenueFundingCenter` — reusable panel groups
- `ShadowChatButton` — the SHADOW assistant entry point
- `SkeletonLoader` — loading placeholders (use these, don't invent spinners)
- `TutorialButton` / `TutorialCard` — in-app help
- `RoleSessionGate` / `BoardRoleGate` — auth/role guards wrapping protected screens
- `uiStyles.ts` — the shared class registry (tabs, buttons, panels). **Use these classes, don't hand-roll new ones.**

## 5. What data exists (so designs match reality)

The app has real API endpoints under `apps/web/app/api/pilot/*`. If Canvas designs a
screen, the data it shows should map to these (don't invent data that has no source):

- **Athletes:** list / get / update; athlete accounts, PIN directory
- **Goals & progression:** goals, progression assignments, completions, gaps
- **Sessions:** training session logging (list / get / update)
- **Coach reviews:** review queue, review actions, decisions
- **Intake:** cases, domain intake, review queue/actions
- **Compliance & safety:** violations, escalations, compliance summaries, near-misses, medical status
- **Board:** aggregate summary, compliance summary (no individual PII)
- **SHADOW AI:** chat, recommendations, decisions, evidence library (documents/chunks/claims/search), metrics, telemetry, video analysis
- **Media:** video upload/list, floor-plans, publications (create/check/publish/library)
- **Announcements & scheduling:** announcements get/post, scheduler
- **Admin/platform:** organizations, memberships, staff, volunteers, activation codes, capabilities

> **Design implication:** screens are **data-dense dashboards**, not marketing pages
> (except `/`). Expect tables, queues, status badges, metric tiles, review cards,
> chat panels. Design for lots of structured information, scannable at a glance.

## 6. How a Canvas design becomes a working feature

1. **Design** in Canvas using this pack + the brand brief → get HTML/React back.
2. **Translate** to repo conventions: hardcoded hex → CSS vars from `globals.css`; repeated controls → `uiStyles.ts` classes; component into `apps/web/components/`, page into `apps/web/app/<route>/page.tsx`.
3. **Wire** to data: fetch from the `apps/web/app/api/pilot/*` endpoints above, respect the role session + `organization_id` isolation. *Restyling an existing screen needs no back-end change; a brand-new capability may need a new API route + DB migration.*
4. **Merge:** run `lint` / `typecheck` / `test` / `build`, push, open a PR, let CI gates run, review, merge.

## 7. Hard rules Canvas must respect

- **Visual:** the **"Leather & Brass"** system — a boxing gym run properly for forty years. Two grounds (ink for staff, warm canvas for family/public), real materials only (leather, brass, slate, cork, paper), heavy slab-serif display type (NOT stencil), **hard blur-free offset shadows**, saturated colour reserved for the safety ladder. Exact hexes, faces, and proportion live ONLY in [`BRAND_DESIGN_BRIEF.md`](./BRAND_DESIGN_BRIEF.md) — do not restate them here; when this file and the brief disagree, the brief wins. No gradients, no rounded SaaS cards, no blue/cyan.
- **Accessibility:** visible red focus rings, 44px min touch targets, keyboard-navigable.
- **Safety/governance tone:** this is a youth-safety product. Board/aggregate screens must never show individual athlete PII. Copy is disciplined and plain, not hype.
- **Consistency:** match existing role workspaces before inventing new patterns; reuse `uiStyles.ts`.

## 8. One-paragraph brief to paste at the top of a Canvas request

> Design a [ROLE] screen for the PPBF platform — a nonprofit youth-boxing training &
> development web app (Next.js dashboards, not a marketing site). It's for the [ROLE]
> workspace, showing [what data — e.g. the coach review queue / athlete progression /
> board compliance summary]. Use the PPBF "Leather & Brass" aesthetic — the back
> office of a boxing gym run properly for forty years: [ink `#14100D` ground for
> staff screens | warm canvas `#EFE4C8` for family/public], leather panels with
> saddle-stitch rules, oxidized patina hardware, heavy slab-serif wood-type
> headings (like Alfa Slab One — NOT stencil), condensed-sans body (Oswald), mono
> uppercase micro-labels, hard blur-free offset drop shadows on square panels.
> Saturated colour ONLY for safety/status state (green `#3F7D4E` cleared, blue
> `#2E6E96` monitor, orange `#C05A1E` restricted, red `#A81E22` locked), always
> paired with a glyph (✓ ◉ ▲ ✕) and an uppercase label — full spec in
> BRAND_DESIGN_BRIEF.md, which wins on any conflict. Data-dense and scannable —
> tables, status badges, metric tiles, review cards. Brass focus rings, 55px
> touch targets on floor surfaces. No gradients, no rounded cards, no cyan.
