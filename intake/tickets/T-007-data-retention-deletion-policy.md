# T-007 — Data retention & deletion policy (legal compliance)

> Status: OPEN
> Lane: A or B (policy doc may be human-first; code follows)
> Priority: P1 legal / compliance

## Goal

Document and, where missing, implement **retention limits and deletion paths**
for org-owned PII and media (accounts, photos, video, chat logs as applicable)
so operators can fulfill deletion/retention obligations without ad-hoc SQL.

## In scope

- Written policy under `docs/` (retention periods, who may request, what is
  deleted vs anonymized)
- Inventory of tables/blob containers that hold personal data
- Code only for deletion/export hooks that already have partial support —
  extend, do not weaken audit trails required for safety

## Out of scope

- Broad GDPR product suite / self-serve privacy portal
- Silent hard-deletes of safety incident records without owner decision
- Migrations that destroy production data in the PR itself (ship SQL unapplied)

## Files allowed

- `docs/**` policy
- Targeted server helpers + admin-only routes listed in the ticket after
  inventory (update Files allowed in PR if inventory expands — gatekeeper must
  approve expansion)

## Acceptance criteria

- Policy doc merged with explicit periods and roles
- At least one executable deletion or export path for a named data class
  with org scope + audit event
- No migration applied by the builder

## Delivery

Propose plan first if >500 lines or minors' data bulk delete. Owner yes before
large implementation.
