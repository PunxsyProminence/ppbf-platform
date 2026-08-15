# Payment Service — Reserved Slot (CAP-012 / capability #19)

**Status: RESERVED — LEDGER TABLES BUILT, EVERYTHING ELSE NOT.** This document
defines the shape of the payment capability so a later integration drops into
a named slot instead of being designed under deadline. As of 2026-08-15 (owner
decision: "ledger tables land first"), the three reserved tables exist —
`pilot_slice_postgres_payments_migration.sql` creates `pilot.payment_accounts`,
`pilot.payment_transactions`, and `pilot.payment_subscriptions`, empty and with
the lane/one-account-per-lane/no-card-data posture below enforced as
constraints. NO payment code, routes, webhooks, or processor accounts exist in
this repository, and none should be inferred from this file. The capability
stays `BLOCKED` in the admin console until the owner's compliance sign-off —
that gate is the point.

Owner decisions recorded 2026-07-31: the slot must cover four revenue lanes;
those lanes settle into **two separate Stripe accounts**, giving and program;
and build is deliberately deferred.

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
2. **One processor — Stripe — but TWO separate Stripe accounts** (owner
   decision 2026-07-31, superseding the original single-account posture).
   Stripe covers all four lanes (Checkout for one-time, Billing for recurring,
   Payment Links/Checkout for class fees, Invoicing for B2B net terms) and has
   501(c)(3) nonprofit pricing. The split is by lane, not by processor:

   | Account | Lanes | Why it is separate |
   |---|---|---|
   | **Giving** | Donations, recurring giving | Charitable gifts. Tax-deductible, receipted with the no-goods-or-services language the IRS requires, and eligible for Stripe's nonprofit rate. |
   | **Program** | Class fees, B2B wholesale | Earned revenue in exchange for goods and services. NOT tax-deductible, different receipt language, ordinary commercial pricing. |

   The reason is accounting, not technology. A gift and a class fee are
   different things to the IRS, to an auditor, and on a Form 990 — one is
   contribution revenue, the other is program-service revenue. Keeping them in
   one account means separating them by metadata forever, and every year-end
   acknowledgment letter, restricted-fund question, and reconciliation
   inherits that. Two accounts make the boundary structural: a payout lands in
   one book or the other, and no query can silently mix them.

   Verify current pricing and nonprofit-rate eligibility at decision time — do
   not trust this file's age.
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

## Connecting an account is a button, not a copy-paste

Owner requirement 2026-07-31: *"build it in such a way that I just log in or
connect it."* Stripe Connect OAuth is that mechanism, and it is the same
mechanism the per-org connected-account posture (#6) already requires — so
this is one design, not two.

**The flow.** An admin opens the payments settings, presses *Connect Stripe
account*, is sent to Stripe, logs in or completes onboarding there, approves,
and lands back on the platform. The platform stores the returned **account
ID**. It never sees, stores, or asks for a secret key. PPBF presses that
button twice — once for Giving, once for Program. Another gym's admin presses
it once for themselves, with no involvement from PPBF and no configuration
change on this side.

**Use Standard connected accounts.** The gym keeps its own Stripe dashboard,
owns its customer relationship, and can log in and see its own money — which
is what "just log in" has to mean for it to be worth anything. Express is
faster to onboard but puts Stripe between the gym and its own account; that
trade is wrong for an organization that has to answer to its own board about
its own funds.

**What the button cannot skip.** Stripe still has to collect an EIN, bank
details, and a responsible-party identity, and 501(c)(3) nonprofit-rate
eligibility still needs Stripe's review. Connect can host that onboarding so it
happens inside a flow launched from the admin console rather than a separate
signup elsewhere — but it is Stripe's process and it takes as long as it takes.
Start the Giving account first; its verification is the slower of the two.

**What this removes,** and the reason it is worth building this way: no secret
key or webhook secret ever passes through anyone's clipboard, no Container App
secret has to be created per account per organization, and no webhook endpoint
has to be registered by hand in a dashboard. PPBF holds ONE platform key. Every
connected account is a stored ID, and events arrive identified by account.

**Revocation is part of the flow, not an afterthought.** A gym can disconnect
from its own Stripe dashboard at any time, and Stripe will say so via
`account.application.deauthorized`. The platform must handle that event by
marking the account disconnected and refusing new charges against it — an
integration that only handles connection is one that keeps trying to charge
through a revoked account.

## What is reserved (names only — nothing exists)

Reserving names now prevents the later build from colliding with five
months of other people's naming choices:

- Capability: `CAP-012` (admin console), capability `#19` (PPBF_CAPABILITIES.json)
- Env vars — **one platform credential set, not one per account.** Connected
  accounts are rows, not configuration; that is the whole point of the connect
  flow. Adding a gym must never mean adding a secret.
  - `PPBF_PAYMENTS_ENABLED`, `PPBF_PAYMENT_PROVIDER`
  - `PAYMENT_PLATFORM_SECRET_KEY` (Container App secret:
    `payment-platform-secret-key`) — PPBF's own platform key, used to act on
    behalf of connected accounts
  - `PAYMENT_PLATFORM_WEBHOOK_SECRET` (secret: `payment-platform-webhook-secret`)
  - `PAYMENT_CONNECT_CLIENT_ID` — the OAuth client the connect button sends
    admins to
- Routes: `app/api/pilot/payments/**` — `connect/start` and `connect/callback`
  (the OAuth round trip), `checkout-session`, `portal`, and ONE `webhook`.
  A single webhook endpoint is correct here, and safe, precisely because
  connected-account events are signed with the one platform secret and name
  their account in the event itself. The lane is then resolved by looking that
  account up in `pilot.payment_accounts` — never inferred from the payload.
  An event naming an account the platform does not have on file is rejected,
  not guessed at.
- Tables:
  - `pilot.payment_accounts` — the connect flow's whole state: `organization_id`,
    `lane` (`giving` | `program`), `stripe_account_id`, `status`
    (`connected` | `disconnected`), who connected it, when, and when it was
    revoked. Unique on (`organization_id`, `lane`) so a gym cannot end up with
    two giving accounts and an ambiguous destination.
  - `pilot.payment_transactions`, `pilot.payment_subscriptions` — every row
    carries a non-null `lane` alongside `organization_id`, so which book a
    payment belongs to is a stored fact rather than an inference from its
    amount or its metadata.
  - Migration named `pilot_slice_postgres_payments_migration.sql`, added to the
    apply-migrations `all` list per its list-check rule.
- Audit events: `payment_*` vocabulary in the standing audit-event registry,
  each event recording which account it came from

## What flipping the slot requires, in order

1. Owner registers PPBF's Stripe **platform** account and its Connect OAuth
   client — done once, for the whole platform, not per gym.
2. Owner presses *Connect Stripe account* twice: Giving (with 501(c)(3)
   verification and the nonprofit rate applied) and Program. Start Giving
   first; its verification is the slower of the two. No keys are copied
   anywhere — the flow returns account IDs.
3. Compliance sign-off recorded — the same explicit human gate the capability
   description names today.
4. The thin backend lane: the connect round trip and `pilot.payment_accounts`,
   checkout-session, one webhook route with signature verification and
   deauthorization handling, mirror tables + migration, receipts carrying the
   right language for the lane (deductible, no-goods-or-services for giving;
   ordinary receipt for program).
5. Staging-first rollout behind `PPBF_PAYMENTS_ENABLED`, exactly like the
   worker and embedding flags: env present and OFF in production until staging
   proves a full connect → donation → webhook → mirror → receipt round trip,
   and a disconnect that actually stops the next charge.
6. CAP-012 flips from `BLOCKED` only after step 5's evidence exists.
