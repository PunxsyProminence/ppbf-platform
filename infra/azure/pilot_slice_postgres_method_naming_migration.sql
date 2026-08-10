-- Method naming: the architecture formerly labelled by an athlete's first name
-- Applies a constant, not a schema change beyond the one lookup table.
--
-- WHY THIS FILE EXISTS. The strongest coaching architecture in PPBF's material -- observe, decide,
-- execute, reset; tempo control; constraint levels; regression rules; per-drill stop rules -- was
-- authored as an individualized programme for one child and carries that child's first name.
-- The architecture generalizes; the name cannot follow it into a schema, a git history, or a screen
-- a coach reads. "Adaptive Boxing" was considered and set aside: it is already the product name and
-- is widely used elsewhere in the field.
--
-- THE NAME: RESET METHOD.  method_key = 'reset_method'
--
-- It is taken from the programme's own vocabulary rather than invented. "Reset" is a listed frequent
-- coaching phrase; there is a reset minute between drill rounds; there is a room-level reset
-- protocol (freeze, back to stance, one sentence, one rep, restart slower); and the top competence
-- level is defined as the athlete who resets without being told.
--
-- The reason it fits the whole programme and not just the drills: in this method the reset is not
-- a failure state. It is the fourth phase of the cycle and a taught skill in its own right. That is
-- also precisely the life-skill claim the programme makes -- control before reaction, returning to
-- a controlled baseline after something goes wrong -- which is why the same word carries the
-- technical architecture and the engagement premise without either being a stretch.
--
-- Change it freely. It is a constant in one table, referenced by key, and renaming costs one update.
--
-- No begin;/commit; here on purpose, matching this repo's runner-opens-the-transaction convention
-- (the runner is apps/web/scripts/pilot-apply-method-naming-migration.mjs). Global lookup table --
-- deliberately not organization-scoped, since the method name is a product-wide constant, not
-- something each pilot org configures independently.

create table if not exists pilot.methods (
  method_key    text primary key,
  display_name  text not null,
  cycle_phases  text not null,
  origin_note   text not null default '',
  created_at    timestamptz not null default now()
);

insert into pilot.methods (method_key, display_name, cycle_phases, origin_note)
values (
  'reset_method',
  'Reset Method',
  'observe -> decide -> execute -> reset',
  'Generalized from a PPBF individualized programme manual. Architecture retained in full; the individual''s name and any profile-specific programming were not carried over.'
)
on conflict (method_key) do nothing;
