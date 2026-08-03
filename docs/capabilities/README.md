# The 200-module capability backlog

What these files are, what their statuses actually mean, and three things to fix
about how they are maintained.

Written when this tree was brought into version control on 2026-08-03. It had
been produced by a PowerShell wave process running outside git, so nothing here
had a history and none of it had been read by anyone else.

---

## Nothing in the running application reads any of this

Checked before anything else, because it is the question that decides how much
the rest matters: a repo-wide search for `expanded-200-backlog`,
`expanded-200-index` and `PPBF_CAPABILITIES` finds **no consumer in
`apps/web`**. These are planning artifacts. A row marked `DONE` here changes
nothing a coach, athlete or board member sees.

That matters because the owner's standing rule is that fake data must be gone
before real athletes are onboarded, and a 200-row table with 19 modules marked
DONE would be a serious truth-on-screen problem *if* a console rendered it. No
console does. `Active` is `false` on every row, and `PPBF_CAPABILITIES.json`
governance stays off.

**If anything is ever wired to read these files, this section stops being true**
and the statuses below need to be re-read as claims a user will see.

---

## What DONE means here, and what it does not

`DONE` in this backlog overwhelmingly means **"this capability is already served
by code that exists"** — the mapping exercise — and not "this wave built it."
That is legitimate and useful work. It is also easy to misread six months from
now, so it is worth being exact.

Spot-checked against the codebase:

| Module | Claim | What is actually there |
|---|---|---|
| 194 Red Flag Escalation | DONE | Real: `app/api/pilot/compliance/escalate/` with a test |
| 200 Privacy-Tier | DONE | Real: `src/server/pilot/access.ts` role tiers |
| 151 Consent / Waiver | DONE | Partly: `pilot.waivers` exists in the base schema, and intake domain APIs touch consent |
| 152 Incident Report | DONE | Mapped, not built: no incident table or route; it rests on treating `pilot.compliance_violations` as the incident record |
| 147 Board Reporting | DONE | Mapped: the existing board summary + compliance summary, explicitly "not a second parallel report stack" |

None of those are wrong. But `DONE` is carrying two different meanings, and the
one it carries most often is *mapped*.

**A known contradiction.** `docs/FIX_LIST_2026-08-02.md` lists **"Consent
capture — build it, or decide on paper and write that down"** as an open owner
decision. This backlog marks 151 Consent / Waiver as DONE. Both cannot be true.
The likely resolution is that `pilot.waivers` exists as a table and no flow
writes to it, which would make the fix list right and the backlog optimistic —
but that has not been traced, and nobody should act on either until it is.

---

## Three defects in how this is maintained

### 1. Marking a module DONE destroyed its own checklist

The wave process wrote each module stub twice: once on `IN_PROGRESS` with
Intent, Boundaries, Vertical slice and a manual Checklist, and again on `DONE`
with `Set-Content` — which **replaces** a file rather than appending to it. So
every DONE stub lost the four sections that explained what the module was and
how to verify it.

`ManualVerification: PENDING_SIGN_OFF` on 19 modules refers to a checklist that
no longer existed on any of them. Nobody could have signed off, because there
was nothing left to sign off against.

The six Wave 2/3 stubs whose content was recoverable (147-152) have been
restored here from the operator's terminal scrollback. Wave 1's stubs kept a
one-line "Vertical slice completed" and are thinner but not empty; they were
left as they are rather than reconstructed from memory.

**Fix for next time:** append to the stub on completion, or write the status
table to a separate line and leave the body alone. Never `Set-Content` a file
whose current contents you have not read.

### 2. Zero of 19 are actually verified

`Status: DONE` and `ManualVerification: PASSED` are independent, which is a good
design. But the counts are `DONE: 19` and `PASSED: 0` — every module is closed
and none is verified. The status reports say so honestly
(`| ManualVerification PASSED | 0 |`), which is to their credit.

Until a human runs the checklists, the accurate summary of this backlog is
**"19 modules mapped, none verified"**, not "19 modules done."

### 3. The work log records the plan and not the finding

`work/NNN-*-IN_PROGRESS.md` holds a useful Search/Do plan. The matching
`-DONE.md` is four lines and says only that it closed. So the exercise's most
valuable output — *which endpoints and tables a module actually maps to* — was
never written down anywhere that survives.

That is the difference between a mapping someone can rely on and a checkbox.
For 152, for instance, the interesting fact is "this is `compliance_violations`
under another name" — which is exactly the kind of judgement a reader six months
from now needs and cannot reconstruct.

**Fix for next time:** the DONE note should name the files. One line, e.g.
`maps to: app/api/pilot/compliance/escalate/route.ts, pilot.compliance_violations`.

---

## Reading the CSV

`expanded-200-backlog.csv` is the source of truth for status; the module stubs
mirror it. As of this commit:

| Status | Count |
|---|---|
| DRAFT | 178 |
| DONE | 19 |
| QUEUED | 2 |
| IN_PROGRESS | 1 |

`Active` is `false` on all 200. `PromotionRequired` gates anything becoming
live. Neither should be flipped from this backlog — promotion is a separate,
deliberate act.
