# Lane GD step 1: content import and export guards (read-only plan)

Snapshot of the step-1 plan, the same as the draft PR's body when it was opened. The PR body is the live
copy: answers and later changes land there. Nothing in this file is built.

- Read on `main` at `244c13d20becf1ee7024771e449fb430a624a520` (#2023). Paths are under `apps/web/` unless
  shown.
- Labels: OBSERVED (read in code, file:line), INFERRED, UNVERIFIED.
- Held DOC-136 records are referred to by count only.

## 1. The five items on main

| Item | On main | Verdict | PR |
|---|---|---|---|
| 1. Session scripts get no in-app-edit hold | The importer's script engine sets no `inAppEditAuditEntity` (`src/server/pilot/contentImport/datasets/sessionScripts.ts:39-62`), so `inAppEditedHeads` checks labels only (`contentImport/inAppEdits.ts:134-135`), and a script edit writes no in-app label. `editSessionScript` edits in place when the script has no run (`sessionScriptAuthoring.ts:474-499`), else writes v(n+1) (:500-551). Either way it writes an audit row, `entity_type 'session_script'`, `entity_id` = the current version's id, details `{name, version, outcome: 'updated' or 'new_version', edited_script_id, ...}` (:554-571), in the same transaction. It carries no `action: 'in_app_edit'`, which is what the audit check matches (`inAppEdits.ts:138-144`). A package that revises an edited script therefore plans `new_version` over the coach's text (`templateScriptVersions.ts:665-680`). | STILL PRESENT | GD-4 |
| 2. A Backbone re-export puts back replaced or held text | See section 2. | STILL PRESENT | GD-3 |
| 3. A package made before NW-b blanks two fields | `exit_condition` and `correction_path` are optional columns (`contentImport/specs/drills.ts:63-64`; the header check covers required columns only, `validate.ts:146-151`). A column missing from the header reads as `''` (`validate.ts:159`, `values.ts:7-11`). Only label columns keep the stored value when the header leaves them out (`datasets/drills.ts:377-378`, `withStoredLabels`). So an old package re-imported over a drill that holds either field hashes differently from the head and plans `new_version` with both fields blank. Apply writes from that same row (`drills.ts:578`). Main's committed seed fills one or both fields on 19 drills (NW-b, #1976), so a re-run of a pre-NW-b drill package would plan those 19 as new versions with both fields blank (INFERRED from the hash path). | STILL PRESENT | GD-2 |
| 4. Test flake | `runCli` decodes each stdout and stderr chunk on its own (`src/server/pilot/contentImportEngine.pg.test.ts:855-856`, `chunk.toString()`). A multi-byte character split across two chunks decodes as two replacement characters, so the `plan` and `--dry-run` blocks compared at :909 can differ. That #2008's CI run failed this way is UNVERIFIED: neither #2008's body nor its comments mention it. | STILL PRESENT | GD-1 |
| 5. ED-1: an import writes v(n+2) over an edited drill | Closed for drills and templates. Both edit paths write an `action: 'in_app_edit'` audit row and in-app labels (`drillLibraryEdit.ts:485`, `workoutTemplateEdit.ts:433`). The importer checks drills (`datasets/drills.ts:357-365`, entity `drill_library`) and templates (`datasets/templates.ts:54`, entity `workout_template`). IG's pg suite covers drills from a root file, a child file and the audit row alone, templates from a root file and items alone, and dependents (`contentImportInAppEdits.pg.test.ts:388-627`; case names read, suite not run here). A grep of `src` and `app` for `into pilot.<content table>` outside `contentImport/` finds no other in-app writer of drill or template rows: only those two edit modules, plus script authoring and script runs. The "Looks right" press and its detection are #2027's own. | DROPPED (closed by IG, #1977) | none |

## 2. Item 2: what each exporter writes, and where held or replaced text could re-enter

Each exporter takes a frozen Backbone folder and `--out` (default `seed-data`) and rewrites whole CSV files after an
in-memory merge. A refusal throws before the write loop, so a refused run writes nothing (OBSERVED, e.g.
`backbone-export-youth-recreational.mjs:609-615` before `:669`).

| Exporter | Writes (under `seed-data/`) | Guard today |
|---|---|---|
| ft1-track | drill library, cues, stop rules; workout templates and items; tracks, blocks, block sessions (8 files, `:532-541`) | All columns compared; `--allow-overwrite` writes anyway (`:542-550`) |
| drill-library | drill library, cues, stop rules; `--fill-columns` writes only the two NW-b cells | ft1's guard (`:253-261`); `--fill-columns` refuses a conflicting cell and refuses `--allow-overwrite` (`:355`) |
| youth-recreational | workout templates and items; tracks, blocks, block sessions; the one session script and its blocks (7 files, `:166-176`) | A committed non-blank cell that changes, or a committed row that goes (`:514-530`); `--allow-overwrite` writes anyway (`:609-615`) |
| amateur-pro | workout templates and items; tracks, blocks, block sessions (5 files) | youth-recreational's guard (`:61-66`, `:555-561`) |
| assessment-catalog | 9 catalog files | Changed committed rows (`:576-590`, `:684-685`) |
| pathway-catalog | 3 catalog files, whole-file overwrite | None (`parseArgs` `:417-431` takes only `--out`) |

**Typed template lines (TL, after the pilot; OD-2026-11-19-030 "B: Turn typed lines into library drills";
OD-2026-11-20-001 OW27-09 "B: A new drill for every line").**
- Three exporters write template items and copy `drill_id` and `free_text_drill` from the Backbone as they are:
  ft1-track `:353-360`, youth-recreational `:363-381`, amateur-pro `:403-421`. A typed line is an item with a
  blank `drill_id`.
- TL converts a step by setting its `drill_id` and clearing `free_text_drill`
  (`docs/content-review/w4-sizing/W4_SIZING.md:852-856`). The 11 mixed templates
  (`committedTemplateIssueSweep.test.ts:315-327`) are 10 youth-recreational and 1 amateur-pro by stage keys
  (INFERRED, measured by script).
- A plain re-run after a conversion refuses (a committed non-blank `drill_id` would change). `--allow-overwrite`
  writes the typed line back over the drill link. That is the re-entry path.

**Held DOC-136 text (OW25-49 (c), OD-2026-11-19-005).**
- Only youth-recreational has a held list: 6 templates, 42 items, left out of the export (`:82-89`, `:331-337`).
- Its frozen tracks still name them. A track's `groups` and `session_refs` are copied into `details` as text
  (`:115-117`; the comment at `:81` says such a reference "stays as text"), and its `sources` carry DOC-136
  source lines.
- Lane HW (#1980) removed that text from one committed track row. Before HW, the row held 12 occurrences of
  the held ids and 18 DOC-136 strings, all in `sources`, `details` and `field_labels` (measured by script on
  HW's diff). At HEAD, `seed-data/` holds none of either (grep).
- A plain re-run refuses on that row: the skipped frozen-Backbone test expects exactly that,
  `backbone-export-youth-recreational.test.ts:444-457`. `--allow-overwrite` writes the held text back.
  That is the re-entry path.
- Block sessions are already safe: a block's session_ref to a template outside the export stops the run
  (`:447`).
- The other five exporters have no held list. None of their committed outputs holds a held id or the DOC-136
  key (grep of `seed-data/` at HEAD). Their frozen inputs cannot be read from this container, so whether those
  inputs carry DOC-136 text is UNVERIFIED.

**The stops (GD-3), each modelled on the existing OVERWRITE GUARD.** Each names the file, the row and the
column, and writes nothing.
- **Typed-line stop** (ft1-track, youth-recreational, amateur-pro, in each `put` for the items file):
  - a committed template item that links a drill (non-blank `drill_id`) must not be written back with a blank
    `drill_id`, or dropped, by the export;
  - message form: `refused: ... <file> template <id>: item <item id> links drill <drill id>; the export would
    write it back as a typed line. Nothing was written.`
- **Held-text stop** (all six exporters, on every row the run writes new or replaces, before the write loop):
  - a cell holding a held template id, or the DOC-136 source key, stops the run;
  - message form: `refused: ... <file> <row id>: <column> names a held DOC-136 record. Nothing was written.`
    The message names no held id and no text, only where.
  - The six held ids are stored in the new check as sha256 prefixes, not as ids, and a test ties them to
    youth-recreational's list without printing them. So the PR adds no held id to the repo.
- Neither stop can be overridden by `--allow-overwrite` (Q2 A); `--allow-overwrite` keeps working for every
  other cell.
- With the held-text stop in place, youth-recreational's committed-seed test stops allowing held ids in track
  text (`backbone-export-youth-recreational.test.ts:405-411`) and asserts that no committed seed file holds
  one. The `:81` comment is corrected.
- This retires lane YR's earlier "a reference stays as text" (Overwatch's option B) for written text. It rests
  on this brief, OW25-49 (c) and HW's removal.

## 3. Item 1 design (GD-4): how the importer knows a script was edited in the app

**No migration.** The audit row every script edit already writes, in the same transaction as the edit
(`sessionScriptAuthoring.ts:554-571`), is the record. Its `entity_id` is the current version's id in both
paths:
- in place, the same `script_id`;
- a new version, the new `script_id`.

So IG's check (b) "an edit event on the current version's id" fits scripts without a label.

**Change:**
- `datasets/sessionScripts.ts` sets `inAppEditAuditEntity: 'session_script'`.
- `inAppEditedHeads` (`inAppEdits.ts`, held by #2027) also accepts, for that entity, the detail key the script
  edit path writes: `edited_script_id`. With Q1 A it also accepts `template_id`, which marks a script made from
  a template in the app (`sessionScriptAuthoring.ts:306-322`).
- `templateScriptVersions.ts` passes that through (about 2 lines).
- Existing script edit rows, which have no `action` key, are caught the same way.

**Not counted as an edit:** retire, bring back and "reviewed" (`:642-659`, `:704-720`). They change
`authoring_state`, which is lifecycle and outside the content hash (`datasets/sessionScripts.ts:22-33`).

**Outcome, the same as IG's for drills and templates:**
- the script is `held` (`in_app_edit`), nothing is written, and the plan, dry run and admin page say why
  (`heldReason`, `app/admin/content-import/page.tsx:555`);
- no override;
- the rest of the package loads;
- a kept script's steps already count for `drill_contact_below_steps` (`plan.ts:165-169` includes
  `session-scripts`).

## 4. PR split, allowlists, sizes (INFERRED sizes, changed lines outside tests)

| PR | Item | Allowlist | Size |
|---|---|---|---|
| **GD-1** | 4 | `src/server/pilot/contentImportEngine.pg.test.ts` (`setEncoding('utf8')` on both streams; `+= chunk`) | 2-4 test lines |
| **GD-2** | 3 | `src/server/pilot/contentImport/datasets/drills.ts`; `src/server/pilot/contentImportDrills.pg.test.ts`; `docs/CONTENT_PACKAGE_CONTRACT.md` (one load-rule bullet) | ~15 + doc; tests ~70 |
| **GD-3** | 2 | `scripts/lib/backbone-export-guards.mjs` (new) and `.test.ts` (new); the six `scripts/backbone-export-*.mjs` and their six `.test.ts` | ~130; tests ~250 |
| **GD-4** | 1 | `src/server/pilot/contentImport/inAppEdits.ts` (held, #2027); `src/server/pilot/contentImport/datasets/sessionScripts.ts`; `src/server/pilot/contentImport/datasets/templateScriptVersions.ts`; `src/server/pilot/contentImportInAppEdits.pg.test.ts`; `docs/CONTENT_PACKAGE_CONTRACT.md` (`:91-92`, "Session scripts get no in-app-edit guard") | ~20 + doc; tests ~150 |

**Order.**
- GD-1, GD-2 and GD-3 first. They share no file.
- GD-4 after #2027 merges (Overwatch says so) and after GD-2 merges (both edit the contract doc).

**Constraints kept.**
- No new `.pg.test.ts` file: new cases go into existing suites. A new suite needs an `apps/web/package.json`
  line, and seven open dependabot PRs (#1992, #1993, #1995, #1996, #1998, #1999, #2000) touch that file.
- No new file that pg suites reach, so no `scripts/ci-classify-paths.mjs` edit (#2032 touches it). The new
  `scripts/lib/backbone-export-guards.mjs` is reached by unit tests only.
- No migration. No permission, role or gate change. No `app/api/**` change.

**Proof per PR.**
- Each guard gets a test that fails without it, seen to fail.
  - GD-2: the old-shape package plans the filled drills as unchanged; a revision keeps both fields.
  - GD-3: a converted item with `--allow-overwrite`; a fixture track naming a fake held id. The stop's tests use
    made-up ids.
  - GD-4: an in-place edit, a new-version edit, a blocks-only package, and retire or reviewed alone NOT holding.
  - GD-4 negative controls: `inAppEditAuditEntity` removed, and the key match removed.
- Mutants run with `npm run mutation:prove`.
- GD-1 is a harness fix with no guard. Its evidence is a node check of the split-character mechanism, plus CI's
  pg shard.

**CAN / CAN'T / NOT SURE in this container.**
- Unit jest: NOT SURE. `node_modules` is absent; `npm ci` first.
- pg suites: NOT SURE. The npm registry answers, and `@embedded-postgres/linux-x64` is published. Smallest test:
  `npm ci`, then one suite (`test:migrations:content-import-in-app-edits`).
- If the pg suites cannot run here: push the test commit first, watch CI's pg shard go red on it, then push the
  fix.
- The frozen Backbone is not in this container (`find` found no `FREEZE_MANIFEST.json`), so real-Backbone
  export checks stay skipped. Fixture tests are the evidence.

**Reviews.** Two fresh-context reviewers per build PR, each given the brief and the diff: one on data integrity,
one on the public-repo rule.

## 5. Collision check (open PRs at their heads, `git diff --name-only $(git merge-base origin/main pr/N) pr/N`, 2026-11-20)

- #2027 (ED-UI) holds `inAppEdits.ts` and `datasets/contentLabels.ts` (GD-4 waits for it), plus
  `drillLibraryEdit.ts`, `workoutTemplateEdit.ts` and their tests (no GD PR touches them).
- No other open PR touches any file in GD-1 to GD-4. #2025 touches the session-scripts page test,
  `sessionScriptLiveDelivery.test.tsx` and `src/lib/sessionScriptWords.ts`, none of them GD's. #2032 touches
  `scripts/ci-classify-paths.mjs`, not edited by GD.
- Each build PR re-runs this check before its push.

## 6. Questions (recommended option first)

Q1 to Q4 are listed in the PR body with the sources checked for each.

## 7. Adjacent findings (reported, not in scope)

- **Held ids already in the repo.** The six held template ids are in four committed files:
  - `scripts/backbone-export-youth-recreational.mjs:83-88`;
  - its test (one 6-id list at `:407`, plus fixture lines);
  - `docs/backbone/YOUTH_RECREATIONAL_PROVENANCE.md`;
  - `docs/content-review/youth-recreational/TEMPLATE_DRAFTS_REVIEW.md` (6 lines each, by grep).

  OW25-49's record withholds them "from this public repo" (`docs/current/OWNER_DECISIONS.md:1696`). See Q4.
- **pathway-catalog has no overwrite guard.** Its inputs include a working file (`:65`) read with no manifest
  (`:344-347`). Run without `--out`, it overwrites the committed catalog. GD-3 adds only the held-text stop
  there.
- **TL and the drill-library exporter.** drill-library stops the whole lane-2 export when a kept drill shares
  a discipline and name with a lane-2 drill (`:239-245`). TL's new drills could trigger that (INFERRED). It is a
  stop, not an overwrite.
- **The same per-chunk decode in other suites.** 347 files under `src` and `scripts` use
  `+= chunk.toString()` (grep), mostly on the embedded server's stderr. Only the one in item 4 is fixed.
