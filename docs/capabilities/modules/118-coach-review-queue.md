# Module 118 — Coach Review Queue

| Field | Value |
|-------|-------|
| Status | **IN_PROGRESS** |
| Active | false |
| ManualVerification | IN_PROGRESS_CHECKLIST |
| Parent original-25 | 10 Coach Review Queue |
| Vertical slice | coach review queue filter + open count |

## Intent
Coach can filter the review queue (e.g. open vs decided) and see an open count. Builds on 008; does not replace the queue.

## Boundaries
- Does not auto-decide reviews.
- Does not show queue to board or public.
- Does not expand athlete PII beyond what queue already shows.

## Vertical slice
1. Locate coach-reviews list + review-queue UI
2. Filter by status/decision state if missing
3. Open/pending count on queue header or API
4. Tests: coach only

## Checklist (manual)
- [ ] Open filter works
- [ ] Open count matches list
- [ ] Decided items excluded when filtering open
- [ ] ManualVerification=PASSED

## Audit log
| Date | Actor | Note |
|------|-------|------|
| 2026-08-03 | wave3-ps | IN_PROGRESS after 153 DONE |
