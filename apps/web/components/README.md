# Revenue & Funding Center -- gates

Documentation on disk. Nothing imports this file, no page renders it, and it
does not live under `apps/web/public/`. It describes what the code does after
the change that added the fabricated-data declarations to
`RevenueFundingCenter.tsx`, not what anyone intended it to do.

Scope note: this file documents ONE capability that happens to live in
`apps/web/components/`. It is not an index of this directory. `components/` is
flat and holds around fifty unrelated components; a gate README for any of the
others belongs in this same file as its own section, next to the code, rather
than in a second README that would claim the directory twice.

Capability home:

- component: `apps/web/components/RevenueFundingCenter.tsx` (the whole
  capability -- there is no server module and no route of its own)
- host page: `apps/web/app/admin/page.tsx`, rendered only when its tab state is
  `'revenue'`, inside `RoleSessionGate allowedRoles={['admin',
  'platform_owner']}`
- the real registers it now points at:
  `apps/web/app/admin/memberships/page.tsx` (`/admin/memberships`,
  `pilot.memberships` via `/api/pilot/admin/memberships`) and
  `apps/web/app/admin/grants/page.tsx` (`/admin/grants`,
  `pilot.grant_obligations` via `/api/pilot/admin/grant-obligations`)

## What this capability is

A drawing of a revenue back office. Eleven tabs -- Overview, Memberships,
Donations, Sponsors, B2B Accounts, Wholesale Accounts, Grants, Scholarships,
Products / Equipment, Payment Settings, Treasurer Review -- rendered entirely
from literals declared at the top of the file.

The component contains **no `fetch`, no `useEffect`, and no `apiBase()`
call**. It reads nothing and writes nothing. Every account, row, status, date,
count and dollar figure it displays was typed into the file by a developer:
`revenueAccounts` (3), `revenueItems` (3), `paymentIntegrations` (6),
`membershipRows` (2), `sponsorRows` (1), `b2bRows` (1), `wholesaleRows` (1),
`grantRows` (1), `scholarshipRows` (1), `productRows` (1), `treasurerQueue` (8),
and the `summaryStrip` tile values (`Memberships 2`, `Sponsors 1`, `B2B
Accounts 1`, `Wholesale Accounts 1`, `Grants 1`, `Scholarships 1`).

One thing on it is live, and only in the weakest sense: the Donations tab's form
appends to a `useState` list (`donationRecords`, initially empty). Those entries
drive the Donations tile, the Action Center and the Treasurer Review queue for
as long as the tab stays open, and are lost on reload. Nothing is persisted.

Three of its tabs -- Memberships, Grants, Scholarships -- describe record types
the organisation now genuinely keeps, in live table-backed registers reachable
in one click. That asymmetry is the reason this file needed a gate at all: the
other prototype consoles invent things nothing real exists for yet, and this
one invents a shadow copy of the books.

## What it may do

- Render its own literals, as a labelled prototype, so the intended shape of a
  revenue back office stays legible.
- Accept a donation entry into browser-tab memory and move it between the four
  lifecycle statuses, for the length of that tab's life.
- Switch tabs, and jump to a tab from the capability-visibility panel or the
  Action Center.
- Link out to the two real registers (`/admin/memberships`, `/admin/grants`).

## What it may NOT do

- Present any figure on it as the organisation's own. Every figure is
  fabricated; that is now stated on screen rather than left to be inferred.
- Read or write a stored record. It has no request of any kind, which is the
  factual basis of the sentence "This tab makes no request and reads no record"
  that the notices display -- and that claim is pinned by a test, not by
  convention.
- Process a payment, issue a receipt, create an invoice, calculate tax, or
  store card data. (The pre-existing Compliance Boundary section states this and
  stays.)
- Claim to be the source of a membership, scholarship or grant record. Those
  are `/admin/memberships` and `/admin/grants`, which this screen now names.

## Gates

These are disclosure gates, not authorization gates. This component refuses no
request, because it makes none and receives none; the only thing it can get
wrong is what it leads a reader to believe. So "what it refuses with" below is
the mark rendered on screen -- Law 7, `.stamp` ink rather than an error toast --
and the reader is the admin, not a caller.

**1. Console-wide fabricated-data declaration, above the summary tiles**

- checks: nothing at runtime -- it is unconditional. It renders on every tab,
  before any figure, and cannot be dismissed.
- where: `components/RevenueFundingCenter.tsx:RevenueFundingCenter`, in the
  header `<article>`, immediately after the intro paragraph and before the
  `summaryStrip` grid.
- refuses with: the brass stamp `Planned — Not Yet Implemented`
  (`stamp stamp--brass stamp--flat`), then: "Every row on every tab of this
  screen is fabricated sample data, and the counts in the strip below are
  hardcoded numbers written to match those rows — they are not counts of your
  organisation's records. This screen performs no fetch: nothing on it reads or
  writes a stored record. The one exception is Donations, which counts only what
  you type into this browser tab; that is held in the tab and nowhere else, and
  is gone on reload."
- why it exists: the summary tiles are the figures most likely to leave this
  screen. "Memberships 2 / Grants 1 / Scholarships 1" reads as a count of the
  organisation's records, is legible without opening a single tab, and is four
  numbers long -- exactly the shape of something transcribed into a board
  minute. Naming them as literals is the only thing that stops a fabricated
  roster size becoming a reported one. This placement matches
  `src/components/coach/FloorOperationsDesk.tsx`, which declares in its
  `<header>` rather than over each panel.

**2. Per-tab fabricated-rows declaration on Memberships**

- checks: nothing at runtime -- unconditional, rendered as the first child of
  the tab's card, above the rows it disowns.
- where: `components/RevenueFundingCenter.tsx:FabricatedRowsNotice`, rendered
  from the `activeTab === 'memberships'` branch.
- refuses with: the same brass `Planned — Not Yet Implemented` stamp, then
  "Every membership row below is fabricated sample data. This tab makes no
  request and reads no record, so nothing on it is your organisation's — do not
  act on anything it shows, and do not copy a figure from it into a board
  packet, a grant report, or a filing. For a 501(c)(3), a fabricated financial
  figure that reaches a funder or a board becomes a false statement by the
  organisation." Then the real destination -- "Your organisation's real
  memberships are stored records and are administered at /admin/memberships: one
  row per athlete per program, with its status, start date and scholarship
  discount." -- and a link to it: **Open the real membership records** ->
  `/admin/memberships`.
- why it exists: `membershipRows` shows two invented members, one of them
  marked `Scholarship`, with `$0.00` amounts and "Start Date Placeholder"
  dates. `/admin/memberships` holds the real enrolments. An admin comparing
  "who is enrolled" against this tab is reading a two-row fiction of their own
  roster, and the amounts they would quote from it are not their fees.

**3. Per-tab fabricated-rows declaration on Grants**

- checks: nothing at runtime -- unconditional, first child of the tab's card.
- where: `RevenueFundingCenter.tsx:FabricatedRowsNotice`, rendered from the
  `activeTab === 'grants'` branch.
- refuses with: the stamp, the same fabricated/501(c)(3) sentence with "grant"
  in place of "membership", then "Your organisation's real grant work is stored
  at /admin/grants: the obligation ledger, one row per report, deliverable,
  renewal or filing, with its funder, its due date and whether it is overdue."
  and a link: **Open the real grant records** -> `/admin/grants`.
- why it exists: this is the sharpest edge in the file. `grantRows` renders
  "Grant Placeholder | Funder Placeholder | $0.00 | Drafting | Due Date
  Placeholder | Reporting Required Placeholder" -- a grant amount, a funder, a
  deadline and a reporting obligation, which is the exact set of facts a funder
  asks an organisation to certify. The real obligation ledger, with the real
  deadlines and the real overdue flags, is one click away at `/admin/grants`,
  and before this change nothing on the tab said so. A missed real deadline
  because the fabricated pipeline "looked handled" is the failure this gate
  exists to prevent.

**4. Per-tab fabricated-rows declaration on Scholarships**

- checks: nothing at runtime -- unconditional, first child of the tab's card.
- where: `RevenueFundingCenter.tsx:FabricatedRowsNotice`, rendered from the
  `activeTab === 'scholarships'` branch.
- refuses with: the stamp, the same fabricated/501(c)(3) sentence with
  "scholarship", then "Your organisation keeps no separate scholarship table: a
  real scholarship is a stored discount percentage on a real membership row, so
  it is awarded and read at /admin/memberships alongside the membership it
  belongs to." and a link: **Open the real scholarship records** ->
  `/admin/memberships`.
- why it exists: a scholarship row here names a family and a support level. The
  real model is deliberately different -- there is no scholarship table; a
  scholarship is `scholarship_percent` on a `pilot.memberships` row, 100% for a
  full scholarship, never a bypass of enrolment (stated in
  `app/admin/memberships/page.tsx`'s header comment). Pointing this tab at a
  scholarship register that does not exist would have replaced one fiction with
  another, so the notice says where scholarships actually live and why.

**5. The screen's own claim about itself is held to by a test**

- checks: that rendering the component and visiting all three tabs issues no
  request -- `global.fetch` is replaced with a mock and asserted uncalled.
- where: `components/revenueFundingCenterHonesty.test.tsx`, "the console makes
  no request, which is what the notices claim of themselves".
- refuses with: a failing test, not on-screen ink. It has no runtime effect.
- why it exists: the notices assert a fact about the code ("makes no request
  and reads no record"). The day someone wires a real read into one of these
  tabs, that sentence becomes the false statement on the screen and the rows
  stop being the problem. This test is what forces that change to be noticed
  and the copy to be rewritten with it.

## Deliberately not gated

- **The fabricated rows are still rendered.** They are declared, not deleted.
  That is the established pattern for these prototypes
  (`FloorOperationsDesk.tsx`, `CoachWorkspace.tsx`'s Development tab,
  `app/admin/page.tsx`'s integration-stub list): the drawing stays legible as a
  drawing. Nothing prevents an admin reading past the stamp and copying a
  figure anyway -- a disclosure is not an enforcement, and this capability has
  no mechanism to be an enforcement.
- **The real data is NOT wired in.** Out of scope by instruction and by size:
  making these three tabs read `pilot.memberships` and
  `pilot.grant_obligations` is a separate piece of work and a separate
  decision. Until it happens, the link is the whole of the remedy.
- **The other eight tabs get no per-tab notice.** Sponsors, B2B Accounts,
  Wholesale Accounts, Products / Equipment, Payment Settings, Treasurer Review
  and the Overview cards are equally fabricated and are covered only by the
  console-wide declaration (gate 1). They have no real register to link to, so
  there was nothing to add beyond what gate 1 already says; the three gated
  tabs are the ones where a truthful destination exists.
- **The Treasurer Review tab still lists eight invented review items.** Gate 1
  covers it. It is worth naming separately because it is the tab whose whole
  purpose is finance oversight, and a treasurer working that queue is working
  eight placeholders -- while their real membership exceptions and grant
  deadlines sit in the two registers this file links to from elsewhere.
- **The capability-visibility panel's own claims are untouched.** It still
  reads `Donation Operations: EXISTS -- Donation intake and lifecycle status
  controls are available`, which overstates a form that persists nothing, and
  it describes Grant/Scholarship/Membership tracking as `PARTIAL ... visible in
  planning mode`. Those are claims about capability state rather than
  fabricated figures, they predate this change, and correcting the state map is
  a different concern from disowning the rows. Recorded here rather than
  quietly fixed.
- **The Donations tab is not stamped as a prototype.** It was already honest in
  its own way before this change: it seeds no donor (see the comment above
  `initialDonationRecords`), and its empty state says the platform holds no
  financial records. The console-wide declaration now also states what its
  count means. It keeps no fabricated row, so it needed no per-tab notice.
- **No authorization gate is added here, and the inherited one is
  client-side.** The component is reached only through `app/admin/page.tsx`,
  which wraps itself in `RoleSessionGate allowedRoles={['admin',
  'platform_owner']}`. Nothing on this screen is a stored record, so there is
  nothing here for a server-side gate to protect; the two registers it links to
  gate themselves (`RoleSessionGate allowedRoles={['admin']}` plus admin
  enforcement in `/api/pilot/admin/memberships` and
  `/api/pilot/admin/grant-obligations`), and this file cannot widen that.
- **The links are not role-aware.** A `platform_owner` reading `/admin` can
  click through to `/admin/memberships` and be refused there by that page's own
  gate. Refusing at the door instead would mean this component deciding who may
  read memberships, which is not its decision to hold.

## Verified by

- `apps/web/components/revenueFundingCenterHonesty.test.tsx` -- the header
  stamp and console-wide declaration on first render, including the sentence
  that disowns the summary tiles; for each of the three tabs, the stamp, the
  "Every &lt;type&gt; row below is fabricated sample data" sentence, the
  do-not-copy sentence, the 501(c)(3) sentence, and that the real-surface link
  is a real anchor with the right `href` (`/admin/memberships`,
  `/admin/grants`, `/admin/memberships`); that no request is issued while
  visiting all three (gate 5); and that the sample rows are still present, so a
  future edit cannot satisfy the suite by deleting the rows and dropping the
  declaration.
- `apps/web/components/designSystemClasses.test.ts` -- that
  `stamp--brass`/`stamp--flat`/`btn--ghost`/`mat-leather` as used by the new
  notices are real design-system classes with rules behind them.
- `apps/web/app/admin/page.test.tsx` and
  `apps/web/app/admin/bulkCapabilities.test.tsx` -- the host page still
  mounts (both mock this component out, so they pin the host contract, not the
  notices).
- `apps/web/app/admin/memberships/page.test.tsx` and
  `apps/web/app/admin/grants/page.test.tsx` -- that the two destinations this
  file now sends an admin to are the real, table-backed surfaces they are
  described as.
