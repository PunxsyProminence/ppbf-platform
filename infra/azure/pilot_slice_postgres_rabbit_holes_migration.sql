-- Rabbit Holes (pilot.rabbit_holes) -- authored deep-dive lessons, stored
-- against the vocabulary they teach.
--
-- A rabbit hole is CONCEPT + HOMEWORK: explain why something works, then give
-- the reader something to do with it. That is the shape the product already
-- carries in apps/web/components/AthleteWorkspace.tsx under the 'rabbit-holes'
-- tab, where a single lesson is hardcoded JSX. A lesson written into a
-- component belongs to whoever can edit the component, reaches exactly one
-- role, and cannot be retired without a deploy.
--
-- WHAT A LESSON IS ANCHORED TO, AND WHY IT MATTERS MOST
--
-- anchor_type names a vocabulary and anchor_key names one value inside it. The
-- vocabularies admitted here are the platform's STABLE keys -- CHECK-constrained
-- enums and frozen TypeScript unions -- because those are the only identifiers
-- that survive an edit to display copy:
--
--   'gap_type'         6 values, pilot.progression_gaps.gap_type CHECK
--                      (technique, strength, endurance, skill, mental, tactical)
--   'severity'         4 values, pilot.progression_gaps.severity CHECK
--                      (critical, high, medium, low)
--   'formula_id'       39 values, FORMULA_IDS in
--                      apps/web/src/server/pilot/formulas/types.ts, frozen and
--                      exhaustive over the SHADOW formula registry
--   'board_seat'       8 slugs, apps/web/app/board/boardWorkspaceConfig.ts --
--                      the same slugs pilot.board_seats.seat admits
--   'evidence_tier'    4 values, ShadowEvidenceTier in
--                      apps/web/src/server/pilot/shadowEvidenceTier.ts
--   'readiness_band'   GREEN / YELLOW / RED
--   'compliance_rule'  the slug suffix of pilot.compliance_rules.rule_id, which
--                      is deterministic ('rule_<category>_<organization_id>_<slug>')
--   'drill'            a drill_id
--
-- A lesson keyed to a display card instead would detach the moment somebody
-- rewrote the card's copy, and would leave no way to tell that it had. Keyed to
-- a vocabulary value, a lesson stays attached to the concept for as long as the
-- concept exists, and removing the concept is a schema change that surfaces it.
--
-- ANCHOR_KEY IS DELIBERATELY UNCONSTRAINED IN SQL
--
-- One column holds values drawn from eight different vocabularies, so no CHECK
-- here could be correct: a constraint listing every value of all eight would
-- accept 'technique' under anchor_type 'formula_id'. THE CODE OWNS KEY
-- VALIDITY -- the writer must confirm the key belongs to the vocabulary its
-- anchor_type names, and must refuse an empty one. Because nothing in this file
-- can enforce that, apps/web/src/server/pilot/rabbitHoles.pg.test.ts carries the
-- vocabulary contract instead: it asserts every value of the importable
-- vocabularies stores and reads back, and it asserts directly that the database
-- accepts a key belonging to no vocabulary at all, so the obligation on the
-- writing code is recorded as a test rather than as a hope.
--
-- 'drill' takes no foreign key for the same reason it takes no vocabulary
-- check: pilot.drills is owned elsewhere, and a lesson about a drill must not
-- become undeletable-drill machinery.
--
-- THE SHADOW LIBRARY REFERENCE IS A NULLABLE ID WITH NO FOREIGN KEY
--
-- pilot.shadow_library_documents.document_id is a primary key and
-- (document_id, organization_id) is unique, so a composite foreign key is
-- available. It is not used, for three reasons:
--
--   1. Existence is not the property that matters. A document is citable only
--      when ingest_state = 'indexed', index_completed_at is not null,
--      approval_state = 'approved' and verification_state = 'verified' -- AND
--      its source in pilot.shadow_library_sources is status 'active', approved
--      and verified. That is the predicate shadowLibrary.ts retrieval already
--      uses. Seven mutable columns across two tables; no foreign key expresses
--      any of them.
--   2. Approval is revocable. A document approved when the lesson was written
--      can be rejected an hour later, so the read must re-check regardless of
--      what a foreign key guaranteed at insert time. A key that must be
--      re-verified on every read buys nothing and implies safety it does not
--      have.
--   3. A foreign key would couple library takedown to authored teaching.
--      Documents cascade-delete with their source, so ON DELETE CASCADE would
--      destroy a coach's lesson when a source was purged, and the default NO
--      ACTION would block the purge. Withdrawing library material must never be
--      blocked by a lesson, and a lesson must never be destroyed by a
--      withdrawal: the concept and homework are the lesson, and the citation is
--      an optional addition to it.
--
-- So the read resolves the reference by LEFT JOIN carrying the full approval
-- predicate AND d.organization_id = r.organization_id -- without a foreign key,
-- organization scoping of the citation is the read's responsibility. A
-- reference that does not resolve renders as no citation while the lesson still
-- renders; it never renders an empty citation shell, and it never borrows a
-- SHADOW evidence tier, which means RETRIEVED AND CITED and is not something
-- hand-authored text can claim.
--
-- WHAT THIS TABLE DELIBERATELY DOES NOT HOLD: no athlete_id, no subject_id, no
-- entity_id, no assignment. A rabbit hole is authored teaching about a
-- vocabulary term, never an observation about a person. That is precisely what
-- makes audience 'all' and audience 'board' safe -- no row here is about an
-- athlete, so no audience value can widen access to identifiable youth data,
-- and the board's aggregate-only rule is untouched.
--
-- AUDIENCE IS THE ACCOUNT ROLE VOCABULARY PLUS 'all'. Naming a role that no
-- account can hold produces a lesson nobody can be shown, so the check admits
-- exactly the nine roles pilot.accounts.role admits, plus 'all' for a lesson
-- addressed to the whole gym. The read filters `audience in ('all', <role>)`.
--
-- STATUS IS 'published' OR 'retired'. Coaches publish directly -- there is no
-- review state, because there is no reviewer -- so a lesson is either being
-- shown or it is not. Retiring is how a lesson leaves the surface; nothing is
-- deleted, so a homework assignment a reader is part-way through does not
-- vanish from the record.
--
-- THE VOCABULARY CHECKS RECONCILE RATHER THAN SKIP. Both anchor_type and
-- audience are expected to grow: a new stable vocabulary earns a new
-- anchor_type, and the role list has already grown once ('board', added by
-- pilot_slice_postgres_board_role_migration.sql). A catalog-guarded `if not
-- exists` guard would leave an already-migrated environment rejecting the new
-- value forever, so the DO block below drops and re-adds each constraint,
-- making this file the single source of truth on every run. Re-running is still
-- a no-op: the resulting constraint is identical. If a row somewhere violates a
-- narrowed list the ADD fails, the runner's transaction rolls back, and the
-- previous constraint is restored intact.
--
-- author_account_id clears rather than blocks when that account is removed, and
-- author_display_name is stored alongside it: the lesson outlives the coach who
-- wrote it, and attribution survives their account.
--
-- No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-rabbit-holes-migration.mjs) opens the
-- transaction itself, matching the board-seats / announcements /
-- volunteer-program convention. The shadow-runtime runner takes the opposite
-- one, and a file must not move between the two without being changed to match.

create table if not exists pilot.rabbit_holes (
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  rabbit_hole_id uuid not null,

  -- The vocabulary, and one value inside it. See the header: the check on
  -- anchor_type is below, and anchor_key is owned by the writing code.
  anchor_type text not null,
  anchor_key text not null,

  -- Which role may see it. 'all' is the whole gym.
  audience text not null default 'all',

  title text not null,
  concept text not null,

  -- Nullable: not every lesson has something to go and do.
  homework text null,

  -- An optional pointer into the SHADOW Library, resolved at read time against
  -- the approval predicate. Never a foreign key -- see the header.
  library_document_id text null,

  author_account_id text null references pilot.accounts(account_id) on delete set null,
  author_display_name text not null,

  status text not null default 'published'
    constraint pilot_rabbit_holes_status_check check (status in ('published', 'retired')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint pilot_rabbit_holes_pkey primary key (organization_id, rabbit_hole_id)
);

-- Reconciled on every run rather than guarded, so this file is the one place
-- either vocabulary is written down.
do $pilot_rabbit_holes_vocabulary$
begin
  alter table pilot.rabbit_holes
    drop constraint if exists pilot_rabbit_holes_anchor_type_check;
  alter table pilot.rabbit_holes
    add constraint pilot_rabbit_holes_anchor_type_check
    check (anchor_type in (
      'gap_type',
      'severity',
      'formula_id',
      'board_seat',
      'evidence_tier',
      'readiness_band',
      'compliance_rule',
      'drill'
    ));

  alter table pilot.rabbit_holes
    drop constraint if exists pilot_rabbit_holes_audience_check;
  alter table pilot.rabbit_holes
    add constraint pilot_rabbit_holes_audience_check
    check (audience in (
      'all',
      'platform_owner',
      'organization_admin',
      'admin',
      'coach',
      'athlete',
      'parent',
      'board',
      'volunteer',
      'staff'
    ));
end
$pilot_rabbit_holes_vocabulary$;

-- The read the surface makes: every published lesson for one organization, one
-- anchor and one audience. Partial on status so retired lessons occupy nothing
-- in the index the reader traverses, and so the index cannot serve a query that
-- forgot the status filter.
create index if not exists idx_pilot_rabbit_holes_published_anchor
  on pilot.rabbit_holes(organization_id, anchor_type, anchor_key, audience)
  where status = 'published';
