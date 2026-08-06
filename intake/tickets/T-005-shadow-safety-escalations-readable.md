# T-005 — SHADOW safety escalations readable (admin can't see reports)

> Status: OPEN
> Lane: A or B
> Priority: P1 pilot-blocking / safeguarding

## Context you need

Same platform conventions as T-000 template / guardrails. SHADOW chat can
classify high-risk content and near-miss / pain-adjacent signals; operators need
a readable queue, not metrics alone.

## Goal

An organization admin (and any role the existing APIs already allow) can open
one screen, see **open safety-related escalations / near-misses / high-risk
review items** for their org, and understand severity + subject scope without
SQL or hand-crafted API calls.

## In scope

- Inventory existing read APIs first: e.g.
  `apps/web/app/api/pilot/shadow/near-misses/route.ts`,
  coach pain-reports, shadow metrics escalations counts, compliance escalate
  paths — **reuse; do not invent a parallel store**.
- One admin (or safety-director) page that lists items with org scope.
- Empty and error states that never claim "all clear" when the fetch failed.
- Tests for render + failed fetch honesty.

## Out of scope

- Do not weaken SHADOW response filters or delete must-filter cases.
- Do not change near-miss write semantics or contact-clearance gate.
- Do not implement full incident-management workflow (assign, SLA, email).
- Contested: if you must touch `shadowChat.ts`, stop and flag first.

## Files allowed

- `apps/web/app/admin/safety-escalations/**` or `apps/web/app/board/safety-director/**`
  extension — prefer existing board safety-director page if it is a stub
- Page tests only, unless a thin list API is truly missing (then one new route
  under `api/pilot/` that wraps existing server list helpers)

## Acceptance criteria

- Page loads with session; 401/403 without.
- Failed list fetch does not show a false empty-success message.
- All queries keep `organization_id` in SQL.

## Delivery

Lane A: `ticket/T-005-shadow-safety-escalations-readable`
Lane B: `intake/drops/T-005/` complete files + MANIFEST

## Evidence of the gap (audit)

- Metrics expose escalation counts; near-misses API is athlete-scoped list.
- Admin path to **read org-wide safety escalations as a queue UI** was not
  found as a dedicated console at ticket write time; board safety-director
  page exists as a route — verify whether it is wired or placeholder before
  duplicating.
