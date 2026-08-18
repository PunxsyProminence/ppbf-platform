# Handoffs

Two different coordination patterns live in this directory. They serve
different purposes — don't mix them up.

## Pattern 1 — Directed handoff briefs (`HANDOFF_*.md`)

Dated, addressed briefs, each pointed at one specific other AI working
session (e.g. a Research account, a Visuals account). The owner hands a
named session its file directly; that session works the items listed in it
as bounded draft PRs per its own "Working agreement" section in that file.
This directory is the durable record of what was handed off and when — it
is not itself an instruction source for ordinary implementation sessions.
`AGENT_KERNEL.md`'s read path does not include `docs/handoffs/`; a session
reads a `HANDOFF_*.md` file only when specifically pointed at it.

| File | Addressed to | Scope |
|---|---|---|
| _(none yet on this branch — see `origin/claude/artifact-code-session-7piryt` for `HANDOFF_RESEARCH.md` / `HANDOFF_VISUALS.md`, filed 2026-08-17 against the capability-network audit)_ | | |

## Pattern 2 — Shared running log (`CROSS_SESSION_NOTES.md`)

Unlike the directed briefs above, this is not addressed to anyone in
particular and not produced by one audit. Many independent sessions work
this repo in parallel (dozens of open PRs on a busy day); `CROSS_SESSION_NOTES.md`
is an append-only log any session can add a short, dated, signed entry to —
active-work claims, discovered conflicts between branches, warnings, or
questions for whoever picks up an area next.

This does **not** replace `docs/AI_COLLABORATION.md`'s doctrine that `main`,
current source, and live GitHub PRs are coordination truth — it exists for
the things that aren't visible from PR state alone. Do not use it as a
second ledger of PR status; that duplicates what GitHub already shows and
will rot. Check current `main` and open PRs first, as `AI_COLLABORATION.md`
already says; use the notes file for what that check can't tell you.

## Precedence

If a `CROSS_SESSION_NOTES.md` entry and current `main`/an open PR disagree
about a fact (e.g. whether something is merged), trust `main`/the PR — the
notes file is a log of what sessions believed and flagged at the time, not
a source of truth that overrides live state.
