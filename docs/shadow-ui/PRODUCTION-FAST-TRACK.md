# PRODUCTION FAST TRACK — P0 to deployed production
**For:** Claude Code in VS Code · Jason reviews **only on live URL**  
**Date:** 19 Aug 2026  
**Tagline:** OBSERVE. DECIDE. EXECUTE. REPEAT.

## Goal
Ship **P0.1–P0.6** to **deployed production**. No mid-loop Jason mock reviews.

## Branch
`p0-production`

## Scope (ONLY this)
| # | Surface | Pass criteria |
|---|---------|----------------|
| P0.1 | The Bell login | Microsoft / Email link / PIN real fields; exact errors; WAIT **brass** not medical-red theater |
| P0.2 | Shadow DENY | Title + body + **Dashboard** + **Logout** only — no library, no mode badge, no chat, no Master Mode |
| P0.3 | Shadow ALLOWED | Scout / Architect / Omega **labels only** — no Master Mode toggle |
| P0.4 | Training Hold | **Brass**, path back, non-punitive |
| P0.5 | Escalations | **Red only** on critical severity; empty copy exact where coded |
| P0.6 | Role landings | `pilotRoleRouting` correct destinations |

**Out of scope:** full catalog polish, new features, Floor Card data model, more AF art, Master Mode.

## Room DNA (no two rooms alike)
| Room | Feel | Eggs |
|------|------|------|
| office | desk, roster, forms | chalk OK |
| floor | brick, train, coach | primary eggs |
| board | formal, aggregate | NEVER + no SHADOW chat |
| file | cork, evidence | NEVER |
| clinic | green-cool care | NEVER; brass holds |
| night | dark SHADOW machine | never on deny |

## Rules
1. Real `ppbf.css` / design-system symbols — mocks are north star only
   (mocks live in Drive: Claude-Instructions / AF set)  
2. Do **not** wait for Jason between P0 items  
3. Do **not** expand past P0  
4. Build must pass (lint/typecheck/test if present)  
5. Staging smoke before production promote  

## Pipeline
1. Create/use branch `p0-production`  
2. Implement P0.1 → P0.6 completely  
3. Build green  
4. Deploy **staging** → smoke click path  
5. Fix until smoke passes  
6. Open PR → merge to `main` with green CI. **That is `MERGED`, and nothing
   more.**  
7. Reply: `READY FOR STAGING` + the staging URL + the click path, and hand the
   release to Jason. Production is his instruction, not this file's step 8.  

**Corrected 2026-08-22 — steps 6 and 7 used to read "Open PR → merge to main
(or prod branch) for PRODUCTION" and "Reply: READY FOR PRODUCTION".** Both were
false, and this is the file `CLAUDE.md` routes every P0-production ticket into,
so a session that followed it merged, reported production shipped, and had in
fact staged nothing, captured no release digest, applied no migration, and
never reached the owner's approval.

`.github/workflows/deploy-production.yml` is `workflow_dispatch:` only. It
carries no `push:` trigger, there is no prod branch, and its `guard` job
refuses any ref that is not `refs/heads/main` — its first `guard` step, which
errors with "This workflow may only be dispatched from refs/heads/main".
**Merging to `main` deploys nothing.**

### The real path to production

[`docs/AI_DELIVERY_PIPELINE.md`](../AI_DELIVERY_PIPELINE.md) is the authority
and it governs the whole of this. The shape, so nobody reads step 6 above and
improvises the rest:

1. Apply the required migrations through
   [`apply-migrations.yml`](../../.github/workflows/apply-migrations.yml),
   **staging first**. Never from a laptop and never from an AI shell.
2. Dispatch [`deploy-staging.yml`](../../.github/workflows/deploy-staging.yml)
   for the exact SHA, and **capture the immutable `sha256:` image digest it
   produces**. There is no production deployment without that digest — the
   production workflow takes it as a required input and validates its shape.
3. Verify staging: revision, traffic, smoke checks, and the P0 click path above.
4. Return the `RELEASE READY` packet and **stop**. Promotion is a separate
   explicit instruction from Jason.
5. On that instruction: apply the production migrations through
   `apply-migrations.yml` and verify the run, then dispatch
   `deploy-production.yml` from `main` with `confirm_sha` (the exact prepared
   SHA), `release_digest` (the exact staged digest), `migrations_complete:
   CONFIRMED`, `allow_rollback: NO`. Never type `CONFIRMED` from assumption or
   from a merged `.sql` file alone — the workflow's own header says that input
   is an operator attestation, not a check against the database.
6. GitHub halts at the protected `production` environment for Jason's approval.
   **No AI approves that gate.**

`MERGED`, `CI_VERIFIED`, `STAGED`, `PRODUCTION_DEPLOYED` and
`PRODUCTION_RUNTIME_VERIFIED` are five distinct claims. Do not infer a later one
from an earlier one, and do not report this ticket as shipped on the strength of
a merge.

## Smoke path (staging then prod)
1. `/` loads  
2. `/login` Bell — one method works; one error path visible  
3. Role lands correctly  
4. Non-privileged `/shadow` → deny minimal only  
5. Coach `/shadow` → labels only, no Master Mode toggle  
6. Logout works  

## Production definition of done
- [ ] `deploy-production` completed for the exact SHA and the exact staged
      digest, after Jason approved the protected `production` environment
      (**corrected 2026-08-22** — this line used to read "Merged to production",
      which describes nothing this repository does)  
- [ ] Production URL loads  
- [ ] Login works  
- [ ] Shadow deny minimal  
- [ ] Shadow allowed sane  
- [ ] Role landings sane  
- [ ] Jason can click on phone/laptop  

## Rollback — escalate, never decide

**Corrected 2026-08-22.** This section used to be a decision tree handed to the
agent — "Rollback only if: nobody can log in / wrong people see athlete
medical or chat / data corruption". That framing put the call in the wrong
hands. [`docs/AI_DELIVERY_PIPELINE.md`](../AI_DELIVERY_PIPELINE.md) is explicit:
**no AI may authorize a rollback**, and a rollback requires Jason's explicit
authorization plus a known prior SHA and digest before `allow_rollback: YES` is
dispatched.

The three conditions survive as **what you escalate on, not what you decide on**:

- Nobody can log in  
- Wrong people see athlete medical/chat  
- Data corruption  

On seeing one: stop, preserve the failure evidence, read back the SHA and digest
production is actually running, and hand Jason a rollback packet naming the
prior SHA and digest to return to. Then wait.

**Not escalations at all:** spacing, missing eggs, PLANNED pages. Those are
notes for the next PR.

## Jason
Reviews **only after** production (or staging if merge needs his click). Notes → next PR, not block ship.

## Related docs in repo
- `docs/shadow-ui/ROOM-PURPOSE-DNA.md`
- `docs/shadow-ui/P0-LIVE-SHOT-AND-ROOMS.md`
- `docs/shadow-ui/EGGS-LOAD-FIRST-12.md`
- `docs/shadow-ui/PRODUCTION-FAST-TRACK.md` (this file)
