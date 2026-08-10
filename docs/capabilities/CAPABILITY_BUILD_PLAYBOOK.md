# Capability Build Playbook

## Rules
1. PPBF_CAPABILITIES.json governance.active stays false until promotion review.
2. Tracker Status=DONE means slice shipped in code, not CSV updated.
3. Prefer reuse existing tables/APIs over new schema (see issue #156).
4. One vertical slice per PR: read or write path + role gate + test + short module note.
5. Board / public never get individual athlete clinical detail.

## Definition of done (one module)
- Code path exists under apps/web (API and/or UI)
- Role checks via existing auth helpers
- Org isolation (organization_id) enforced
- At least one automated test OR documented live smoke steps
- docs/capabilities/modules/NNN-*.md updated with Status, slice, audit log
- expanded-200-backlog.csv Status + ManualVerification

## Priority order (build in this order)

### P0 - Live pilot hardening
- Passbook v1 (issue #156): assemble one athlete read model
- 003 Safety Gate: participate/hold blocks where intended
- 011 Goal Management: category + progress persist
- 008 / 118 Coach Review: decision persist + open filter
- 012 Roster: list + gym_status filter

### P1 - Coach / guardian value
- progression_gaps: coach who stopped coming
- 009 Athlete update create + coach list
- 085 / 093 Parent tasks + guardian dashboard linked only
- 122 Attendance mark present/absent

### P2 - Reporting / privacy
- 147 / 148 Board aggregates only
- 200 / 150 Privacy tiers + write note limits
- 164 AI cannot set approved_flag

### P3 - Deferred
176-192 advanced engines stay DEFERRED until design review.

## Vertical slice template
1. Find existing API/table
2. Gap only: missing field, list, or gate
3. Implement smallest change
4. Test happy path + forbidden role
5. Update module md + CSV
6. Smoke on https://www.punxsyprominence.org if deployable

## Promotion
Human review then consider governance.active / ACTIVE labels.
Never bulk-activate 200 modules.
