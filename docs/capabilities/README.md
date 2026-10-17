# Capabilities

Where each capability question is answered (OD-2026-09-28-010):

- **Build status of a capability:** the module files in [`modules/`](modules/),
  and nowhere else (item 17). A module's `Status` row is its status; its audit
  log says who changed it and why.
- **Whether a person has tried it:** the module's `ManualVerification` row
  (`PENDING_SIGN_OFF`, `SIGNED_OFF` or `NOT_REQUIRED`), a separate question
  from build status. How to try each built, untried module:
  [`SIGN_OFF_WALKTHROUGH.md`](SIGN_OFF_WALKTHROUGH.md).
- **The approved product list:**
  [`PRODUCT_CAPABILITIES.json`](../../PRODUCT_CAPABILITIES.json).
  `PPBF_CAPABILITIES.json` at the repository root is an old draft, kept because
  scripts check that it exists (`health-check.ps1`,
  `scripts/check-governance.ps1`, `scripts/health-check.ps1`,
  `scripts/quick-reference.ps1`) and `packages/governance/featureFlags.ts`
  imports it.
- **Gates enforced in code:** [`GATES.md`](GATES.md) (pinned to the commit it
  names).
- **History, not status:** the 200-row tracker CSV and index JSON, the
  2026-08-18 network status log and this file's 2026-08-03 analysis, all under
  [`docs/archive/2026-10-16/capabilities/`](../archive/2026-10-16/capabilities/).

## Status: one of four, and it matches the code

Jason, 2026-10-16: "Fix capability-status truth: DONE, mapped, claimed/no-code,
DRAFT. These need to be unambiguous." Vocabulary set 2026-10-16 (lane L32,
Overwatch's ruling on its four questions).

Each module's header table carries:

| Row | Holds |
|---|---|
| `Status` | Exactly one of the four tokens below, nothing else |
| `Status note` | Optional prose about the status (the old label is kept here) |
| `Code` | Repository-relative paths that serve the capability, or `none` |
| `Tests` | Repository-relative test files for that code, or `none` |

| Status | Meaning |
|---|---|
| **DONE** | The module's slice is on main: `Code` names an existing `route.ts` or `page.tsx` (a role can reach it) and `Tests` names an existing test |
| **MAPPED** | Existing code serves the capability, wholly or in part, but it is not DONE (no way in for a role, no test, or only part of the slice) |
| **CLAIMED-NO-CODE** | It was recorded DONE and no code serves it. It stays until Jason walks it through (OD-2026-09-28-010 item 18) |
| **DRAFT** | Designed or stubbed; no code |

`scripts/check-capability-status.mjs` checks every module on every pull
request, documentation-only ones included (it runs ahead of ci.yml's
docs-only fast path). Only the `Status`, `Code` and `Tests` rows count;
prose and audit-log history are not evidence. It refuses a status outside the
four, a DONE without an existing entry point and test, a MAPPED without code, a
DRAFT or CLAIMED-NO-CODE that cites code, a CLAIMED-NO-CODE outside the item-18
list, and any cited path that does not exist. `apps/web/src/docs/capabilityStatus.test.ts`
proves each refusal.

**What it does not say.** A cited file existing is not a working feature, and a
DONE is not a statement that a coach can use it on the gym tablet. That is what
`ManualVerification` and a signed-in person are for.

**Changing a status.** Edit the four rows and add an audit-log line with the
reason. To move a module off CLAIMED-NO-CODE because code landed, cite the code;
a module goes on that list only under item 18 (recorded DONE, no code found).

`Active` stays `false` in every module file until promotion review
([`CAPABILITY_BUILD_PLAYBOOK.md`](CAPABILITY_BUILD_PLAYBOOK.md)); never
bulk-activate.
