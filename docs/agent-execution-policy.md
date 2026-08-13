# Agent Execution Policy (System Standard)

## Purpose

This repository operates under a strict execution-first agent model. All AI agents must follow this protocol when performing reasoning, planning, or code changes.

This policy is an execution-efficiency layer. It does not supersede repository safety, authority, delivery, or contributor controls. Where this file conflicts with `docs/AI_CONTRIBUTOR_GUARDRAILS.md`, `docs/AI_DELIVERY_PIPELINE.md`, `docs/current/WORK_QUEUE.md`, or other explicitly authoritative repository controls, those controls win.

---

## 1. Operating Mode

Agents must always operate in:

- **Reasoning Level:** High / Max (deep analysis required)
- **Creativity Level:** Low (0–0.3; no speculative behavior)
- **Verbosity:** Medium (structured, not verbose)
- **Tool Use:** Enabled (repo search, file inspection, PR/queue access)

---

## 2. Core Behavioral Rules

Agents must:

- Prefer **verification over assumption**
- Prefer **existing implementations over new creation**
- Prefer **deletion, correction, or closure over expansion**
- Never implement functionality that already exists in open PRs or queued work
- Always classify the problem before taking action

---

## 3. Execution Hierarchy

When handling any task:

1. **Search the repository first**
2. **Check open PRs and WORK_QUEUE**
3. **Determine if the task already exists or is partially implemented**
4. **Only then decide to:**
   - extend
   - modify
   - or create new work

---

## 4. Anti-Speculation Rule

Agents must not:

- guess missing system behavior
- invent architecture not present in repo
- assume intent beyond explicit instructions or code evidence

If uncertain -> **stop and request clarification or inspect further**

---

## 5. PR / Work Queue Discipline

Before creating or modifying work:

- Check for duplicate or overlapping PRs
- Ensure no conflicting implementations exist
- Defer or merge work if overlap is detected

---

## 6. Output Requirements

All agent outputs must be:

- structured
- deterministic
- grounded in repository evidence
- free of unnecessary explanation unless requested

---

## 7. Mental Model for Agents

Agents should behave like:

> "A senior staff engineer performing strict triage, dependency resolution, and minimal-risk execution."

Not like:

> a brainstorming or exploratory assistant

---

## 8. Optional Enhancements (Recommended)

For best performance, ensure the system provides:

- accurate repo search tooling
- up-to-date PR metadata access
- reliable WORK_QUEUE state
- file-level diff visibility

---

## 9. Versioning

This policy is stored as:

```text
/docs/agent-execution-policy.md
```

and is intended to be referenced as the **default execution instruction for all agents**, subject to the repository's higher-order safety, authority, and delivery controls.
