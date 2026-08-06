# Page → Shape Map

Which of three shapes each of the 61 routes takes, and which ground it sits on.
Build order runs top to bottom: within a group the first page is the expensive
one and the rest are the same work with different data.

## How pages are styled

There is no component library and no template module. Pages are styled the way
the app already styles them — Tailwind utilities reading CSS variables — and
[`design-system/ppbf.css`](../../../../design-system/ppbf.css) is the single
source of truth for what those variables mean. It is `@import`ed by
[`app/globals.css`](../../app/globals.css), which then aliases the app's legacy
token names onto design-system values.

Two consequences worth knowing before you touch a page:

- **New work should use ppbf tokens directly** — `var(--hide-800)`,
  `var(--t-md)`, `var(--s5)`, `var(--brass-500)`. The legacy aliases
  (`--canvas-tan`, `--safety-locked`, `--text-sm`) exist to carry pages written
  before the design system existed, not as a second vocabulary to write in.
- **`--safety-locked` means what it says.** It is the safety gate's red, and
  Law 2 reserves saturated colour for safety state. It is not a chrome accent —
  active tabs, KPI labels and panel borders take `--accent` (brass). The token
  was called `--red-primary` until it was renamed for exactly this reason.
- **ppbf.css ships real component classes** — `.badge`, `.tile`, `.frame`,
  `.mat-leather`, `.mat-paper`, `.gauge`, `.plaque`. Use them instead of
  rebuilding a panel out of utilities. Its `.stamp` is a *static ink mark*
  (Law 7) and is reachable; `globals.css`'s clickable button is `.stamp-button`,
  renamed out of the collision that used to shadow it.

Ground is a real decision, not a style: **ink** (`--hide-950`) for staff and
tactical surfaces, **canvas** (`--canvas-warm`, via `.on-canvas`) for family and
public ones (Law 6). Getting it wrong is the most visible possible error, so it
is listed per row.

---

## Table shape — 17 routes

A header, a filter row, and rows with per-row actions. Highest-leverage shape in
the app.

| Route | Ground | Notes |
|---|---|---|
| `admin/people` | ink | **Build first.** 1048 lines already — port it, don't rewrite |
| `admin` | ink | Hub: capability tiles + KPI row, so table + dashboard hybrid |
| `admin/pin` | ink | Expiring keys use `.badge.badge--restricted` |
| `admin/organizations` | ink | |
| `admin/volunteer-management` | ink | |
| `admin/compliance-center` | ink | |
| `admin/public-interest` | ink | |
| `admin/platform` | ink | |
| `admin/platform/overview` | ink | |
| `admin/shadow` | ink | 1850 lines, largest file in the app — split before porting |
| `admin/organizations/test` | ink | |
| `coach/review-queue` | ink | A queue is a table with one decision per row |
| `evidence` | ink | Redacted rows carry a static ink stamp (Law 7) |
| `audit` | ink | Append-only, no row actions; mono voice for timestamps (Law 4) |
| `schedule` | ink | Session rows use the chalk voice — erasable by definition (Law 4) |
| `source-control` | ink | |
| `source-control/publication-workflow` | ink | |

---

## Dashboard shape — 27 routes

KPI row over content sections. The nine named board routes are one page with a
role parameter; build `board/[member]` and the rest are routing.

| Route | Ground | Notes |
|---|---|---|
| `admin/attendance` | ink | Rolls up `pilot.scheduler_attendance` (capability #122); a never-marked athlete renders `Unavailable`, never a fabricated 0% |
| `board/[member]` | ink | **Build first.** The nine named board routes are this page |
| `board` | ink | |
| `board/president` | ink | |
| `board/chair` | ink | |
| `board/vice-chair` | ink | |
| `board/secretary` | ink | |
| `board/treasurer` | ink | |
| `board/safety-director` | ink | |
| `board/at-large` | ink | |
| `board/community-director` | ink | |
| `board/compliance-monitoring` | ink | k-anonymity withholding is a stamp, not empty state |
| `athlete/dashboard` | ink | Kiosk: every target ≥ `--tap` (55px), body ≥ `--t-md` (Law 5) |
| `athlete/dashboard/sparring` | ink | |
| `athlete/progression-intelligence` | ink | `.gauge` — arc only where a real threshold exists (Law 2) |
| `coach/decision-loop` | ink | 686 lines; core feature |
| `coach/progression-intelligence` | ink | |
| `coach/sports-medicine` | ink | |
| `coach/environment/intake-router` | ink | |
| `coach/environment/passbook-check` | ink | |
| `parent/dashboard` | **canvas** | |
| `parent/progression-visibility` | **canvas** | |
| `guardian` | **canvas** | |
| `dashboard` | ink | Routing hub |
| `operations` | ink | |
| `operations/wrestling-league` | ink | |
| `operations/external-competition` | ink | |

---

## Form shape — 8 routes

| Route | Ground | Notes |
|---|---|---|
| `login` | ink | Already styled brass/paper and deliberately reverted twice — leave alone |
| `athlete/sign-in` | ink | Six PIN wells at `--tap` each (Law 5) |
| `change-pin` | ink | |
| `activate` | **canvas** | **Build first** of the canvas forms — proves `.on-canvas` |
| `public` | **canvas** | 614 lines; landing + enrollment |
| `help` | **canvas** | Prose with a form at the end |
| `launch` | ink | |
| `research/chat` | ink | A conversation, not a form — needs its own message layout |

---

## Custom — 10 routes

No shared shape. Schedule these last, individually.

| Route | Ground | Why |
|---|---|---|
| `shadow` | ink | 1448 lines; governance surface, refusal states throughout |
| `shadow/scout` | ink | |
| `knowledge-graph` | ink | Node/edge graph |
| `simulator` | ink | Before/after scenario cards |
| `research` | ink | Hub of evidence cards |
| `coach/video-analysis` | ink | Player plus frame annotation |
| `coach/video-publications` | ink | |
| `athlete/video-analysis` | ink | Kiosk-sized player controls |
| `retro-lab` | ink | Internal theme scratchpad, not user-facing |
| `page.tsx` (root) | — | Redirect, no UI |

---

## Build order

1. `admin/people` — proves the table shape, unlocks 16 routes
2. `board/[member]` — proves the dashboard shape, unlocks 25 routes
3. `activate` — proves a form on canvas ground, unlocks 7 routes
4. Those three groups are independent and can then run in parallel
5. Custom routes last, one at a time

17 + 27 + 8 + 10 = 62.
