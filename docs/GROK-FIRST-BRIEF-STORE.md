# Grok implementation brief #1 — the public store

**Against `main` @ `27711faa`. Mode B (implementation) per `docs/GROK-VISUAL-LANE.md`.**
**One visual concern. Two files. No behaviour change.**

Read `docs/GROK-APP-BUILD-MAP.md` §4.2 (the cross-cutting rules) before this
brief. R1 (the unlayered cascade) and R2 (the font-token override) both apply
here and are the two things most likely to make a correct-looking change do
nothing.

---

## Why this one first

The brief asked for high visual leverage with bounded functional risk. This is
the only surface in the application that scores well on both, and the reasoning
is measured rather than asserted:

**Leverage.** `/store` and `/store/[organizationId]` are two of the **three**
surfaces a signed-out visitor or a prospective family ever sees (the others are
`/` and `/public`, both already converted). Every other route in the building
requires a session. Per-viewer, this is the highest-visibility unconverted
surface that exists.

**Bounded risk.** OBSERVED, from the pages' own headers:

> Public: no session, no gate, no cookie. It shows organization names and
> nothing else… **Nothing about a child is reachable from here, and nothing
> ever should be** — this and the store page are the only surfaces on the
> platform that answer without asking who is calling.

No athlete record, no guardian link, no safeguarding state, no medical or hold
semantics, no SHADOW, no role scoping beyond "public", no organization-scoped
read to get wrong. The wholesale cost is *absent from the query*, not hidden in
the payload. Checkout is hosted elsewhere; the page never collects a card, an
address, or a name.

**It is already named as outstanding visual work.** `/store` is one of two
remaining `NEEDS A SLICE` entries in `buildingMapRooms.test.ts`'s `UNPAINTED`
map, and it carries the highest legitimate legacy-alias debt in the app
(16 call sites across the two files; the three higher scorers are all
`PENDING_TRIAGE` admin routes with unconfirmed roles).

**The pattern is proven.** `/notices` and `/admin/consent` were the two previous
`NEEDS A SLICE` entries and both were paid off the same way: convert the
hard-coded legacy tokens onto the sheet's own materials, and the room comes free
on the last line. Six entries have left that map. This is the seventh.

*If Jason would rather the very first PR carry literally zero data risk:*
`/simulator` is fully static — no fetch, no state, renders identically on an
empty database — and is pure typography and empty-state craft. It is a smaller
prize (one low-frequency route) but it cannot break anything.

---

## The fourteen

### 1. Exact route, component and files

| | |
|---|---|
| Routes | `/store` and `/store/[organizationId]` |
| Files | `apps/web/app/store/page.tsx` (99 lines)<br>`apps/web/app/store/[organizationId]/page.tsx` (170 lines) |
| Components | **None.** Both are self-contained client components with no imported UI. |
| Backing routes | `GET /api/pilot/public/store` · `GET /api/pilot/public/store/[organizationId]` |
| Room | **None today.** `/store` is in `UNPAINTED`; the detail page paints no room either. |

Two files, no shared component, nothing else imports them. The blast radius is
exactly these two routes.

### 2. Role and user

**Nobody signed in.** A parent, a prospective family, or a member of the public
who followed a link. `buildingMap.ts` files `/store` as `roles: OPEN`, room
`office`. The detail page is a dynamic segment and correctly has no door — it is
reached from the index.

Both pages fetch with `credentials: 'omit'`. That is deliberate and must stay.

### 3. Actual purpose

`/store` — the index of gyms that have a store. It exists so the platform is
multi-store from the first commit rather than one gym's shop behind a
general-sounding URL: *"Other gyms on the platform have their own suppliers,
their own prices and their own catalogue."*

`/store/[organizationId]` — one gym's public catalogue. Retail prices, honest
availability, and an outbound link to a hosted checkout. Buying gear here
supports the gym directly.

### 4. Current real content and states

**`/store`** renders, from `StoreSummary[]`: `organization_name` and
`listed_product_count` per row, linking to the detail page. Eyebrow "Shop",
`h1` "Equipment", lede *"Buying gear here supports the gym directly."*

**`/store/[organizationId]`** renders, from `StoreProduct[]`: `name`, `brand`,
`description`, `category`, `retail_price_cents` (formatted by integer
arithmetic — `formatPrice` never touches a float), `availability`, and
`checkout_url`.

`AVAILABILITY_LABEL` is a fixed three-way map and its wording is the honest
state, not a placeholder:

```ts
in_stock:    'In stock'
order_only:  'To order'
unavailable: 'Not available just now'
```

**`brand` is public on purpose and is not the gym's supplier account.** The
page's own comment: *"a parent buying gloves wants to know they are Everlast.
This is NOT the gym's Everlast account — that is a separate, confidential record
the route behind this page does not select and this page has no field for."*

### 5. Actions that must remain

There is exactly one interaction per page and both are navigation:

1. `/store` — a `<Link>` per gym to `/store/{encodeURIComponent(organization_id)}`.
   The `encodeURIComponent` stays.
2. `/store/[organizationId]` — an outbound link per product to `checkout_url`.

**A product with no checkout link is shown and marked as not purchasable
online.** That is the honest state before a processor account exists, and the
page's header says so explicitly — *"rather than a dead button."* **Do not turn
that state into a disabled button, and do not hide the product.**

No forms. No inputs. Nothing to submit. If a control appears in your design that
is not one of these two links, it has no backing behaviour and per the lane
contract it is omitted and reported.

### 6. Boundaries that must remain functionally unchanged

| Boundary | Why |
|---|---|
| `credentials: 'omit'` on both fetches | These are the two surfaces that answer without asking who is calling. Sending a cookie would make them session-aware. |
| No session, no gate, no cookie | Adding any gate changes who can see a public shop. |
| `formatPrice` integer arithmetic | `Math.trunc(cents / 100)` + padded remainder. **No float, ever.** |
| No wholesale cost, no margin, no supplier account | Absent from the query, not filtered from the payload. There is no field to render. |
| `checkout_url` is outbound only | The page never collects a card, an address or a name. This keeps PCI scope where `docs/PAYMENT_SERVICE_SLOT.md` requires it. |
| `AVAILABILITY_LABEL`'s three strings | They state a real state. Rewording `Not available just now` into `Sold out` is a claim change. |
| The loaded-empty vs failed-to-load distinction | See §9. |

**Nothing about a child is reachable from these pages and nothing ever should
be.** No athlete name, no photo, no roster count, no "our athletes wear this".

### 7. Design-system constraints that apply

**Ground — T7, and this is the one real design decision in the brief.**
`buildingMapRooms.test.ts` records `/store` as:

> NEEDS A SLICE — legacy canvas-tan with `--black` type, and open to families
> and signed-out visitors, so **the ground is an audience question (T7) before
> it is a room one**

The precedent is already set by the two comparable surfaces. `/help` and
`/public` are both in the same map as **FAMILY GROUND**, on `.on-canvas`, for
the same reason: *"T7 is about who is reading, and a parent reads this one."*
`/public` is described as *"the only surface a signed-out visitor sees"* —
`/store` is the second.

**Take `.on-canvas`.** That is the existing rule applied to an audience that
already has two precedents, not a new decision. If Jason wants the office wall
here instead, that is a `ROOM-PURPOSE-DNA.md` change and it needs him — say so
rather than picking.

**Materials.** `.on-canvas` + `.mat-paper` for the cards. Both pages are
currently hand-rolled `border-2 border-[var(--black)] bg-[var(--canvas-tan-light)]`,
which is the pre-design-system idiom.

**Voices.** `.t-eyebrow` / `.t-command` / `.t-body` / `.t-label` / `.t-data`
(prices are a record — `--font-data`). Note **R2**: `--font-body` resolves to
Roboto Condensed in the app, not Inter.

**Tokens.** Replace every `var(--canvas-tan)`, `var(--canvas-tan-light)`,
`var(--black)`, `var(--gray-dark)` and every raw `text-[11px]` / `text-3xl` /
`text-sm` with ppbf tokens. That is the whole conversion.

**Law 2.** There is no safety state on a shop. **No saturated colour anywhere
on these two pages** — availability is a stock fact, not a safety fact.
`--locked` red on a public page is exactly what `public-homepage.spec.ts`
already fails the build for on `/`.

**Law 3.** If availability gains colour it also gains a glyph and an uppercase
label. `.badge--filed` is the administrative rung and is the correct one here —
`.badge--cleared` / `--restricted` / `--locked` are the safety ladder and are
off-limits on a shop.

**Law 8.** Space on `--s1..--s8`, radius on `--r-*`, type on the `--t-*` ladder.
The current `px-4 py-10 gap-3 mt-6` are raw Tailwind steps.

### 8. Responsive states required

Both pages are currently a single centred column (`max-w-3xl` / `max-w-4xl`)
with a one-column list at every width.

| Width | Requirement |
|---|---|
| 360px (phone, portrait) | Single column. Price and availability must not wrap apart from their product. |
| 768px (tablet) | The product list may go two-up. The index list stays one-up — the rows are short. |
| 1024px+ | Two or three-up product grid. The page must not become a wide thin ribbon. |
| Kiosk tablet, portrait | Not a kiosk surface — see §7 and the note below. |

**On tap targets, precisely, because the two floors are easy to confuse:**
`--tap` (55px) is the **gym-floor** number and is scoped to
`[data-surface="kiosk"]`, which marks the `/athlete` subtree and two coach
pages. **`/store` is not a kiosk surface.** The floor that applies here is the
global 44px, and the current `min-h-[44px]` on the index rows is **already
correct**. Do not raise it to `--tap` and do not lower it.

Watch R1 here: `.btn` carries `min-height: 44px` from the unlayered sheet and
will defeat a `min-h-[…]` utility on the same element.

### 9. Loading, empty, error and permission states

All four already exist in source and **all four must survive**. This is the
part of the brief most likely to be lost in a restyle, because three of them are
currently plain paragraphs that look like afterthoughts.

| State | Current behaviour | Copy |
|---|---|---|
| **Loading** | `isLoaded === false`; **nothing is rendered** — no spinner, no skeleton | — |
| **Error** | `errorMessage` set; bordered box | `'The shop could not be loaded.'` (or the server's message) |
| **Loaded and empty** | `isLoaded && !errorMessage && stores.length === 0` | `'Nothing is on sale just now. Check back.'` |
| **Loaded with rows** | the list | — |
| **Permission** | none — the pages are public | n/a |

**The empty/error distinction is load-bearing and the page says why:**

> A loaded-and-empty shop and a shop that failed to load are different facts.
> Saying "no gyms are selling anything" because a request failed would be a shop
> that looks closed when it is not.

**You may improve the loading state** — it currently renders nothing at all,
which reads as an empty shop for the duration of the request. `.skeleton` +
`.working` text is the sheet's answer, and Law 3 requires the pair (a bare
spinner is colour-and-motion-only and is banned). This is the one place the
brief actively wants new markup.

**You may not** collapse error into empty, or render either as the other.

### 10. Visual acceptance criteria

1. Both pages sit on `.on-canvas`. Neither declares a `.room--*` class.
   `buildingMapRooms.test.ts` still passes — `/store` is either updated in
   `UNPAINTED` with `FAMILY GROUND` as its reason, matching `/help` and
   `/public`, or given a door decision. **Do not simply delete its entry.**
2. Zero occurrences of `--canvas-tan`, `--canvas-tan-light`, `--black`, or
   `--gray-dark` remain in either file:
   `grep -c "var(--\(canvas-tan\|black\|gray-dark\)" apps/web/app/store/**/*.tsx` → `0`
3. Zero raw Tailwind type steps (`text-3xl`, `text-sm`, `text-[11px]`). All type
   on `.t-*` or `text-[length:var(--t-*)]`.
4. No saturated colour anywhere. No `--locked`, `--restricted`, `--cleared`,
   `--monitor` on either page.
5. All four states render distinctly, and the loading state is visible.
6. AA contrast on every text node over a nameable flat background.
7. Every link ≥ 44×44px in **both** dimensions.
8. No horizontal scroll at 360px.
9. Prices render identically to today — `formatPrice` is untouched.
10. A product with no `checkout_url` still appears, still marked not purchasable
    online, still not a button.

### 11. Tests you may add or update

**Add `apps/web/e2e/store.spec.ts`**, modelled directly on
`apps/web/e2e/public-homepage.spec.ts`. That file is the repository's answer to
"how do you test appearance without a pixel baseline" and it is the pattern to
copy, not to improve on:

- both routes return 2xx to an unauthenticated visitor;
- **no element paints `rgb(168, 30, 34)`** (`--locked`) — Law 2, the same
  assertion `/` already carries, and on a shop it should be trivially true;
- every text node on a nameable flat background clears AA (4.5:1, or 3:1 for
  large), using `public-homepage.spec.ts`'s `backdrop()` helper **verbatim** —
  it refuses rather than guesses over gradients and translucency, and getting
  that wrong reports 1.59:1 for a button that measures 9.6:1;
- every interactive element ≥ 44×44 in both dimensions;
- no `input[type="password"]` and no session cookie set.

**Add a unit test** for the three list states (loading / empty / error) if one
does not exist — assert they are distinguishable, matching loosely on the
distinction rather than pinning exact wording, the way
`app/athlete/dashboard/sparring/page.test.tsx` does.

You may update any assertion that is genuinely about the old markup.

### 12. Tests and guards you must not weaken

| Guard | What it does |
|---|---|
| `components/designSystemClasses.test.ts` | Every `mat-`, `badge--`, `btn--`, `alert--`, `room--`, `pap--`, `stamp--` class you name **must** be defined in `ppbf.css` or `globals.css`. Comments are stripped, so prose naming a class is not evidence. |
| `components/buildingMapRooms.test.ts` | The map and the page must agree about the room. See criterion 1. |
| `components/buildingMapCoverage.test.ts` | `/store` keeps its door; `/store/[organizationId]` stays doorless (dynamic segments are per-record surfaces reached from a list). |
| `src/design/lightGroundVoices.test.ts` | **Directly in your path.** It reads which voices the sheet restates for `.on-canvas` and requires `.mat-paper` to answer the same question. If you add a light-ground override for one, add it for both. |
| `src/design/typeLadder.test.ts` | Law 8. The √φ ladder from 15px. |
| `src/design/cornerColor.test.ts` | Law 2. |
| `app/api/public/store/route.test.ts` | The API contract. **Do not touch the route.** |

**Do not add a screenshot baseline.** `playwright.config.ts` has no
`toHaveScreenshot` tolerance, deliberately, and re-adding a baseline means
pinning the browser revision in the container first — a container change, not a
visual one.

### 13. Screenshot / artifact requirements

There is no committed visual evidence of either page and **none can be produced
from source.** Chromium is available in the dev container, so you can render
locally against `npm run dev`, but there is no baseline to compare against and
one must not be added (§12).

**What to attach to the PR** — these are the artifacts that make the change
reviewable without a baseline:

1. Before/after screenshots of both routes at **360px**, **768px** and
   **1280px** — six pairs. Attached to the PR, **not committed to the repo.**
2. The four states of `/store` captured: loading, error, loaded-empty, loaded
   with rows. Stub the fetch to produce them.
3. The output of the new `store.spec.ts` computed-style audit, showing the
   contrast and target-size results as numbers.

**Jason reviews the result on the deployed URL.** Per the lane contract, that
is still the only real visual verification that exists — the screenshots are for
the reviewer, not a substitute for his pass.

### 14. Branch and PR scope

```
branch:  grok/store-public-ground
base:    current main
files:   apps/web/app/store/page.tsx
         apps/web/app/store/[organizationId]/page.tsx
         apps/web/e2e/store.spec.ts                    (new)
         apps/web/components/buildingMapRooms.test.ts  (the UNPAINTED entry only)
```

**One visual concern: put the two public store surfaces on the design system's
family ground and its paper materials, and give them a visible loading state.**

Not in this PR: the room decision for any other route; the `.btn` / `--tap`
cascade repair (R1 — that is its own PR and it waits on #534); any change to
`/api/pilot/public/store`; any new control; any copy change to the three
availability labels or the two state sentences.

**No collision.** PR #556 touches `/admin/{people,organizations,pin}` only.
PR #534 touches a script and a doc. Neither goes near `app/store/`.

---

## What to report back rather than build

Per the lane contract — *"If an approved concept contains an element with no
real behaviour behind it, omit it and report it rather than building a shell."*

- Anything you want that needs a field the API does not return. The store routes
  select exactly the columns listed in §4; a product image, a rating, a stock
  count or a gym logo would each be a new query, which is a functional task.
- A room for `/store` other than none/`.on-canvas` — that is `ROOM-PURPOSE-DNA.md`.
- Any change to the three availability labels or the two state sentences — those
  are claims, and one of them is the difference between "closed" and "we could
  not reach the shop".
