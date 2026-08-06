# T-008 — Guardian consent tracking (minors' photo/video consent)

> Status: OPEN
> Lane: A or B
> Priority: P1 safeguarding — **blocks public-facing photo/video features**

## Goal

The platform can record and read **guardian consent** for minors' photo and
video use (display, training review, publication) with org scope, so features
that show a child's image can check consent instead of assuming it.

## In scope

- Model consent types relevant to photo/video (reuse `waivers` /
  domain-upsert consent paths if they fit; do not invent a second source of
  truth without justification)
- Admin/coach visibility: whether a minor has recorded consent for a given use
- Fail closed for public/wall surfaces when consent is missing (wire only with
  owner approval if behavior changes production defaults)

## Out of scope

- Full legal CMS for every jurisdiction
- Changing wall defaults without owner sign-off
- ML face detection

## Files allowed

- To be finalized after inventory of `waivers`, `intake` domain-upsert, wall
  consent env — list exact paths in PR; contested schema needs owner yes

## Acceptance criteria

- Consent recorded with `organization_id` + athlete/guardian linkage
- Read API or UI shows status for staff roles that need it
- Document: public photo/video features must not ship without this check

## Delivery

**Propose and stop** before large schema: FINDING + one-paragraph plan for
owner. Safeguarding constraint per session reset 2026-08-06.
