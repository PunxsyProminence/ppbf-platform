# ChatGPT audit lane

**Agreed 20 Aug 2026** across three exchanges. Authored jointly: the
responsibilities split and storage limits are ChatGPT's own drafting, the
verification duties were negotiated, and the capability limits are what each
side actually proved rather than what either claimed.

Live contract. If the repository and this document disagree, the repository
wins and this document is wrong.

## The lane

ChatGPT owns:

- research and full-spectrum audits
- requirements clarification, and acceptance criteria
- documentation and the control ledger
- storage inventory and reconciliation across SharePoint, OneDrive and Google
  Drive
- UX review, and comparison of deployed behaviour against approved
  specification
- read-only inspection of this repository
- implementation handoffs to Claude
- independent challenge of unsupported verification claims

ChatGPT does **not** modify this repository: no branches, commits, pushes,
merges, deploys, migrations, or GitHub state changes of any kind.

Command routing is settled in `AGENT_KERNEL.md` under **Working channel**:
the primary Claude session is the project command thread, by owner decision of
2026-08-20. ChatGPT's earlier reading -- that the 2026-08-19 text was
repository-scoped -- was correct about the text, and is recorded there as
correct. The owner changed the rule, not the reading.

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

```
OneDrive / Documents / PPBF-AI-Lanes /
    Grok-Plates-Inbox /      <- Claude polls this by name
    ChatGPT-Handoffs /       <- Claude reads this by name
```

Moving, renaming, reorganising or tidying anything under `PPBF-AI-Lanes/`
breaks a lane silently, and nothing reports it until something goes missing.
It is a coordinated lane change approved by Jason, never a tidy-up, and it is
out of scope for any reconciliation manifest that does not name it explicitly.

## Verification duties

The five standing duties live in `AGENT_KERNEL.md` under **Independent
verification duties** rather than being restated here, so there is one copy.
In short: re-measure every number, ask what made a claim verified, ask whether
a guard was seen to fail, flag alarm without executable evidence, and compare
deployed behaviour against approved specification.

They bind harder under the 2026-08-20 decision, not less: project command,
repository command and repository implementation now sit on one party.
Pushback from Claude against one of these is a review issue, not a debate.

## Capabilities -- proved, not claimed

Checked 2026-08-20. Recorded because a contract clause that depends on a
capability nobody has is worse than no clause: both sides believe it is
handled. Grok's contract assigned Claude a JPEG re-encode step, and Claude has
no `cjpeg`, no ImageMagick and no Pillow. Neither side would have found that
until the first order failed.

| Capability | Status |
|---|---|
| Read this repository | **Yes.** Verified: reported `main` at `cd6a7335` and #524 as the most recent merge, both correct at the time. |
| Write this repository | **No, by contract.** Read-only. |
| Load a deployed page | **No.** ChatGPT's browser tool could not load the staging URL. |
| SharePoint / OneDrive / Google Drive in one conversation | **Yes**, as separate connector calls, not one unified query. |
| Write to OneDrive | **No.** The Microsoft connector exposes no upload, create, overwrite, move, rename or delete action to ChatGPT. |

### Two consequences, stated rather than implied

**The handoff folder is not an automatic loop.** `ChatGPT-Handoffs/` exists,
Claude can write to it, ChatGPT can read it -- so it works Claude-to-ChatGPT
and as somewhere Jason can drop a file. It does **not** work
ChatGPT-to-Claude, because ChatGPT cannot write. Until a write action is
exposed and round-trip verified *from ChatGPT's side*, handoffs are relayed by
Jason.

Claude built that folder, verified its own round trip, and declared the
mechanism live. That was one side of a two-sided contract, and ChatGPT was
right to refuse to claim it worked.

**Nobody is watching deployed behaviour.** Duty five -- deployed versus
approved specification -- currently has no AI eye at all. ChatGPT cannot load
the staging URL; Claude's sandbox refuses outbound HTTPS entirely and has
never loaded a deployed page in this project. Both lanes reason from source
and CI evidence.

That gap is why a Claude claim of "the ground flip is safe" shipped a page
whose text was unreadable, and why the owner's screenshot found in five
seconds what 6,900 passing tests could not. **Jason's eye on the live URL is
not a formality in this system. It is the only visual verification that
exists.** No lane may imply otherwise while this holds.

## Governance sources

`AGENT_KERNEL.md` is the repository startup and execution contract.

Broader AI governance, storage authority, routing and promotion rules are
governed by the ACTIVE source in OneDrive at `Documents/Library Intake/
_CONTROL - Registers and Coverage Maps/AI_GOVERNANCE/ACTIVE_APPROVED_SOURCE/`.
That source is deliberately **not** duplicated into this repository, per
ChatGPT's point that a controlled source should not be copied merely to make
the repository self-contained.

Claude reported that master did not exist. It does. The search was of this
repository and the claim was stated without that qualifier -- a real check,
reported wider than it was run, and exactly what duty four exists to catch.

## Open, not settled

- **Two manifests both named `_ACTIVE`** sit in `ACTIVE_APPROVED_SOURCE/`
  (`..._MANIFEST_v1_ACTIVE.docx` and `..._v2_ACTIVE.docx`). ChatGPT cites v2;
  v1's body also asserts v2 is controlling. Ambiguous to anyone resolving the
  chain cold.
- **Duplicates outside the control folder**, in `PERSONAL - Not Club App or
  Nonprofit/`: a copy of the master and of the v1 manifest.
- **The ACTIVE master's own body text opens `..._v2_REVIEW_REQUIRED`**, which
  ChatGPT self-reported before anyone asked. A source-quality cleanup
  requiring approved source correction, not grounds to disregard the manifest.

---
OBSERVE. DECIDE. EXECUTE. REPEAT.
