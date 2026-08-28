# Module 200 — Privacy-Tier System

| Field | Value |
|-------|-------|
| Status | **DONE** |
| Active | false |
| ManualVerification | SIGNED_OFF |
| Parent original-25 | Privacy / roles |

## Intent
The Privacy-Tier System names the six audience shapes the platform already
enforces — public, de-identified platform, board aggregate, organization,
athlete record, minor circle — and owns the two registries that never
existed: field-level sensitivity (`FIELD_TIERS`) and the public-surface
denylists, promoted out of the wall test files. It must never become an
engine (enforcement stays in the modules that refuse today), never become a
per-organization configuration (these are platform invariants, and a
configurable tier is a vulnerability with an admin UI), and never flatten
the tiers into a ladder — the minor circle sits *on top of* the athlete
record; the two de-identified shapes sit *beside* it, not above.

## Boundaries
- Does **not** auto-approve progression, medical, or board decisions.
- Does **not** expose athlete-level data to board / public aggregates without suppression rules.
- Does **not** invent metrics that are not stored by the platform.
- Does **not** enforce anything at runtime — `privacyTiers.test.ts` and the
  wall privacy tests are the teeth; the enforcing modules are named per
  entry and drift-checked.
- Does **not** own write-side checks — that is #150 ("Complements 200
  (read tiers) with write-side checks").
- Does **not** decide the withheld weight goal categories — the registry
  makes that owner decision possible and deliberately does not make it.

## Vertical slice (what was built, 2026-08-06)
- `apps/web/src/server/pilot/privacyTiers.ts` — the six-tier doctrine with
  per-tier `enforcedBy` pointers; `FIELD_TIERS` (each field naming its
  enforcer — the count lives in the module, not here, so this record cannot
  drift from it); `PUBLIC_SURFACE_FORBIDDEN_TABLES` / `_COLUMNS` (promoted
  from the wall tests, which now read this module, and pinned exactly by
  the drift suite); the anti-ranking table list, kept separate because
  ranking is not sensitivity.
- `apps/web/src/server/pilot/guardianAccess.ts` — the one definition of
  viewer-scoped guardian reach (`isGuardianLinkedToAthlete`,
  `guardianAthleteIds`), replacing four of the six hand-written
  `guardian_links` joins (access.ts, scheduler route, shadowReadModels,
  research-requirements route); profileDb and athletes/list stay inline
  with recorded reasons; a conformance sweep fails any NEW hand-written
  viewer-scoped join.
- `apps/web/src/server/pilot/privacyTiers.test.ts` +
  `guardianAccess.test.ts` — drift guards: every `enforcedBy` names real
  code, every tier's invariant is re-asserted against its enforcer
  (MINOR_CIRCLE membership, k=5, platform_owner ∉ PHI), tiers are never
  compared numerically, the field registry covers the public denylist.
- `profileVisibility.ts` — `MINOR_CIRCLE` exported (read-only) so the
  registry names it without restating it.
- No table, no migration, no runner, no workflow entry: every rule here is
  a platform invariant, and a DB lookup in front of `decidePortrait` would
  invert its deliberate purity.

## Acceptance criteria
- [x] Data model / tables named — none new, by design (see Intent)
- [x] API surface listed — none new; the registry is consumed at build/test time and by future composers
- [x] Roles that may read / write — per tier, delegated to the named enforcers
- [x] Safety / refusal cases — each tier's refusal re-asserted by drift tests against the enforcing module
- [x] Audit events — none; the registry changes nothing at runtime
- [x] UI surface — none ("API-only" in the narrowest sense: a code registry)

## Record of the DONE↔DRAFT drift
The 2026-08-03 wave marked this module `DONE` in the CSV and this file while
`expanded-200-index.json` still said `DRAFT`. That `DONE` meant *mapped* —
"already served by code that exists" (the role tiers in `access.ts`) — not
*built*; the work file's four steps were all satisfied by pre-existing code.
The 2026-08-06 build above is the actual unification. The index now says
DONE to match.

## Implementation notes
Ordering note for the owner: the build plan required #200 before Phase 2
puts family-facing data everywhere; `ParentDigest.tsx` merged to main on
2026-08-06, ahead of it. The cheap version shipped now exists precisely so
the digest's next iteration can consult `FIELD_TIERS` instead of re-reading
twelve modules.

## Audit log
| Date | Actor | Note |
|------|-------|------|
| 2026-08-03 | wave2-ps | DONE; 146 started |
| 2026-08-06 | session B (remote) | Built the actual tier registry + guardianAccess consolidation on PR #238. DONE now means built-thin, not mapped. Index/CSV drift reconciled. |
| 2026-08-28 | owner (Jason Neale) | Manual verification signed off. ONE BLANKET SIGN-OFF covering all 47 modules that carried PENDING_SIGN_OFF, given by the owner on this date -- NOT 47 separate inspections, and this line says so on purpose. What it records is the owner's acceptance of the slices as built; it is not a statement that each module was individually re-verified against the running app, and it does not change `Active`, which stays false. At the time of signing, 59 of the 94 modules claiming DONE cited no checkable path into the codebase -- the capability evidence guard in the web test suite measures that and stops it growing -- deliberately named here without a path, because this note would otherwise read as a citation to the very tooling that counts citations, and make 47 modules look evidenced by their own sign-off line. |
