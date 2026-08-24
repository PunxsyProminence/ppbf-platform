# PPBF Platform

A nonprofit, safety-first training and development platform for boxing/combat
sports gyms. A Next.js (App Router) application in `apps/web` on a PostgreSQL
backend, supporting multiple organizations with strict data isolation and
role-based workspaces. Intelligence (SHADOW, AI, ML) is built into the
platform's architecture from the start.

## Current Operating Model

The base user model is **Platform → Admin → Coach → Athlete**:

- **Platform** — operates the shared infrastructure: hosting, database,
  organization onboarding, and cross-organization isolation.
- **Admin** — runs one organization: members, roles, compliance, consent, and
  organization-level configuration.
- **Coach** — plans and delivers training, records observations, and is the
  final human decision-maker for ordinary coaching decisions within medical,
  consent, safeguarding, and policy boundaries.
- **Athlete** — trains, tracks their own progress, and sees only their own
  record.

The full role vocabulary (board, guardian/parent, staff, volunteer, and the
platform/organization admin split) is defined in
[ORGANIZATION_ROLE_MODEL.md](ORGANIZATION_ROLE_MODEL.md).

## Intelligence Foundation

SHADOW, AI, and ML are foundational platform capabilities baked into the
architecture — not bolt-ons, and not slated for removal. Immature or advanced
intelligence functions stay gated until validated, and an unfinished AI/ML/
SHADOW capability must never prevent the conventional
Platform/Admin/Coach/Athlete application from functioning. Final authority on
any decision an intelligence capability informs remains human.

## Capability Development

Capabilities progress **DEVELOPMENT → VALIDATION → READY → ACTIVE**. A
capability becomes ACTIVE only when its go-live contract is satisfied. Two
additional statuses mark permanence rather than progress: **CORE** (required
base functionality) and **FOUNDATION** (shared infrastructure other
capabilities build on). **DEPRECATED** marks retired capabilities.
Capability contracts live in [docs/capabilities/](docs/capabilities/).

## Core Engineering Rules

- Current source beats historical documentation.
- Authentication is mandatory on every non-public surface.
- Authorization is mandatory: role and assignment checks, never trust-the-client.
- Organization isolation is mandatory: organization-owned data never crosses organizations.
- Unfinished capabilities must not block unrelated core workflows.
- Migrations are controlled — No HTTP route changes the schema.
- Evidence must support claims; report the check that was actually run.
- Protected `main`: every change lands by PR with green CI, no direct pushes.
- Make the smallest safe change; one concern per branch/PR.
- Executable tests beat duplicated prose.

## Development

Setup, environment variables, run, and test commands are documented once:

- [apps/web/README.md](apps/web/README.md) — the application, its checks, and how to run them
- [DEVELOPER_ONBOARDING.md](DEVELOPER_ONBOARDING.md) — first-run environment setup

## Documentation

The authoritative hierarchy is deliberately small:

1. **Current executable source, tests, and config** — the only description of
   current behavior.
2. **This README** — orientation: what the platform is and how it operates.
3. **[AGENT_KERNEL.md](AGENT_KERNEL.md)** — working rules for AI-assisted work.
4. **Domain contracts** — [AUTH_CONTRACT.md](AUTH_CONTRACT.md),
   [ORGANIZATION_ROLE_MODEL.md](ORGANIZATION_ROLE_MODEL.md),
   [ORGANIZATION_ARCHITECTURE.md](ORGANIZATION_ARCHITECTURE.md), and peers —
   read when the task touches their boundary.
5. **Capability contracts** in [docs/capabilities/](docs/capabilities/) — read
   for the capability being changed.
6. **[docs/archive/](docs/archive/)** and research material — historical and
   research-only; never current authority.
