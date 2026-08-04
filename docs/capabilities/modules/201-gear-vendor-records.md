# Module 201 — Gear Vendor Records

| Field | Value |
|-------|-------|
| Status | **DONE** |
| Active | false |
| ManualVerification | PENDING_SIGN_OFF |
| Parent original-25 | (none — equipment purchasing was not in the original 25) |

## A note on the number, before anything else

`expanded-200-backlog.csv` held exactly 200 rows and now holds 201. The gear
catalogue shipped in #190 with no backlog row and no module stub at all, so
there was no existing row this slice could honestly be recorded against — every
nearby candidate (146 Grant / Nonprofit Impact, 147 Board Reporting, 168 Admin
Dashboard) is about something else, and marking one of them DONE for this work
would be exactly the "mapped, not built" ambiguity `README.md` warns about.

**`expanded-200-index.json` still says `moduleCount: 200` and does not list
this module.** That file is generated from `PPBF_CAPABILITIES.json` by the
PowerShell wave process, not maintained by hand, so it has deliberately not
been edited here. The discrepancy is real and is the owner's to resolve —
either by regenerating the index from an updated source, or by deciding that
post-wave capabilities live only in the CSV. Nothing in `apps/web` reads either
file (README, "Nothing in the running application reads any of this"), so no
screen is affected either way.

## Intent

Record who the gym buys equipment from, so a Treasurer can place an order and
reconcile an invoice without keeping the account details in a personal
notebook.

## The boundary this module exists to hold

"Everlast" is two different facts with opposite audiences.

| Fact | Where it lives | Audience |
|---|---|---|
| The brand printed on the product | `pilot.gear_products.brand` | **Public.** The shop shows it. A parent buying gloves wants to know they are Everlast, and the word is stamped on the glove either way. |
| The gym's Everlast **account** — account number, discount tier, net terms, rep contact | `pilot.gear_vendors`, referenced by `pilot.gear_products.vendor_id` | **Organization admin only.** The gym's negotiated commercial position, the same confidence as `wholesale_cost_cents`. |

Conflating them costs one thing or the other: publish the account and the gym's
terms leak; suppress the brand and the store gets worse for no gain.

`PUBLIC_FIELDS` in `gearCatalog.ts` gained `brand` and nothing else. The two
column lists stay explicit — two lists, not one list minus a field — because a
derived list is one careless edit from leaking and the edit that does it looks
harmless in review.

## No supplier password, by construction

There is no `portal_password` column, no code path that accepts one, and the
migration runner's readiness query **fails** if any credential-shaped column
ever appears on `pilot.gear_vendors`. A request offering one is refused with an
explanation rather than having the field silently dropped.

A supplier login held here would be a credential nobody rotates, readable by
anyone with an organization admin session, in a database built to hold youth
records — so a breach of a youth sports platform would also hand over the gym's
purchasing account. Account number, portal URL and rep contact are what a
Treasurer actually needs on a screen; the person signs in with their own
credentials, held wherever the gym already holds them.

## Vertical slice

- **Schema** — `infra/azure/pilot_slice_postgres_gear_vendors_migration.sql`:
  `pilot.gear_vendors` keyed `(organization_id, vendor_id)`, plus
  `gear_products.brand` (public) and `gear_products.vendor_id` (internal) with
  a **composite** foreign key, so a product can only reference a supplier
  account belonging to the same gym. Additive and idempotent; catalog-guarded
  `DO` blocks for both constraints, because PostgreSQL has no
  `ADD CONSTRAINT IF NOT EXISTS`. Pure ASCII.
- **Runner** — `apps/web/scripts/pilot-apply-gear-vendors-migration.mjs`,
  registered as `pilot:apply-gear-vendors` and named in all three lists in
  `.github/workflows/apply-migrations.yml` (dropdown, the `all` loop, and the
  `case " ... schema " in` list-check). Its readiness query asserts the
  composite key, column types, both constraints, both indexes, and the absence
  of a credential column — not merely that a table exists.
- **Module** — `apps/web/src/server/pilot/gearVendors.ts`. One field list, no
  public counterpart, and no function that accepts a credential.
- **API** — `GET`/`POST /api/pilot/admin/gear-vendors`, organization admin
  only, organization taken from the session and never from the body. The gear
  route gained `brand` and `vendor_id`, with a named refusal in front of the
  foreign key so a cross-gym vendor is a 400 that says so rather than a masked
  500.
- **UI** — `/admin/gear/vendors` (Treasurer: suppliers, accounts, terms, reps,
  portal links), linked from `/admin/gear`, which gained a Brand field and a
  supplier picker. `/store/[organizationId]` shows the brand.
- **Audit** — `gear_vendor` / `gear_vendor_saved` records presence flags only.
  The account number, tier, terms and rep details are never written into an
  audit detail; audit events are read on screens with wider audiences than this
  route has.

## Role and isolation checks

Via the existing helpers, no new ones. `requirePrincipal` +
`requireRole(['organization_admin'])` + `isOrganizationAdminRole`. Refused for
`platform_owner`, `coach`, `board`, `parent` and `athlete`, on both verbs, with
tests for each. Every query names `organization_id`, and the composite key and
foreign key make cross-gym reference impossible at the database rather than
merely refused at the route.

## Automated tests

| File | What it proves |
|---|---|
| `src/server/pilot/gearVendors.pg.test.ts` (14) | Real Postgres. A real account number is written and asserted absent from the public store payload as a raw string, while the brand is asserted present. Migration idempotency (applied twice through the runner's own readiness assertions). No credential column. Cross-org isolation, including the foreign key refusing a product that names another gym's account — and accepting the same id from the gym that owns it. |
| `app/api/pilot/admin/gear-vendors/route.test.ts` (30) | Admin success; five roles refused on both verbs; 401 with no session; organization from the session and never the body; every validation refusal is a 400 with a reason, not a masked 500; a credential-bearing body refused and never echoed back; the audit detail carries no account data. |
| `app/api/pilot/admin/gear/route.test.ts` (9) | Brand and supplier saved; a vendor outside the gym refused by name; `platform_owner` and `coach` refused. |
| `src/server/pilot/gearVendors.test.ts` (37) | Validation, the credential refusal, and the field lists asserted against source — `PUBLIC_FIELDS` contains `brand` and nothing vendor-shaped, the two lists are not derived from each other, and this module has no public list. |
| `app/api/public/store/route.test.ts` | The public SQL selects `brand` and nothing about a vendor, and has no join. |

Falsified rather than assumed: adding `vendor_id` to `PUBLIC_FIELDS` fails four
tests across the unit and Postgres suites, and adding a `portal_password`
column to the migration fails the readiness check with
`GEAR_VENDORS_NOT_READY: no_credential_column`. Both were run.

## Not done here

- **The migration has not been applied to any environment.** The deploy
  coordinator (the VS Code session) owns dispatches. Staging first, then
  production, `migration: gear-vendors` or `all`.
- No SHADOW E2E gate step. The gate provisions no gym-commerce fixtures and
  this slice adds no athlete-facing behavior; the real-Postgres suite is the
  end-to-end proof available without one.
- `governance.active` stays false.

## Audit log

| Date | Actor | Note |
|------|-------|------|
| 2026-08-03 | remote build session | DONE. Slice: `pilot.gear_vendors` + `gear_products.brand` / `.vendor_id`. maps to: `infra/azure/pilot_slice_postgres_gear_vendors_migration.sql`, `apps/web/scripts/pilot-apply-gear-vendors-migration.mjs`, `apps/web/src/server/pilot/gearVendors.ts`, `apps/web/src/server/pilot/gearCatalog.ts`, `app/api/pilot/admin/gear-vendors/route.ts`, `app/admin/gear/vendors/page.tsx`. Migration NOT applied. Row 201 added to the CSV; `expanded-200-index.json` left at `moduleCount: 200` for the owner to resolve. |
