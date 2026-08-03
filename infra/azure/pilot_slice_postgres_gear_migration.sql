-- Gear catalogue (pilot.gear_products) -- one product, two prices, and a
-- boundary between them that the database itself helps hold.
--
-- The gym buys equipment on a wholesale account at roughly half retail and
-- sells some of it on to fund the program. That makes every product carry two
-- numbers with very different audiences:
--
--   wholesale_cost_cents  what the gym paid. CONFIDENTIAL. It is the gym's
--                         negotiated position with a supplier, and publishing
--                         it would expose terms that are not the public's to
--                         see and that a supplier agreement may forbid
--                         disclosing at all.
--
--   retail_price_cents    what a member of the public pays. Public by
--                         definition.
--
-- THE COST COLUMN MUST NEVER REACH A PUBLIC RESPONSE. gearCatalog.ts holds two
-- explicit column lists rather than one list minus a field, so the public read
-- cannot acquire the cost column by someone adding it to a shared constant.
-- That is the same discipline the roster export uses, for the same reason: a
-- query that later selects an extra field must not be able to widen what
-- leaves the platform by accident.
--
-- MONEY IS INTEGER CENTS, NEVER FLOAT. 0.1 + 0.2 is not 0.3 in binary floating
-- point, and a catalogue that drifts a cent per operation produces a margin
-- report that does not reconcile with a bank statement. Postgres `numeric`
-- would also be correct; integer cents is chosen because it survives the trip
-- through JSON and JavaScript unchanged, which `numeric` does not -- node-pg
-- hands numeric back as a string and every consumer would have to remember to
-- parse it.
--
-- NO STOCK LEVEL IN THIS TABLE. A quantity column implies the platform is the
-- authority on how many gloves are in the cupboard, and it is not -- nobody is
-- going to decrement it when a coach hands a pair to a kid. `availability` is a
-- deliberate, honest three-state instead: what the gym is willing to say to a
-- buyer today. Inventory belongs to whoever counts the cupboard.
--
-- NO PAYMENT DATA, NO ORDERS. checkout_url holds a hosted-checkout link
-- (Stripe Payment Link or equivalent) and nothing else. The platform never sees
-- a card, never holds an order, and never reconciles a payment -- that is the
-- reserved payment slot's job, gated on compliance sign-off, and this table
-- deliberately does not begin it. A product with no checkout_url is listed and
-- not purchasable, which is a legitimate state: it is how the store opens
-- before the processor account exists.

create table if not exists pilot.gear_products (
  organization_id text not null references pilot.organizations(organization_id),
  product_id text not null,
  name text not null,
  description text not null default '',
  category text not null default 'general',

  -- Confidential. See the note above before exposing this anywhere.
  wholesale_cost_cents integer not null default 0,
  retail_price_cents integer not null default 0,

  -- Whether the public store lists it at all. A product can exist in the
  -- catalogue for the Treasurer's cost records while never being offered for
  -- sale, which is the normal case for equipment the gym buys for its own use.
  listed_publicly boolean not null default false,

  availability text not null default 'in_stock',

  -- Hosted checkout only. Never a card, never a secret key.
  checkout_url text not null default '',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint pilot_gear_products_pk primary key (organization_id, product_id),

  -- Prices cannot be negative. A negative retail price is a refund the store
  -- would hand out on request, and a negative cost is a data-entry slip that
  -- would make every margin report wrong in the flattering direction.
  constraint pilot_gear_products_cost_nonneg check (wholesale_cost_cents >= 0),
  constraint pilot_gear_products_price_nonneg check (retail_price_cents >= 0),

  constraint pilot_gear_products_availability_check
    check (availability in ('in_stock', 'order_only', 'unavailable'))
);

-- The public store's read: this gym's listed products, in name order. Partial,
-- because the unlisted rows are the majority in a catalogue that also serves as
-- the gym's own purchasing record, and none of them is ever an answer to
-- "what can I buy".
create index if not exists idx_pilot_gear_products_listed
  on pilot.gear_products(organization_id, name)
  where listed_publicly;

comment on table pilot.gear_products is
  'Gym equipment catalogue. wholesale_cost_cents is CONFIDENTIAL and must never appear in a public response -- see gearCatalog.ts, which keeps separate column lists for the public and internal reads rather than one list minus a field.';

comment on column pilot.gear_products.wholesale_cost_cents is
  'What the gym paid, in cents. Confidential: never selected by any public route.';
