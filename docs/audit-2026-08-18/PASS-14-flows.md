# PASS 14 — Role journeys & flow, end to end

Audit date: 2026-08-18. Branch: `docs/full-spectrum-audit-2026-08-18`. Read-only pass.

## Method

Every other pass in this audit checked components in isolation. This pass traces
**whole role journeys** — UI entry point -> API route -> domain module -> database
write -> and back out to every screen that reads the resulting state. The question
is not "is this function correct" but **"can the role finish the job, and is every
downstream gate that depends on this journey's output actually fed?"**

Procedure per journey:

1. Find the UI entry point (page/component) the role starts from.
2. Follow the request to its API route handler.
3. Follow the handler into the domain module(s) that own the state change.
4. Read the persistence layer / schema for what fields are actually set.
5. Then invert: `grep` for every *reader* of those fields, and check whether the
   journey set what each reader assumes.
6. Try to refute the finding before writing it (look for a second enforcement
   point, a DB constraint, a cron/backfill, a UI guard) and record the refutation
   attempt.

Verdicts used:

- **complete** — role can finish; downstream gates fed.
- **broken** — role cannot finish, or an error surfaces.
- **silently incomplete** — the journey *appears* to succeed, returns success to
  the actor, but leaves state unset that a later gate depends on. Most valuable
  verdict here; called out explicitly.

Severity: HIGH+ reserved for journeys where a break means **a child's safety
state is wrong, or a guardian is actively misinformed**. Everything else MEDIUM
or below regardless of engineering ugliness.

Rules followed: every finding carries a verbatim quote plus `path:line`; no gap
filling — where tracing stopped, that is stated with the reason; no real names,
PINs or secrets reproduced.

> Written incrementally. Journeys appear below in the order traced. If a journey
> heading exists with no verdict, the trace was not finished.

---
