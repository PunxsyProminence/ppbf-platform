# Cloud lane rules (App Overwatch, 2026-11-25)

Every cloud lane brief points here. App Overwatch keeps this file current; a lane brief adds only its own work item, held files and done-when. Jason's words quoted below are recorded in docs/current/OWNER_DECISIONS.md.

## How we talk (GitHub is the channel; you cannot message App Overwatch)
- App Overwatch is the Claude Code session on Jason's PC. It merges, applies migrations and deploys. You never merge, deploy, apply migrations, or touch any database, staging or production.
- Work in DRAFT PRs. Line 1 of every PR body: STATUS: WAITING-FOR-OVERWATCH | BUILDING | READY-FOR-MERGE-CHECK | BLOCKED. Update it whenever your state changes.
- Overwatch answers in PR comments that start "OVERWATCH:". A go reads "OVERWATCH: GO <scope>". Read the PR comments before every new step.
- 30-minute check (Jason 2026-11-24: "everyone should have a 30 min check, and if Ais have qestions they should post it and who they go to so that they can be answered"): check your PR about every 30 minutes while you have work open: STATUS line, OVERWATCH comments, bot reviews (Codex, claude), CI. If your session can schedule itself, do; if it cannot, say so once in your PR (CAN'T, with evidence) and App Overwatch's check wakes you.
- Every question is posted in your PR, first line "QUESTION FOR <App Overwatch | Jason>: <one line>", then official form (options, recommended first), plain English, and "Checked, not answered in: <sources>". A question for Jason is asked in your own lane (OD-2026-10-03-018); App Overwatch's check makes sure it reaches him and is not already ruled.
- Step 1 is a read-only plan in a draft PR: re-read your item's section of docs/content-review/w4-sizing/W4_SIZING.md on current main; each cited file:line re-checked; what has merged since the sizing (drop or adjust); the PR split with an allowlist and size per PR; files other open PRs hold; questions with the recommended option first. STATUS: WAITING-FOR-OVERWATCH. Then wait for "OVERWATCH: GO".
- After the GO: one build PR per step of your split, in order, each its own draft PR, unless Overwatch says otherwise.
- Done for each PR: CI green; reviewers clean (two adversarial reviewers, your own fresh-context subagents given this brief and the diff, for anything touching migrations, minors' data, sign-in, permissions or safety; one reviewer otherwise); Codex's review read and answered; the declaration block in the body; STATUS: READY-FOR-MERGE-CHECK.
- Declaration block: EVIDENCE LEVEL and VERDICT are each one bare enum value. SUBJECT is the full `git rev-parse HEAD`, never a padded short SHA. Write each field's text on the field line itself. Every PR body carries a `MIGRATIONS:` line: the migration names, or `MIGRATIONS: NONE` when there are none (omitting it is not read as NONE; AGENT_KERNEL.md).
- Do NOT edit docs/current/ACTIVE_WORK.md (Overwatch writes your row at merge).
- If main moves and your PR conflicts, merge origin/main in with a merge commit. Never rebase, amend or force-push anything you have pushed.
- Size: about 400 changed lines or fewer outside tests per PR. Split before building if bigger.
- A new shared file that pg suites reach must be registered in `scripts/ci-classify-paths.mjs` (PG_SUITE_DEPENDENCIES).
- Migrations: a new file under infra/azure/ with its runner, registered the way earlier migrations are. You never apply one.

## Collisions (Jason 2026-11-20: "no cap the only restiction is collision validate that the lane wont collide before starting")
- Several W4 lanes run at once. Overwatch checks the files W4_SIZING.md cites for each new lane against every running lane before starting it.
- Before you push each build PR, list its files and check them against the files of every open PR. Any shared file: do not push; post the overlap in your PR and wait for Overwatch.
- Exception, the three registration files every route or migration adds a line to (`apps/web/src/server/pilot/apiRouteInventory.json`, `apps/web/package.json`, `.github/workflows/apply-migrations.yml`): add your lines, merge origin/main in before READY-FOR-MERGE-CHECK, and keep both sides in any conflict.
- Customize the Gym drawers: W4-1's EM-6 and W4-6's SC-0b each add one. Whichever comes second waits until the first has merged.

## Rules
- PUBLIC repo: no email addresses, account IDs, secrets, member names or record details in code, PRs or comments.
- Jason's working rule (2026-11-19): "simple if you cant tie it to a source then ask questions". Anything you cannot tie to a ruling, the sizing file, a research file or the code goes to Overwatch as a question in the PR. Do not guess.
- Jason, OW27-16: "ok again validate that these question have not already been answered some of the drift and wasted resources have been answering questions slightly different or you asking them slightly different". Before any question, search docs/current/OWNER_DECISIONS.md, docs/research/, docs/content-review/w4-sizing/W4_SIZING.md, this brief and your PR's OVERWATCH comments, and write "Checked, not answered in: <sources>". Never re-ask in a slightly different form, and never re-ask what a picked option's own text answers.
- Labels: OBSERVED (read in code, with file:line), INFERRED, UNVERIFIED.
- Do not reverse a ruling. If you believe a ruling is wrong or blocks the task, put CONFLICT in the PR and stop that part.
- Minors: no new warnings, gates or disclaimers (Jason's L1 rule). An unknown date of birth is treated as a minor (OD-2026-10-04-010).
- No permission, role or gate change (`requireRole`, `requirePageRole`, `RoleSessionGate`, `allowedRoles`, every app/api/** permission line) unless your plan names it and Overwatch approves it.
- Use the code design system (`design-system/`). Floor pages keep the 55px tap floor and 19.1px text minimum.
- The medical-stop mark (`--locked`, red) is only for a medical stop (OW25-48 A). A pain report is not a medical stop (OD-2026-10-03-017).

## Stop conditions
- Building anything before Overwatch's GO.
- Editing a file another open PR touches (the registration-file exception aside).
- Any permission, role or gate change, or any migration, that your approved plan does not name.
- Anything another W4 item owns.
- A conflict with a ruling.
