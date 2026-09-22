# Agent Execution Policy — superseded by AGENT_KERNEL.md

**Last updated:** 2026-08-22

> **NOT THE ENTRYPOINT. NOT BINDING. DO NOT PRELOAD.**
>
> **Corrected 2026-08-22.** This file used to declare itself "binding for all AI
> agents", the thing to "read first" at session start, and it named
> `docs/current/WORK_QUEUE.md` "the authoritative queue". All three were wrong,
> and each contradicted a document that outranks this one:
>
> - [`CLAUDE.md`](../CLAUDE.md) and [`AGENTS.md`](../AGENTS.md) both open with
>   "Read `AGENT_KERNEL.md` first. It is the single default execution contract
>   for this repository." There is one entrypoint and this is not it.
> - [`AGENT_KERNEL.md`](../AGENT_KERNEL.md) places `WORK_QUEUE.md` last in its
>   source hierarchy — "historical/provenance evidence only" — and reaches it
>   only for audit and provenance questions.
> - [`docs/current/ACTIVE_WORK.md`](current/ACTIVE_WORK.md) asks that
>   `WORK_QUEUE.md` not be preloaded at all.
>
> Where this file and the kernel disagree, **the kernel wins, without
> exception.** An earlier audit (`docs/capabilities/NETWORK_STATUS.md`)
> recommended retiring this document outright on the grounds that a second
> binding policy nobody reads is the same overlap that got
> `MULTI_AI_EXECUTION_PLAN.md` retired, and that it is referenced by zero files.
> That remains the recommendation and it is an owner decision, not one an agent
> makes by deleting the file. Until it is made, the corrections below stop this
> file misdirecting a session that finds it.

## Purpose

This file records execution habits — triage, anti-speculation, conflict
resolution, review discipline — that are compatible with the kernel and were
worth writing down. It is **reference, not protocol**. The protocol is
[`AGENT_KERNEL.md`](../AGENT_KERNEL.md).

## 1. Operating Mode

Agents must always operate with:

- **Reasoning Level:** High / Max (deep analysis required)
- **Creativity Level:** Low (0–0.3; no speculative behavior)
- **Verbosity:** Medium (structured, not verbose)
- **Tool Use:** Enabled (repo search, file inspection, PR/queue access)

## 2. Core Behavioral Rules

Agents must:

- **Prefer verification over assumption** — check the repository state before acting
- **Prefer existing implementations over new creation** — reuse what is already built
- **Prefer deletion, correction, or closure over expansion** — tighten scope, don't broaden it
- **Never implement functionality that already exists** in open PRs, merged commits, or queued work
- **Always classify the problem before taking action** — understand what exists before deciding what to build

## 3. Execution Hierarchy

When handling any task:

1. **Search the repository first** — what files exist and where
2. **Check open PRs and WORK_QUEUE** — what is already in progress or staged
3. **Determine if the task already exists** or is partially implemented
4. **Only then decide** whether to extend, modify, or create new work

## 4. Anti-Speculation Rule

Agents must **not**:

- guess missing system behavior
- invent architecture not present in the repository
- assume intent beyond explicit instructions or code evidence

**If uncertain → stop and request clarification or inspect further**

Do not proceed under an uncertain assumption. Blocking questions are legitimate when the wrong path wastes more effort than a five-minute ask.

## 5. PR and Work Queue Discipline

Before creating or modifying work:

- Check for duplicate or overlapping PRs (use GitHub search)
- Ensure no conflicting implementations already exist (check WORK_QUEUE)
- If overlap is detected, defer or merge the work rather than creating parallel versions
- If a PR is already in progress, add to it rather than opening a new one
- If a ticket is claimed, do not reclaim it

**Corrected 2026-08-22.** This line read: "Reference `docs/current/WORK_QUEUE.md` as the authoritative queue — it is the single source of truth for what is open, in progress, or staged." It is not. `AGENT_KERNEL.md` ranks it last, as historical/provenance evidence, and `ACTIVE_WORK.md` asks that it not be preloaded. Current state is described by executable code and enforced infrastructure; open PR state belongs in GitHub and should be queried live. Read `WORK_QUEUE.md` for what already happened and what proved it — provenance, deployment evidence, collision notes — not to decide what is open.

## 6. Output Requirements

All agent outputs must be:

- **Structured** — organized with clear reasoning steps
- **Deterministic** — same input → same output (no randomness)
- **Grounded in repository evidence** — cite file paths, line numbers, or commit references
- **Free of unnecessary explanation** unless explicitly requested

When reporting findings or decisions, show your work: "I checked `docs/current/WORK_QUEUE.md` and found no duplicate of this task" is better than "I verified there's no duplicate."

## 7. Mental Model for Agents

Agents should behave like:

> "A senior staff engineer performing strict triage, dependency resolution, and minimal-risk execution."

**Not** like:

> "A brainstorming or exploratory assistant"

That distinction matters. Exploration and ideation are human decisions. An agent's job is to execute a decision that is already made, with verification and guards against mistakes.

## 8. Conflict Resolution

When work overlaps or was already started:

1. **Check the state** — is it open, in progress, or merged?
2. **Reconcile, don't duplicate** — merge the implementations if both are partial, or adopt the one that is further along
3. **State the decision in your output** — e.g., "Found #242 already closed this; adopting that implementation"
4. **Update the queue** — if you merged work, record which PRs/items were reconciled

See `docs/current/WORK_QUEUE.md` §rules row 5 for the standing rule on reconciliation.

## 9. Documentation Discipline

When creating or modifying documentation:

- Always check if a file already exists before writing a new one
- If a file exists but is out of date, update it rather than creating a new file with a timestamp
- Record decisions and reasoning in file headers or adjacent doc comments, not just in commit messages
- Link related work in both directions (e.g., if a PR builds capability X, link it from the doc that describes X)

## 10. Code Review and Verification

Agents building code changes must:

- **Verify locally** — run tests, lint, type checks before pushing
- **Read the diff** — ensure the change is what was intended
- **Check edge cases** — especially around auth, minors' data, and safety invariants
- **Confirm no regressions** — run the full test suite, not just the new test

When in doubt about a change's safety, stop and ask. This repository contains systems affecting minors' data and safety; getting it right is more important than moving fast.

## 11. Performance Expectations

- A typical ticket takes **one agent session** to complete
- Check the WORK_QUEUE for ticket scope and dependencies before starting
- If a task is larger than one session, break it into multiple tickets with clear state transitions
- Use `CLAIMED` state to communicate that work is in progress

## 12. What an Agent Does NOT Do

Agents do **not**:

- Skip the WORK_QUEUE check ("I'll just start working")
- Combine multiple independent tasks into one PR without stating why
- Make design decisions that should be made by the owner or a human reviewer
- Guess at requirements when the spec is ambiguous — ask instead
- Commit directly to `main` or `production` branches (always use feature branches)
- Use force-push without explicit permission and documented reason
- Ignore test failures or skip tests to unblock a merge

## 13. Documentation References

- **Detailed delivery pipeline:** [docs/AI_DELIVERY_PIPELINE.md](./AI_DELIVERY_PIPELINE.md)
- **Contributor guardrails:** [docs/AI_CONTRIBUTOR_GUARDRAILS.md](./AI_CONTRIBUTOR_GUARDRAILS.md)
- **Execution contract (the entrypoint, outranks this file):** [AGENT_KERNEL.md](../AGENT_KERNEL.md)
- **Current blockers and parked work:** [docs/current/ACTIVE_WORK.md](./current/ACTIVE_WORK.md)
- **Work queue (historical/provenance evidence only — corrected 2026-08-22, this line said "authoritative"):** [docs/current/WORK_QUEUE.md](./current/WORK_QUEUE.md)
- **Git branch requirements:** See session startup instructions or branch label in Claude Code
- **Production state:** [docs/current/PRODUCTION_STATE.json](./current/PRODUCTION_STATE.json)

## 14. Versioning

This policy should be treated as **living documentation** — it changes as the team learns what works. Record updates here with a date. Do not create a new version of this file; update this one.

## Session Initialization

**Corrected 2026-08-22.** Steps 1 and 3 used to read "**Read this file first**
(you are reading it now)" and "**Check WORK_QUEUE.md** — claim work or verify
nothing overlaps". Both were wrong. `CLAUDE.md` and `AGENTS.md` name
`AGENT_KERNEL.md` as the single entrypoint, and the kernel's read path is: the
kernel, then `docs/current/ACTIVE_WORK.md`, then the request or ticket.

When a Claude Code session starts:

1. **Read [`AGENT_KERNEL.md`](../AGENT_KERNEL.md) first.** Not this file.
2. **Read [`docs/current/ACTIVE_WORK.md`](./current/ACTIVE_WORK.md)** for current
   blockers and parked work.
3. **Read the request or assigned ticket.** Load anything further only when the
   task actually touches its domain — the kernel's read path names which
   document covers which domain.
4. **Check the designated branch** — it is provided in your session startup.
5. **Search for existing code and open PRs** before writing anything new. Query
   PR state live in GitHub rather than reading it out of a ledger.
6. **Verify your environment** — run a targeted test first; the full gate is the
   final check, not the opening one.

---

## FAQ

**Q: What if I find code that looks wrong but isn't in the WORK_QUEUE?**
A: File an audit ticket or add it to BACKLOG in the queue. Don't fix it without claiming it first.

**Q: Can I work on multiple tickets in one session?**
A: Only if they are tightly coupled and documented as such. Prefer one ticket per session.

**Q: What if the queue says something different than what I see in the code?**
A: The code is the truth, the queue is the plan. Verify against `main` first, then update the queue to match what you found.

**Q: Who do I ask if I'm blocked?**
A: Check `docs/current/WORK_QUEUE.md` — blocked tickets name their blocker. If your blocker is an owner decision, state it clearly in the PR or add a BLOCKED row to the queue.

**Q: Can I rewrite something that's already done if I think I see a better way?**
A: No. Improvements are tickets with clear rationale. Add them to BACKLOG and claim them through the queue.

**Q: What if I'm unsure about a behavioral decision (e.g., should this field be scoped to org or athlete)?**
A: Check `docs/` for owner decisions already recorded. If none exists, ask in a comment or PR, don't guess.

---

*Authored as a durable system-level standard for multi-agent execution, and
superseded as one. **Corrected 2026-08-22** — this line claimed the file was
"binding for all AI agents working in this repository". It is not, and was not
the only binding policy even when it said so. `AGENT_KERNEL.md` binds; this file
is compatible reference kept for its triage and review habits, pending the
owner's decision on retiring it.*
