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

Each module file records its own status: **DRAFT**, **DONE**, or **claimed,
no code** -- a DONE claim with no code behind it, relabelled on 2026-09-28
until Jason walks through it (OD-2026-09-28-010 item 18).
Capability build status lives in the module files under
[docs/capabilities/modules/](docs/capabilities/modules/) (OD-2026-09-28-010
item 17).

## Core Engineering Rules

- Current source beats historical documentation.
- Authentication is mandatory on every non-public surface.
- Authorization is mandatory: role and assignment checks, never trust-the-client.
- Organization isolation is mandatory: organization-owned data never crosses organizations.
- Unfinished capabilities must not block unrelated core workflows.
- Migrations are controlled — No HTTP route changes the schema.
- Evidence must support claims; report the check that was actually run.
- `main`: every change lands by PR with green CI, and nobody pushes directly.
  That is policy; what GitHub actually enforces is narrower (see
  [AGENT_KERNEL.md](AGENT_KERNEL.md), "Repository writes").
- Make the smallest safe change; one concern per branch/PR.
- Executable tests beat duplicated prose.

## Development

Setup, environment variables, run, and test commands are documented once:

- [apps/web/README.md](apps/web/README.md) — the application, its checks, and how to run them
- [DEVELOPER_ONBOARDING.md](DEVELOPER_ONBOARDING.md) — first-run environment setup

## Documentation

Which source wins when two disagree -- code, Jason's rules and decisions, the
current request or work order, and every document below them -- is one list:
[AGENT_KERNEL.md](AGENT_KERNEL.md), "Source hierarchy".
