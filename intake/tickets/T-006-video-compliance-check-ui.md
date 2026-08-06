# T-006 — Video compliance-check UI (videos stuck in draft / non-ready)

> Status: OPEN
> Lane: A or B
> Priority: P1 pilot-blocking / safeguarding (minors' footage)

## Context you need

T-003 shipped admin **scan-review** for quarantined videos (`/admin/video-review`).
This ticket is the adjacent dead-end: videos in **draft / pending compliance /
non-ready** states that are not the same as malware scan quarantine, if any
such state still has write paths without a human exit UI.

## Goal

Operators can see videos that are blocked from normal use for **compliance /
publication / draft** reasons (not only scan quarantine) and complete the
human check those states require, using existing APIs where present.

## In scope

- Re-read `videoSessions.ts`, `video/list`, `video/[id]/release`,
  `coach/video-publications`, and T-003 UI so you do **not** rebuild scan-review.
- Identify statuses that are not `ready` and not already handled by T-003.
- UI only for those gaps; link to T-003 for quarantined/scan_state needs_human_review.

## Out of scope

- Do not change scan-review decide roles or approve/block semantics.
- Do not enable public publish without T-008 consent policy where required.
- Do not touch contested workflow YAML.

## Files allowed

- New admin or coach page path justified in MANIFEST, or extension of
  `admin/video-review` **only** if the gap is the same queue — prefer separate
  route if concerns differ
- Colocated tests

## Acceptance criteria

- Clear labeling: scan quarantine vs compliance/draft
- Actions call existing routes only
- Tests cover primary action(s)

## Delivery

Lane A: `ticket/T-006-video-compliance-check-ui`
Lane B: `intake/drops/T-006/`

## Depends on

- T-003 on main (scan-review console) — do not regress it
- T-008 before any public-facing media feature
