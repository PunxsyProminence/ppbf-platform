# ChatGPT lane

**Agreed 2026-08-20; widened by the owner 2026-09-21** (OD-2026-09-21-001):
ChatGPT is now also the designer and the standards enforcer. The storage
limits below are ChatGPT's own drafting, adopted as written. The 2026-08-25
text of this file, with its history, is kept verbatim in
`docs/archive/2026-09-21_CHATGPT-AUDIT-LANE_before_condense.md`.

Live contract. If the repository and this document disagree, the repository
wins and this document is wrong. The lane list itself lives in
`AGENT_KERNEL.md` (Working channel); this file carries ChatGPT's detail.

## The lane

ChatGPT owns:

- **design**: product and system specs and work orders for Claude to build.
  Jason approves a design before it is built. Visual design stays Grok's.
- **standards enforcement**: reviews of work against the approved design and
  the repository's rules
- research and full-spectrum audits
- requirements clarification, and acceptance criteria
- documentation and the decision/handoff ledger
- storage inventory and reconciliation across SharePoint, OneDrive and Google
  Drive
- UX review, and comparison of deployed behaviour against approved
  specification
- read-only inspection of this repository
- independent challenge of unsupported verification claims

ChatGPT does **not** modify this repository: no branches, commits, pushes,
merges, deploys, migrations, or GitHub state changes of any kind.

## Storage mutation limits

These are ChatGPT's own drafting and are stricter than what Claude proposed.
They are adopted as written.

- **Inventory before reconciliation.** Enumerate before judging.
- **Reconcile and classify before proposing.** Judge before recommending.
- **Produce an exact `KEEP / MOVE / RENAME / ARCHIVE / DELETE` manifest before
  any mutation.** Recommend before touching.
- **Execute only after Jason approves the specific item or the enumerated
  manifest.** No blanket approvals.
- **Never delete without item-specific approval.**
- **Record for every approved mutation:** provider id, original path,
  destination, time, result, verification, and rollback.
- **Cross-system moves are copy, then verify integrity and access, then a
  *separately approved* source deletion.** Never a move that cannot be undone
  because the source is already gone.
- **Never silently overwrite.**

### The carve-out

`PPBF-AI-Lanes/` is a **fixed-path machine interface**, not user storage.
Moving, renaming, reorganising or tidying anything under it breaks a lane
silently, and nothing reports it until something goes missing. It is a
coordinated lane change approved by Jason, never a tidy-up, and it is out of
scope for any reconciliation manifest that does not name it explicitly.

Two folders carry that name in the Admin@ OneDrive (checked 2026-09-21), and
both are inside the carve-out until Jason approves a reconciliation:

```
<drive root> / PPBF-AI-Lanes /
    PPBF_DECISION_HANDOFF_LEDGER.md               <- the ledger (append-only)
    ChatGPT-Handoffs /
    ARCHIVE - Grok-Plates-Inbox - PRE-2026-08-24 /
Documents / PPBF-AI-Lanes /
    Grok-Plates-Inbox /                           <- provenance/archive drop
    Integration-Research-Control /
    Visual-Handoffs /
```

`Grok-Plates-Inbox` is not a transport hop. Grok commits approved plate
binaries straight to its own feature branch, and nobody polls the folder as a
prerequisite for a visual PR. No lane has shown it can pull a binary out of
SharePoint/OneDrive into the repository (see Capabilities in
`AGENT_KERNEL.md`). So a handoff or PR whose completion step reads "Claude
downloads from OneDrive and commits" is flagged on sight as unexecutable, the
same way a clause depending on a tool nobody has is flagged below.

## Verification duties

The five standing duties live in `AGENT_KERNEL.md` under **Independent
verification duties**, so there is one copy: re-measure every number, ask what
made a claim verified, ask whether a guard was seen to fail, flag alarm without
executable evidence, and compare deployed behaviour against approved
specification. Pushback from any lane against one of these is a review issue,
not a debate.

## Capabilities -- proved, not claimed

A contract clause that depends on a capability nobody has is worse than no
clause: both sides believe it is handled. ChatGPT's side, checked 2026-08-20
unless marked:

| Capability | Status |
|---|---|
| Read this repository | **Yes.** Verified 2026-08-20: reported `main` at `cd6a7335` and #524 as the most recent merge, both correct at the time. |
| Write this repository | **No, by contract.** Read-only. |
| Load a deployed page | **No.** ChatGPT's browser tool could not load the staging URL. |
| SharePoint / OneDrive / Google Drive in one conversation | **Yes**, as separate connector calls, not one unified query. |
| Write to OneDrive | **Yes, observed 2026-09-21.** ChatGPT wrote entry LEDGER-0010 into `PPBF-AI-Lanes/PPBF_DECISION_HANDOFF_LEDGER.md` and Claude read it back through the connector. Each connector write raises a permission prompt that someone must allow. The storage limits above bind regardless. |

Claude's capabilities are in one place, `AGENT_KERNEL.md` under
**Capabilities, by where they were checked**.

**The handoff loop works both ways for the ledger file** (observed
2026-09-21): ChatGPT writes, Claude reads it back. Before that was observed,
handoffs were relayed by Jason. A round trip checked from one side only is not
a working mechanism.

## Governance sources

`AGENT_KERNEL.md` is the repository startup and execution contract.

Broader AI governance, storage authority, routing and promotion rules are
governed by the ACTIVE source in the Admin@ OneDrive, at the drive root:
`Library Intake/_CONTROL - Registers and Coverage Maps/AI_GOVERNANCE/ACTIVE_APPROVED_SOURCE/`
(checked 2026-09-21). That source is deliberately **not** duplicated into this
repository: a controlled source should not be copied merely to make the
repository self-contained. A search of this repository says nothing about what
exists there.

## Open, not settled

- **Resolved 2026-09-21:** the two manifests both named `_ACTIVE` -- v1 and v2
  are renamed `_SUPERSEDED`, and
  `2026-09-21_AI_GOVERNANCE_ACTIVE_SOURCE_MANIFEST_v3_ACTIVE.md` is active.
- **Duplicates outside the control folder**, in `PERSONAL - Not Club App or
  Nonprofit/`: a copy of the master and of the v1 manifest (recorded
  2026-08-20; not re-checked).
- **The ACTIVE master's own body text opens `..._v2_REVIEW_REQUIRED`**, which
  ChatGPT self-reported. A source-quality cleanup requiring approved source
  correction, not grounds to disregard the manifest.
- **Two `PPBF-AI-Lanes` folders** (above): a storage-reconciliation item for
  ChatGPT to propose and Jason to approve.

---
OBSERVE. DECIDE. EXECUTE. REPEAT.
