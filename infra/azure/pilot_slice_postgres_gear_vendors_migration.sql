-- Gear vendor records (pilot.gear_vendors) plus the two columns on
-- pilot.gear_products that connect a product to a brand and to a supplier
-- account.
--
-- THE DESIGN DECISION THIS FILE EXISTS TO ENCODE. "Everlast" is two different
-- facts with opposite audiences, and they are two columns for that reason:
--
--   gear_products.brand      free text, PUBLIC. A parent buying gloves wants to
--                            know they are Everlast. Stripping the brand from
--                            the store to protect the gym's supplier terms
--                            would remove useful information and protect
--                            nothing, because the brand is printed on the
--                            glove.
--
--   gear_products.vendor_id  a reference into this table, INTERNAL. The gym's
--                            Everlast ACCOUNT -- account number, discount tier,
--                            net terms, who the rep is -- which is the gym's
--                            negotiated commercial position, exactly like
--                            wholesale_cost_cents and confidential for the same
--                            reason.
--
-- Conflating them costs one thing or the other: publish the account and the
-- gym's terms leak, suppress the brand and the store gets worse. Two columns,
-- two audiences, and the public column list in gearCatalog.ts gains `brand`
-- and nothing else.
--
-- NO PASSWORD. NOT EVER. There is no portal_password column here and there
-- must never be one. A supplier login stored in this application would be a
-- credential nobody rotates, readable by anyone holding an organization admin
-- session, sitting in a database built to hold youth records -- so a breach of
-- a youth sports platform would also hand over the gym's purchasing account.
-- What is here is what a Treasurer needs on a screen to place an order:
-- WHICH account, WHERE the portal is, and WHO to call. The person still signs
-- in with their own credentials, held wherever the gym already holds them.
-- pilot-apply-gear-vendors-migration.mjs asserts no credential-shaped column
-- exists, so a later migration that adds one fails the readiness check rather
-- than shipping quietly.
--
-- EVERY VENDOR BELONGS TO ONE GYM. Keyed (organization_id, vendor_id), like
-- gear_products. Two gyms both buying from Everlast hold two separate rows with
-- two separate account numbers and two separate discount tiers, because they
-- are two separate commercial relationships. A vendor_id-only key would collide
-- them and make one gym's negotiated terms the other's.
--
-- DEPENDS ON pilot_slice_postgres_gear_migration.sql, which creates
-- pilot.gear_products. Apply gear before gear-vendors; the `all` list in
-- .github/workflows/apply-migrations.yml orders them that way.
--
-- Additive and idempotent throughout: `if not exists` on the table, the
-- columns and the indexes, and a catalog-guarded DO block for each constraint
-- because PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS.

create table if not exists pilot.gear_vendors (
  organization_id text not null references pilot.organizations(organization_id),
  vendor_id text not null,

  -- The supplier's name as the gym refers to it. Not the brand column on a
  -- product: a distributor sells many brands, and a brand is often sold by
  -- several distributors.
  vendor_name text not null,

  -- CONFIDENTIAL, all four. The gym's account with this supplier and the terms
  -- it negotiated. Never selected by any public route -- see gearVendors.ts,
  -- which holds one field list and deliberately has no public counterpart.
  account_number text not null default '',
  discount_tier text not null default '',
  net_terms_days integer,
  notes text not null default '',

  -- Where to place an order, and who to call about it. A URL and a human's
  -- work contact details -- never a login.
  portal_url text not null default '',
  rep_name text not null default '',
  rep_email text not null default '',
  rep_phone text not null default '',

  -- A supplier the gym has stopped buying from stays on the record rather than
  -- being deleted: the products bought from them still reference the account
  -- the purchase was made on, and a Treasurer reconciling an old invoice needs
  -- that row to still exist.
  active boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint pilot_gear_vendors_pk primary key (organization_id, vendor_id),

  -- Nullable because "we have not recorded the terms" and "payment is due on
  -- receipt" are different facts, and storing 0 for both would tell a
  -- Treasurer the second when the first is true. The bound is a sanity check
  -- on a typed field: negative terms are meaningless and 3650 is a slipped
  -- keystroke, not a two-year invoice.
  constraint pilot_gear_vendors_net_terms_sane
    check (net_terms_days is null or (net_terms_days >= 0 and net_terms_days <= 365)),

  constraint pilot_gear_vendors_name_present
    check (length(btrim(vendor_name)) > 0)
);

-- The Treasurer's list: this gym's suppliers, current ones first.
create index if not exists idx_pilot_gear_vendors_active
  on pilot.gear_vendors(organization_id, vendor_name)
  where active;

-- PUBLIC. The brand printed on the product. Defaulted to empty rather than
-- null so the public read never has to reason about a null, and every existing
-- row keeps working without a backfill.
alter table pilot.gear_products
  add column if not exists brand text not null default '';

-- INTERNAL. Which supplier account this product was bought on. Nullable
-- because most of the catalogue predates this table and because a gym may
-- record a product before it records where it comes from -- an unknown
-- supplier is a real state, and forcing a placeholder row would make it a lie.
alter table pilot.gear_products
  add column if not exists vendor_id text;

do $$
begin
  -- Composite, so a product can only point at a vendor belonging to the SAME
  -- gym. A vendor_id-only reference would let one gym's product name another
  -- gym's supplier account, which is the cross-organization leak this platform
  -- refuses everywhere else.
  --
  -- MATCH SIMPLE (the default) is what makes the nullable column work: with
  -- any referenced column null the constraint is not enforced, so a product
  -- with no vendor is allowed while a product WITH one is checked against both
  -- columns.
  --
  -- No ON DELETE clause, so it is NO ACTION: a vendor that products still
  -- reference cannot be deleted. That is the wanted behavior -- the purchasing
  -- record is the reason the row exists -- and nothing in the application
  -- deletes a vendor anyway. ON DELETE SET NULL would also be wrong here: it
  -- would try to null organization_id, which is NOT NULL.
  if not exists (
    select 1
    from pg_constraint
    where conname = 'pilot_gear_products_vendor_fk'
      and conrelid = to_regclass('pilot.gear_products')
  ) then
    alter table pilot.gear_products
      add constraint pilot_gear_products_vendor_fk
      foreign key (organization_id, vendor_id)
      references pilot.gear_vendors(organization_id, vendor_id);
  end if;
end
$$;

do $$
begin
  -- An empty string is not null, so MATCH SIMPLE would enforce the foreign key
  -- against a vendor named '' and fail with a foreign-key error that reads as
  -- a missing supplier rather than as a blank field. Refuse the blank here so
  -- the cause is named.
  if not exists (
    select 1
    from pg_constraint
    where conname = 'pilot_gear_products_vendor_id_not_blank'
      and conrelid = to_regclass('pilot.gear_products')
  ) then
    alter table pilot.gear_products
      add constraint pilot_gear_products_vendor_id_not_blank
      check (vendor_id is null or length(btrim(vendor_id)) > 0);
  end if;
end
$$;

-- "What have we bought from this supplier" -- the question a Treasurer asks
-- when a rep calls or an invoice arrives. Partial, because a catalogue with
-- most rows unattributed should not carry them in this index.
create index if not exists idx_pilot_gear_products_vendor
  on pilot.gear_products(organization_id, vendor_id)
  where vendor_id is not null;

comment on table pilot.gear_vendors is
  'The gym''s supplier accounts. CONFIDENTIAL in full -- account number, discount tier, net terms and rep contact are the gym''s negotiated commercial position, like gear_products.wholesale_cost_cents. No public route selects any column here. There is deliberately NO password column: a supplier portal login stored in a youth records platform is a credential nobody rotates, readable by every organization admin.';

comment on column pilot.gear_vendors.account_number is
  'The gym''s account number with this supplier. Confidential: never selected by any public route.';

comment on column pilot.gear_vendors.portal_url is
  'Where to place an order. A link only -- never a login, never a token in a query string.';

comment on column pilot.gear_products.brand is
  'PUBLIC. The brand printed on the product (Everlast, Sting). The store shows it because a parent buying gloves wants to know what they are. Distinct from vendor_id, which is the gym''s confidential account with whoever sold it.';

comment on column pilot.gear_products.vendor_id is
  'INTERNAL. The supplier account this product was bought on, within the same organization. Never selected by any public route -- see PUBLIC_FIELDS in gearCatalog.ts.';
