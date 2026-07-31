# Payment Service — Reserved Slot (CAP-012 / capability #19)

**Status: RESERVED, NOT BUILT.** This document defines the shape of the payment
capability so a later integration drops into a named slot instead of being
designed under deadline. Nothing in this document is implemented. No payment
code, routes, tables, or processor accounts exist in this repository, and none
should be inferred from this file. The capability stays `BLOCKED` in the admin
console until the owner's compliance sign-off — that gate is the point.

Owner decision recorded 2026-07-31: the slot must cover four revenue lanes, and
build is deliberately deferred.

## The four lanes

| Lane | What it is | Payment shape |
|---|---|---|
| **Donations** | One-time public giving | Hosted checkout, no account required, receipt for tax purposes |
| **Recurring giving** | Monthly/annual sustainers | Processor-managed subscriptions; cancel/self-serve portal |
| **Class fees** | Program registration / session fees, per athlete | Hosted checkout tied to an `organization_id` + athlete/guardian account; scholarships must be representable as 100% discounts, not bypasses |
| **B2B wholesale** | Invoice-based transactions against the owner's existing wholesale accounts | Processor invoicing with net terms; no card-present flow |

## Posture decisions (made now, so the build inherits them)

1. **Hosted checkout only.** Card data never touches PPBF servers or this
   repository. That holds PCI scope at SAQ-A and is non-negotiable for a youth
   organization running on a volunteer-scale ops team.
2. **One processor for all four lanes** unless a real constraint forces a
   split. Stripe covers all four (Checkout for one-time, Billing for
   recurring, Payment Links/Checkout for class fees, Invoicing for B2B net
   terms) and has 501(c)(3) nonprofit pricing; nonprofit-native options
   (e.g. donor-covered-fee platforms) cover the giving lanes but not B2B
   invoicing. Verify current pricing at decision time — do not trust this
   file's age.
3. **Webhook-driven ledger, read-only mirror.** The processor is the source of
   truth for money; the platform keeps an org-scoped mirror table for
   reporting (grant reporting is capability #17 and will want it). The
   platform never computes balances it then acts on.
4. **Org-scoped like everything else.** Every payment row carries
   `organization_id` and joins the same multi-org model as the rest of the
   pilot schema. Platform-owner visibility follows the standing de-identified
   aggregate rules, not raw donor PII.
5. **Youth-data separation.** Donor and payer PII lives with the processor.
   The mirror stores the minimum for reconciliation and receipts — never card
   data, never a minor as the payer of record.
6. **Per-org connected accounts on a single platform processor** (owner
   decision 2026-07-31). Each organization connects its OWN account
   (Stripe-Connect-style) and is its own merchant of record — its class fees
   and donations settle directly to it, its donation receipts carry its
   name, and its books never entangle with PPBF's. What organizations do NOT
   get is a choice of processor: one org on Stripe and another on Square
   would mean one integration, webhook surface, and refund-semantics
   codepath per processor, forever, for a volunteer-scale ops team.
   Routing other orgs' revenue through PPBF's account is ruled out for the
   same reasons in reverse: it would make PPBF merchant of record for money
   that is not PPBF's (money-transmission exposure) and would make a gift to
   another gym legally look like a gift to PPBF. The connected-account model
   also leaves an optional platform-fee mechanism available later without
   rearchitecting — a separate decision, deliberately not made here.

## What is reserved (names only — nothing exists)

Reserving names now prevents the later build from colliding with five
months of other people's naming choices:

- Capability: `CAP-012` (admin console), capability `#19` (PPBF_CAPABILITIES.json)
- Env vars: `PPBF_PAYMENTS_ENABLED`, `PPBF_PAYMENT_PROVIDER`,
  `PAYMENT_PROVIDER_SECRET_KEY` (Container App secret: `payment-provider-secret-key`),
  `PAYMENT_PROVIDER_WEBHOOK_SECRET` (secret: `payment-provider-webhook-secret`)
- Routes: `app/api/pilot/payments/**` (checkout-session, webhook, portal)
- Tables: `pilot.payment_transactions`, `pilot.payment_subscriptions`
  (migration named `pilot_slice_postgres_payments_migration.sql`, added to the
  apply-migrations `all` list per its list-check rule)
- Audit events: `payment_*` vocabulary in the standing audit-event registry

## What flipping the slot requires, in order

1. Owner picks the processor and opens the account (nonprofit verification
   for the giving lanes; wholesale/B2B account linkage).
2. Compliance sign-off recorded — the same explicit human gate the capability
   description names today.
3. The thin backend lane: checkout-session route, webhook route with
   signature verification, mirror tables + migration, receipts.
4. Staging-first rollout behind `PPBF_PAYMENTS_ENABLED`, exactly like the
   worker and embedding flags: env present and OFF in production until
   staging proves a full donation → webhook → mirror → receipt round trip.
5. CAP-012 flips from `BLOCKED` only after step 4's evidence exists.
