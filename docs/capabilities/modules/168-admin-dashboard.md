# Module 168

| Field | Value |
|-------|-------|
| Status | **MAPPED** |
| Status note | Was "DONE (Wave 8 tracker)" until 2026-10-16. Admin home is /admin/people (roster, pilotRoleRouting) and compliance counts live separately on /admin/compliance-center; no single dashboard with roster plus open compliance counts. |
| Code | `apps/web/app/admin/people/page.tsx`, `apps/web/app/admin/compliance-center/page.tsx` |
| Tests | `apps/web/app/admin/people/page.test.tsx`, `apps/web/app/admin/compliance-center/page.test.tsx` |
| Active | false |
| ManualVerification | SIGNED_OFF |
| Parent | Admin |
| Vertical slice | admin dashboard roster + open compliance counts |

## Boundaries
- Dashboards show only role-allowed data
- Board stays aggregate-only (not these dashboards)
- AI drafts never set approved_flag / final decisions
- governance.active stays false

## Audit log
| Date | Actor | Note |
|------|-------|------|
| 2026-08-03 | wave8-ps | Wave 8 batch DONE in tracker |
| 2026-08-28 | owner (Jason Neale) | Manual verification signed off. ONE BLANKET SIGN-OFF covering all 47 modules that carried PENDING_SIGN_OFF, given by the owner on this date -- NOT 47 separate inspections, and this line says so on purpose. What it records is the owner's acceptance of the slices as built; it is not a statement that each module was individually re-verified against the running app, and it does not change `Active`, which stays false. At the time of signing, 59 of the 94 modules claiming DONE cited no checkable path into the codebase -- the capability evidence guard in the web test suite measures that and stops it growing -- deliberately named here without a path, because this note would otherwise read as a citation to the very tooling that counts citations, and make 47 modules look evidenced by their own sign-off line. |
| 2026-10-16 | Claude (lane L32) | Status set to **MAPPED** under the 2026-10-16 status vocabulary (DONE / MAPPED / CLAIMED-NO-CODE / DRAFT; Overwatch GO). Was "DONE (Wave 8 tracker)". Code and Tests rows added; the capability status check in CI reads them. ManualVerification unchanged. |
