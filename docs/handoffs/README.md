# Handoffs

Two different coordination patterns are described here. They serve
different purposes — don't mix them up.

## Pattern 1 — Directed handoff briefs (`HANDOFF_*.md`)

Dated, addressed briefs, each pointed at one specific working session (e.g.
research, visuals). The owner hands a named session its file directly; that
session works the items listed in it per its own "Working agreement" section
in that file. Since OD-2026-09-28-001 only Claude Code opens branches and pull
requests. The briefs are the durable record of what was handed off and when —
they are not an instruction source for ordinary implementation sessions.
`AGENT_KERNEL.md`'s read path does not include them; a session reads a
`HANDOFF_*.md` file only when specifically pointed at it.

| File | Addressed to | Scope |
|---|---|---|
| [`../HANDOFF_RESEARCH.md`](../HANDOFF_RESEARCH.md) | a research session | research and evidence questions |

It sits in `docs/`, not in this directory (its former sibling, the visual-layer handoff, is in `docs/archive/` since 2026-10-02, OD-2026-10-02-004). Both were filed 2026-08-17 against
the capability-network audit and landed on `main` in #437 (`a57258af`).

## Pattern 2 — Shared running log (`CROSS_SESSION_NOTES.md`, archived)

`CROSS_SESSION_NOTES.md` was an append-only log of short, dated, signed
entries from parallel sessions: conflicts discovered between branches,
warnings, and questions for whoever picked up an area next. It is archived as
history (OD-2026-09-28-010, item 14) at
`docs/archive/2026-09-28_CROSS_SESSION_NOTES.md`; add no new entries. Claim
work with a draft PR, not in a document (`docs/AGENT_BRIEFING_PROMPT.md`);
blocked and parked work goes in `docs/current/ACTIVE_WORK.md`.

## Precedence

If a `CROSS_SESSION_NOTES.md` entry and current `main`/an open PR disagree
about a fact (e.g. whether something is merged), trust `main`/the PR — the
notes file is a log of what sessions believed and flagged at the time, not
a source of truth that overrides live state.
