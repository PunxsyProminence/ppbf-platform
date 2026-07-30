-- PPBF Pilot First-Login PIN Migration
-- Safe, additive, idempotent migration for existing pilot schema installations.
-- Adds pilot.accounts.must_change_pin, which turns an athlete account's PIN
-- into a one-use bootstrap credential: the admin hands out a known starting
-- PIN, and the athlete cannot reach anything until they replace it.
--
-- This replaces the activation-code handoff for athlete accounts. The
-- account_activation_tokens table is deliberately left in place -- it is
-- still the mechanism behind any outstanding code that was issued before
-- this migration, and dropping it would strand those athletes mid-activation.
--
-- SAFE ROLLOUT ORDER (this repository's deploy workflows do not apply
-- migrations automatically -- this must be run by hand, against each
-- environment, before deploying the application code from this change).
--
-- Fresh installation:
--   1. Apply the canonical base schema
--        npm run --workspace apps/web pilot:apply-schema
--   2. Do NOT run this migration -- pilot_slice_postgres.sql already declares
--      must_change_pin directly, so a brand-new environment has it already.
--   3. Deploy the application code.
--
-- Existing installation:
--   1. Apply THIS migration
--        npm run --workspace apps/web pilot:apply-first-login-pin
--   2. Deploy the application code.
--
-- Deploying the code before this migration is applied fails every request
-- that resolves a principal, because resolvePrincipal selects the column.

-- No explicit begin/commit here: pilot-apply-first-login-pin-migration.mjs
-- wraps this file in a single transaction itself, exactly as the
-- session-expiry migration and its script do. Opening a second one would
-- nest, and the inner commit would end the outer transaction early.

alter table pilot.accounts
  add column if not exists must_change_pin boolean not null default false;

-- Existing accounts keep must_change_pin = false. That is deliberate: every
-- account that predates this migration either already chose its own PIN via
-- the activation flow, or signs in with Microsoft and has no PIN at all.
-- Defaulting them to true would lock out the entire existing roster and force
-- a PIN reset for people who never had a bootstrap PIN to begin with.

comment on column pilot.accounts.must_change_pin is
  'True while the account still holds the admin-issued bootstrap PIN. requirePrincipal refuses every route except the PIN change while this is set, so the starting PIN can never be used to read athlete data.';
