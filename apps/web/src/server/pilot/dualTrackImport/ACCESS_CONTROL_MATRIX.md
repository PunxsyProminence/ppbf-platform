# Dual-track import: access-control matrix

Roles per `PilotRole` (`apps/web/src/server/pilot/contracts.ts:1`) and enforcement points per `apps/web/src/server/pilot/access.ts`.

| Role | `athlete_private` | `organization_doctrine` | `admin_restricted` | `support_reference` |
|---|---|---|---|---|
| **athlete** (the athlete themself) | Own records only, via `assertActorCanAccessAthlete` self-check (`access.ts:75-80`) | Read (approved only), same as any org member | **No access** — no destination exists; would need a dedicated role check even if one did | No access — not evidence-grade, never surfaced |
| **parent** | Own linked athlete only, via `guardian_links` join (`access.ts:82-99`) | Read (approved only) | **No access** | No access |
| **coach** | Assigned athletes only, via `assertCoachAssignedToAthlete` (`access.ts:34-43`) | Read (approved only) | **No access — by explicit design of this package** (`isVisibleToOrdinaryCoach` returns `false`) | No access |
| **organization_admin** / **admin** | All athletes in org, via `isOrganizationAdminRole` + `assertAthleteBelongsToOrganization` (`access.ts:65-68`) | Read/review/approve (existing `reviewShadowLibrarySource/Document` flow) | **No access today** — this package does not grant it either; a real admin-restricted store would need its own explicit role gate, not inherited from `organization_admin`'s existing broad athlete access | Read (source-candidate visibility) |
| **board** | **Explicitly forbidden** — "board role is restricted to organization-level aggregates" (`access.ts:61-63`) | Aggregate-level only, per existing app design | No access | No access |
| **platform_owner** | **Explicitly forbidden by default** — "platform owner cannot access organization-private athlete records by default" (`access.ts:56-59`) | Org-scoped, not privileged beyond normal org rules | No access | No access |

## Notes

- This matrix describes **today's enforcement**, verified against `access.ts`, not aspirational design. The "No access" cells for `admin_restricted` are true by omission (no code path exists at all), not by an active, tested authorization check — that is precisely the gap flagged in `MAPPING.md` and the final report.
- `dryRunImporter.ts`'s `admin_restricted` refusal is classification-based and unconditional; it does not vary by caller role, because this package has no notion of the calling actor's role at all — it only ever produces a plan, never executes an authorized write. A real (future) admin-restricted store would need its own actor-aware, role-gated read/write path, analogous to `access.ts`'s existing pattern, before any such data is ever loaded.
- `pilot.intake_cases`/`pilot.intake_documents` reviewer gating (`organization_admin`/`admin`/`platform_owner`, plus an `organization_admin`-only promotion gate behind `PPBF_INTAKE_PROMOTION_ENABLED`) is the closest existing precedent for what an `admin_restricted` gate would need to look like.
