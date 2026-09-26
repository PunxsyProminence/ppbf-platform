> **ARCHIVED 2026-09-21.** Verbatim text of `docs/CHATGPT-AUDIT-LANE.md` at `229842ebd45f0a23e3e4d06742a397d2df3408cb`, before it was
> condensed. History and provenance only: the current rules are in `docs/CHATGPT-AUDIT-LANE.md`.
> Do not preload. Everything below the line is unchanged.

---

# ChatGPT audit lane

**Agreed 20 Aug 2026** across three exchanges. Authored jointly: the
responsibilities split and storage limits are ChatGPT's own drafting, the
verification duties were negotiated, and the capability limits are what each
side actually proved rather than what either claimed.

Live contract. If the repository and this document disagree, the repository
wins and this document is wrong.

**Amendment (owner decision, 2026-09-21).** ChatGPT is now also the
**designer** (product and system specs, work orders; Jason approves a design
before it is built) and the **standards enforcer** (reviews). It stays
read-only on this repository. The primary Claude session is no longer the
project command thread; Claude is the builder. See `AGENT_KERNEL.md`, Working
channel, and OD-2026-09-21-001 in `docs/current/OWNER_DECISIONS.md`.

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
*[Superseded 2026-09-21: see the amendment at the top.]*

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
    Grok-Plates-Inbox /      <- provenance/archive drop (2026-08-24)
    ChatGPT-Handoffs /       <- Claude reads this by name
```

`Grok-Plates-Inbox` stopped being a transport hop on 2026-08-24: Grok commits
approved plate binaries straight to its own feature branch, and Claude no
longer polls the folder as a prerequisite for a visual PR. The folder is
retained for provenance and archive under the storage rules below, and it
stays inside the carve-out -- a lane folder that nothing currently polls is
exactly the kind of thing a tidy-up removes.

**Recorded 2026-08-25, because the 2026-08-24 wording made this sound like a
choice.** Claude does not poll that folder for binaries and could not use it if
it did: **there is no way to get file contents out of SharePoint or OneDrive
from Claude's environment.** The Microsoft 365 connector renders an image for
viewing rather than returning bytes, there is no download or unzip action, and
`downloadUrl` comes back null. A zip is completely inaccessible. So a drive
folder can hold an archive copy of a plate; it cannot be the route by which a
plate reaches the repository, and a handoff instructing Claude to fetch from
one is not a slow route but an inert one. Four delivery rounds were spent
before this was written down. The owner's 2026-08-25 ruling lifts the *policy*
ban on Claude carrying a binary -- it may accept and land one where Jason
directs -- and changes nothing about this capability.

An audit consequence, since this lane is the one that checks claims: a handoff
or PR whose completion step reads "Claude downloads from OneDrive and commits"
should be flagged on sight as unexecutable, the same way a contract clause
depending on a tool nobody has is flagged below.

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
*[2026-09-21: design and standards moved to ChatGPT, which splits that
concentration; the duties are unchanged.]*
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
| Write to OneDrive | **Yes -- observed 2026-09-21 (end of this row).** History: on 2026-08-24 the owner reported this as yes, not verified here at the time. The row read "No -- the Microsoft connector exposes no upload, create, overwrite, move, rename or delete action to ChatGPT". Owner decision 2026-08-24: the current tooling exposes controlled storage mutation actions, and any documentation saying ChatGPT categorically cannot write, move or rename in OneDrive is stale. At that time Claude had not observed a ChatGPT storage mutation and did not certify it -- this table's whole premise is "proved, not claimed", and the proof for this row belonged to ChatGPT's own round trip. The storage mutation limits below are unchanged and bind whatever the capability turns out to be. **Observed 2026-09-21:** ChatGPT wrote entry LEDGER-0010 into `PPBF-AI-Lanes/PPBF_DECISION_HANDOFF_LEDGER.md` and Claude read it back through the connector. |

**Claude's side of the same question, checked 2026-08-25 and recorded here
because this is the file that keeps capability truth.** This table is
ChatGPT's; the row that kept costing rounds is Claude's.

| Capability | Status |
|---|---|
| Claude reads a SharePoint/OneDrive item's *contents* | **No.** The connector renders an image for viewing and does not return file contents. No download action, no unzip, `downloadUrl` null. A zip is completely inaccessible. **2026-09-21, Claude on Jason's PC: text files yes** -- the connector's `read_resource` returned the ledger file's full text. Binary bytes not checked. |
| Claude lands a binary already reachable from its sandbox | **Yes**, and since the owner's 2026-08-25 ruling it may do so when directed. |
| Claude re-encodes a JPEG | **No.** No `cjpeg`, `jpegtran`, ImageMagick or Pillow. Bad plates are refused and named, not corrected. |

The second row is a policy change; the first and third are facts about the
environment that no ruling can move. Keeping them in one table is the point --
"Claude may carry the binary" and "Claude can obtain the binary" are different
sentences, and conflating them is what produced four failed plate-delivery
rounds. See `apps/web/public/plates/README.md` and `docs/GROK-VISUAL-LANE.md`
for the working routes.

### Two consequences, stated rather than implied

**The handoff loop -- round trip observed 2026-09-21 for the ledger file (end of this section).**
`ChatGPT-Handoffs/` exists, Claude can write to it, ChatGPT can read it -- so
it works Claude-to-ChatGPT and as somewhere Jason can drop a file. As written
on 2026-08-20 it did **not** work ChatGPT-to-Claude, because the connector
exposed ChatGPT no write action.

The owner's 2026-08-24 decision said that tooling limit was stale. From then
until 2026-09-21 the condition this paragraph set was the operative one:
until a write action was round-trip verified from ChatGPT's own side,
handoffs were relayed by Jason, and Claude had not observed that round trip.

**2026-09-21:** that round trip is now observed for the ledger file: ChatGPT
wrote an entry and Claude read it back.

Claude built that folder, verified its own round trip, and declared the
mechanism live. That was one side of a two-sided contract, and ChatGPT was
right to refuse to claim it worked.

**Deployed behaviour: current state (checked 2026-09-21).** Claude on
Jason's PC can load public deployed pages (`curl` HTTP 200; the desktop app's
browser pane loaded the site) and screenshot them. Signed-in pages still need
Jason, and no lane enters credentials. ChatGPT's 2026-08-20 limit stands: a
ChatGPT fetch of the public production page timed out on 2026-09-21 (REPORTED
by ChatGPT). See the capability update in `AGENT_KERNEL.md`.

**History (2026-08-20 to 2026-09-21).** In that period duty five -- deployed
versus approved specification -- had no AI instrument at all: ChatGPT could
not load the staging URL, and Claude's sandbox refused outbound HTTPS and had
never loaded a deployed page in this project. Both lanes reasoned from source
and CI evidence. That gap is why a Claude claim of "the ground flip is safe"
shipped a page whose text was unreadable, and why the owner's screenshot found
in five seconds what 6,900 passing tests could not. Jason's eye on the live URL
was then the only visual verification, and it remains the only one for
signed-in pages.

## Governance sources

`AGENT_KERNEL.md` is the repository startup and execution contract.

Broader AI governance, storage authority, routing and promotion rules are
governed by the ACTIVE source in the Admin@ OneDrive, at the drive root:
`Library Intake/_CONTROL - Registers and Coverage Maps/AI_GOVERNANCE/ACTIVE_APPROVED_SOURCE/`
(checked 2026-09-21).
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
  chain cold. *[Resolved 2026-09-21: v1 and v2 are renamed `_SUPERSEDED`;
  `2026-09-21_AI_GOVERNANCE_ACTIVE_SOURCE_MANIFEST_v3_ACTIVE.md` is active.]*
- **Duplicates outside the control folder**, in `PERSONAL - Not Club App or
  Nonprofit/`: a copy of the master and of the v1 manifest.
- **The ACTIVE master's own body text opens `..._v2_REVIEW_REQUIRED`**, which
  ChatGPT self-reported before anyone asked. A source-quality cleanup
  requiring approved source correction, not grounds to disregard the manifest.

---
OBSERVE. DECIDE. EXECUTE. REPEAT.
