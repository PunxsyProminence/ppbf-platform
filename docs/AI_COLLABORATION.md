# Multi-AI Collaboration

Use this only when more than one AI may touch nearby work.

## Model

- One human owner sets intent and retains final product/safety authority.
- Multiple AI agents may build, review, audit, or integrate.
- `main`, current source, and live GitHub PRs are coordination truth.
- Tickets are optional; use them when a durable handoff or decision record adds value.

## Collision control

Before editing, check current `main`, `docs/current/ACTIVE_WORK.md`, and open PRs for the touched files or shared contract.

1. One concern per branch/PR.
2. Do not duplicate work already on `main` or in an open PR.
3. If two agents need the same files or contract, sequence or explicitly reconcile the overlap.
4. Draft PRs are early visibility, not an approval ceremony.
5. Re-derive or close materially stale branches instead of repeatedly patching them forward.

Across AI products the lanes are fixed by OD-2026-09-21-001 (Claude builds; ChatGPT designs and enforces standards, read-only here; Grok owns visual; see `AGENT_KERNEL.md`, Working channel). Among parallel Claude lanes no permanent Builder/Gatekeeper identity is required: one lane may build one change and review another. Independent review is useful for higher-risk work, but executable evidence outranks model agreement.

## Reviewers are separate signals

Several reviewers can attach to one PR — Claude Code Review, Codex, Copilot, a human, CI — and they fail and succeed independently. On 2026-09-13, PR #926 and #927 each carried a Claude check at `neutral` (its review body: credit balance too low, review skipped) *and* a completed Codex review. Either one read alone gives the wrong answer about the other.

So report each surface you actually inspected, named, at the exact head SHA:

- check runs
- submitted PR reviews and their state
- inline review threads
- conversation comments
- requested reviewers

Never collapse them into "review passed" or "review failed". `AGENT_KERNEL.md`'s **Report the check, not the conclusion** already forbids a claim wider than its check; this is that rule applied to review surfaces, which is where several reviewers make it easy to breach by accident.

### What each status means

| Observed | Means | Does not mean |
|---|---|---|
| check conclusion `neutral`, body says review skipped / credits exhausted / quota | reviewer did not run — TOOL/ENVIRONMENT unavailable | not a pass, and not a fail |
| Codex "Code Review ✅ Completed" | that reviewer finished executing on the named SHA | not a GitHub approval |
| no inline comments, no review posted | no findings on the surfaces inspected | not a formal approval, and not proof the reviewer ran |
| green CI | the suites that ran, passed | not a code review — see the Lane model |

A formal approval exists only when a submitted review object has state `APPROVED`. As of 2026-09-13 none of PRs #920, #921, #922, #924, #925, #926 or #927 carried one, and `reviewDecision` was empty on all of them. If a report says "approved", name the review object.

Absence of a reviewer's own success marker is not its success. Codex documents that it reacts 👍 when reviews finish with no findings; on #926 and #927 that reaction was absent, so "completed, nothing posted" is what the evidence supports and "clean" is not.

### Four gates, kept apart

1. **Executable evidence** — tests, CI, runtime proof.
2. **Review evidence** — what a reviewer actually returned, per surface.
3. **Control-plane technical verdict** — bounded independent review of source, diff and evidence.
4. **Owner authorization** — Jason's explicit decision.

None substitutes for another. A reviewer or an audit lane recommends; only Jason or a delegate he names supplies acceptance.

### A reviewer that could not run is not a defect

Credits, quota, an outage, permissions or a broken integration are TOOL/ENVIRONMENT. Such a result does not indicate a source defect, does not erase another reviewer's completed findings, and does not by itself require re-running qualification tests. Say which reviewer was unavailable and why, and leave the other evidence standing on its own.

## Normal path

`request or approved work order -> inspect current source/open PRs -> bounded branch -> implement -> targeted proof -> CI -> review if warranted -> merge`

Agents without repository execution may still provide complete patches, files, tests, or findings. Their behavioral claims remain `UNVERIFIED` until applied to current source and executed by a repo-capable agent.
