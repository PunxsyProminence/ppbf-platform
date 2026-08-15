-- Payment ledger tables (owner decision 2026-08-15: "ledger tables land
-- first"; the slot design is docs/PAYMENT_SERVICE_SLOT.md, owner decisions
-- 2026-07-31).
--
-- WHAT THIS IS: the three tables the payment slot reserved by name --
-- pilot.payment_accounts (the connect flow's whole state) and the two
-- read-only mirror tables, pilot.payment_transactions and
-- pilot.payment_subscriptions. Creating them now lets the connect flow and
-- webhook drop into a schema that already exists.
--
-- WHAT THIS DELIBERATELY IS NOT: payments. No charging, no checkout, no
-- webhook, no processor calls exist behind these tables yet, and CAP-012
-- stays BLOCKED until the owner's compliance sign-off. The tables start
-- empty and stay empty until the connect flow (accounts) and the webhook
-- (mirrors) are built and switched on per the slot's rollout order.
--
-- Posture inherited from the slot and enforced here structurally:
-- * The processor is the source of truth for money; these mirrors are for
--   reporting. The platform never computes balances it then acts on.
-- * Every row carries organization_id AND a non-null lane ('giving' or
--   'program') -- which book a payment belongs to is a stored fact, never an
--   inference from amount or metadata. Giving and program settle into
--   SEPARATE Stripe accounts (contribution vs program-service revenue).
-- * No card data, ever. Payer identity lives with the processor; the mirror
--   keeps only a display string for reconciliation and receipts, and a minor
--   is never the payer of record.
--
-- Idempotent like every migration in this directory: create table/index
-- if not exists, no alters, no drops, safe to re-run wholesale.

create table if not exists pilot.payment_accounts (
  organization_id          text not null references pilot.organizations(organization_id) on delete cascade,
  lane                     text not null check (lane in ('giving', 'program')),
  stripe_account_id        text not null check (length(btrim(stripe_account_id)) > 0),
  status                   text not null default 'connected' check (status in ('connected', 'disconnected')),
  connected_by_account_id  text not null references pilot.accounts(account_id),
  connected_at             timestamptz not null default now(),
  revoked_at               timestamptz null,
  updated_at               timestamptz not null default now(),
  -- Unique on (organization_id, lane) BY PRIMARY KEY: a gym cannot end up
  -- with two giving accounts and an ambiguous destination. Reconnecting is
  -- an update to this row, not a second row.
  primary key (organization_id, lane),
  -- A revocation timestamp only makes sense on a disconnected row.
  constraint pilot_payment_accounts_revoked_check
    check (revoked_at is null or status = 'disconnected')
);

create table if not exists pilot.payment_transactions (
  organization_id    text not null references pilot.organizations(organization_id) on delete cascade,
  transaction_id     text not null,
  lane               text not null check (lane in ('giving', 'program')),
  stripe_account_id  text not null,
  amount_cents       bigint not null check (amount_cents >= 0),
  currency           text not null default 'usd',
  status             text not null check (status in ('pending', 'succeeded', 'refunded', 'failed')),
  description        text not null default '',
  payer_display      text not null default '',
  occurred_at        timestamptz not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  primary key (organization_id, transaction_id)
);

create table if not exists pilot.payment_subscriptions (
  organization_id    text not null references pilot.organizations(organization_id) on delete cascade,
  subscription_id    text not null,
  lane               text not null check (lane in ('giving', 'program')),
  stripe_account_id  text not null,
  amount_cents       bigint not null check (amount_cents >= 0),
  currency           text not null default 'usd',
  billing_interval   text not null check (billing_interval in ('month', 'year')),
  status             text not null check (status in ('active', 'past_due', 'canceled')),
  payer_display      text not null default '',
  started_at         timestamptz not null,
  canceled_at        timestamptz null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  primary key (organization_id, subscription_id),
  -- A cancellation timestamp only makes sense on a canceled row.
  constraint pilot_payment_subscriptions_canceled_check
    check (canceled_at is null or status = 'canceled')
);

-- The reporting queries: a lane's money over time, and a lane's sustainers.
create index if not exists idx_payment_transactions_by_lane
  on pilot.payment_transactions(organization_id, lane, occurred_at);
create index if not exists idx_payment_subscriptions_by_lane
  on pilot.payment_subscriptions(organization_id, lane, status);
