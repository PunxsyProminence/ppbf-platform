# PPBF Multi-Gym Readiness Notes

Mode: Architecture note only
Date: 2026-07-13
Scope: Future Core Entity Map alignment for multi-gym expansion

## Decision Rule

For future multi-gym architecture, operational/business entities should be tenant-scoped to an Organization to prevent cross-gym data leakage and to support independent governance, reporting, and lifecycle control per gym.

## Organization Ownership Matrix

| Entity | Organization Owned | Notes |
|---|---|---|
| Athlete | Yes | Athlete records must be isolated by gym/org boundary. |
| Coach | Yes | Coach assignment, permissions, and roster context are org-specific. |
| Parent | Yes | Parent/guardian access should be constrained to org-scoped participant context. |
| Membership | Yes | Membership plans, status, and billing/eligibility are org-owned. |
| Team | Yes | Team composition and schedules are gym/org operational constructs. |
| Video | Yes | Media access, retention, and compliance controls must be org-scoped. |
| Review | Yes | Coach/admin reviews are governance artifacts tied to org workflows. |
| Task | Yes | Work queues and accountability are org-specific operational objects. |
| Assessment | Yes | Assessment definitions/results should be scoped to org methodology and policy. |
| Revenue | Yes | Donations, sponsorships, and revenue lines are org-owned financial records. |
| Grant | Yes | Grant obligations, restrictions, and reporting belong to specific orgs. |
| Scholarship | Yes | Scholarship criteria, funding, and disbursement are org-governed. |
| Source File | Yes | Source/control artifacts require org boundary for publication governance. |

## Practical Implication For Future Core Entity Map Work

- Add OrganizationId as a required ownership boundary for the entities above.
- Treat ownership as mandatory in reads/writes, not optional metadata.
- Keep cross-org/global objects limited to reference catalogs only (not listed entities above).

## Summary

All listed entities should be modeled as Organization Owned = Yes for multi-gym readiness.