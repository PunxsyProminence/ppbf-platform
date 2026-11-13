Status: DRAFT, not app source until handoff (RULES.md)

# Backbone handoff note, for the app repo's Overwatch and Claude Code

Written 2026-11-10 by wave-2 session 28 (main session, PPBF Backbone Wave 2 Repo Handoff), plan step 'Prepare repo handoff and freeze OneDrive copy' (plan v14). Read with PACKAGE_MANIFEST.json, RULES_FOLD_MAP.json and PR_DESCRIPTION_DRAFT.md in this folder. Nothing here was pushed or opened on GitHub: the pull requests are Claude Code's (plan step). Every hash is sha256[:16]; the values below were taken at 2026-11-10 07:46 (machine clock, US Eastern) and are re-taken in FREEZE_MANIFEST.json when the freeze is written. Approved by Jason on card PK-202 (A, 2026-11-10, answered by 08:39 machine clock; D-PK202): this package is what Claude Code brings in. The OneDrive Backbone is frozen by card PK-203 (A; D-PK203): see FROZEN.md and FREEZE_MANIFEST.json at the Backbone root; the source hashes to use are the manifest's. Labels: OBSERVED (read or run here), REPORTED (another session says so), INFERRED (reasoning). Sources of the repo facts: the research mirror C:/Dev/research-mirror/ppbf-platform at df9b3916 (2026-11-09 22:02 -05:00, #1902), equal to GitHub main at 07:31 today by one unauthenticated API read (OBSERVED; ACTIONS A-75).

## 1. What goes, and how

- Route A (D-HO01): contract and pathway catalog first (lanes 1a to 1c, merged per the crossover STATUS.md, REPORTED), then the content through the existing content-package intake, in lanes; one lane, one PR (OD-2026-11-08-001 decision 2). The FT1 track is the first content lane (D-HO02); the order of the later lanes is proposed by Overwatch in the phase-6 hand-off plan for Jason's approval (D-HO02) and is not set here.
- Before building: a read-only check of open PRs, reporting any conflict with the tables the proposal touches; build only after that (D-RV07).
- Content source (frozen at the freeze): data/ (616 files: data/spine/spine.json and 615 records: 387 drills, 133 sessions, 27 blocks, 68 tracks; aggregate 960a44a3f3f0f71a, sha256 of the sorted 'path:sha256_16' lines), spine.json c9a5b0158362c230, working/design-2026-10-25/design_catalogs.json 876ac31f5c677584 (unchanged since the app's provisional snapshot, which used these two hashes; REPORTED snapshot, hashes OBSERVED). The lanes export from these files; the raw data files themselves stay archive-only (Q-210, RH-Q04 A).
- Spec and design source, proposed repo paths (Q-210, RH-Q04 A: proposed by this session from the mirror's layout; Claude Code confirms or proposes others in its PR; Jason approves with the handoff card PK-202): docs/SCHEMA_PROPOSAL.md -> docs/backbone/SCHEMA_PROPOSAL.md (c68afab55d0fce63); working/design-2026-10-25/entities.schema.json -> docs/backbone/entities.schema.json (1c4e1074721b7fe1); working/design-2026-10-25/DATA_MODEL.md -> docs/backbone/DATA_MODEL.md (dbc226d028a6825a); working/design-2026-10-25/EVIDENCE_VOCABULARY.md -> docs/backbone/EVIDENCE_VOCABULARY.md (2fa1a4b6f993ee51; the repo contract and specs cite 'backbone EVIDENCE_VOCABULARY'); working/drift/DECISION_REGISTER.json -> docs/backbone/DECISION_REGISTER.json (16731a3d7f0ef3bb at writing; changes once more when the handoff and freeze cards are recorded); this note -> docs/backbone/HANDOFF_NOTE.md. These five are not checked here for verbatim research passages (RH-Q02); the D-RV07 review should look before commit.
- RULES.md (5cce1e1bc941308e at writing): folded into docs/current/OWNER_DECISIONS.md as one new entry, provenance RECONSTRUCTED, sections 0 to 11 word for word as one block, naming DECISION_REGISTER.json and DECISION_CHECKS.md as where each decision's card record lives; RULES.md then retired (Q-207, RH-Q01 A). Per-part hashes for checking the fold: RULES_FOLD_MAP.json. Repo references that must keep resolving after the fold (git grep at df9b3916, OBSERVED): 'backbone RULES section 10' in docs/CONTENT_PACKAGE_CONTRACT.md (13 lines), apps/web/src/server/pilot/contentImport/specs/common.ts, specs/pathwayCatalog.ts and vocabularies.ts (1 each); 'RULES section 3' in OWNER_DECISIONS.md (OD-2026-10-27-001 ruling 3). The id check scripts/check-owner-decision-ids.mjs needs one well-formed new '## OD-' heading.
- Archive-only (stay in the frozen OneDrive folder): every other file, including manual/PPBF_Full_Manual.pdf (1db91a3ee9c7effa, 5,078 pages, approved by PK-199) and manual/PPBF_Starter_Manual_wave1.pdf (7c78a20831f46325); the full manual prints the catalog verbatim (PK-153), its 'quotes' keys included, so under Q-208 it does not go into the public repo (INFERRED); docs/ other than SCHEMA_PROPOSAL.md (METHODS.md, GAP_LIST_AND_AGENDA.json and .md hold the FUTURE research agenda; Jason can add them in the plan approval); test_athletes.json (hypothetical fixtures; never opened by the lanes); inputs/, parked/, RESUME.md, RESUME_HISTORY.md, working/.
- Public repository: verbatim research quotes stay out: the exporters drop every 'quote' and 'quotes' key and keep citations whole; those quotes reach the app later only by the private excerpt path (OD-2026-10-02-013 answer 2 A, OD-2026-10-05-009); owner passages go as Jason's own material (Q-208, RH-Q02 A). Counts (OBSERVED): 857 'quote' keys in record evidence entries on 99 records; owner_passages on 318 records (1,499 passages; the repo-prep draft's '612 records' did not reproduce); 1,368 'quotes' keys in design_catalogs.json (1,364 in default_rules).
- No athlete, parent, member or footage record is in the Backbone; the test athletes are hypothetical (RULES s8). No new warning, gate or refusal the owner did not direct (RULES s1).

## 2. Schema changes that travel with the handoff (now in entities.schema.json, ACTIONS A-74)

- D-PK120: design_catalogs_file gains assessment_protocols (the catalog's 46 PP-T01 to PP-T46 rows validate against the assessment_protocol definition, OBSERVED). scale_definitions and meta sit in the catalog with no schema entry (no decision names them).
- D-PK121: gate_kind gains checkpoint_90_days (the T1 90-day check, informs only; schema P5 change).
- D-PK12: the evidence item gains inference_class (descriptive, associative, causal, theoretical, proposed; Operational Gaps s4.2), reopening D-PK16 on that point; DATA_MODEL.md entity 9 carries a dated status line. In the records: 857 entries carry a value (causal 422, associative 238, proposed 93, descriptive 92, theoretical 12; OBSERVED).
- D-SEED02 (A-31): the answer_key verdict enum is 'correct' only (the seeded-error test was withdrawn, D-SEED01); seven history files carry a one-line withdrawal note; DATA_MODEL.md held no seeded-test text.
- D-PK48: evidence_item records can be generated from the record and catalog evidence entries at the hand-off. PK-45 (D-PK45): content stage-link target_kind is drill, session, program_track or exercise; the records use drill (2,433), session (520) and program_track (749) only (OBSERVED), while PARKING_LIST PK-45 still reads 'not applied yet' (shown both ways). The content stage-link table is built at the hand-off (PK-45).
- Validation (jsonschema 4.26, read-only, OBSERVED): the 615 records validate with no error against their schema_def; test_athletes.json validates; design_catalogs.json has 1,509 errors after these changes, all named in section 4 (items 3 and 8).

## 3. field_provenance mapping (PK-106, PK-201 A)

The repo has field_provenance on drill_library only: four exact strings, compared as text (vocabularies.ts lines 98-109 at df9b3916). No Backbone record was edited.

| Backbone value | Records | Repo value |
|---|---|---|
| PPBF owner-authored | 203 (185 drills, 11 sessions, 7 tracks) | 'PPBF owner-authored' (drills); sessions and tracks have no repo column |
| PPBF owner-authored (DOC-023 first; DOC-022 for the fields DOC-023 lacks, labelled per field) | 12 drills | 'PPBF owner-authored'; the DOC-023 / DOC-022 detail stays in each record's field_labels |
| Long Road practice | 190 drills | none fits: the app side adds 'Long Road practice' to the vocabulary and the drill_library check (a repo change Jason approves in the drill lane); not mapped to an AI-draft string |
| PPBF source manual v3 | 14 tracks | no repo column on tracks; travels in the track lane's package |
| COACHING-CRAFT DRAFT | 2 tracks | the repo's full string 'COACHING-CRAFT DRAFT — no directly relevant research retrieved; REQUIRES FLOOR VALIDATION' if a track column is added (D-PK106) |
| (none) | 194 (27 blocks, 122 sessions, 45 tracks) | none (D-OQ167: DOC-136's left out with a gap) |

## 4. The app side's drift items (ACTIONS A-73; PK-200, all A) and two more

No catalog or spine edit was made: the approved full manual prints both verbatim, so an edit would need a rebuild and a new STEP-1 approval (PK-200's common fact).

1. P7's '152 catalog rows' and 'value_number': the data is authoritative; docs/SCHEMA_PROPOSAL.md now carries a dated status line under P7 (2,918 rows; value_min 505, value_max 427, value_text 47, unit 636, window_days 50, sparring_type 92, composite_parent 84, phases 1). DATA_MODEL.md entity 10 still says '152 records'; the same reading applies (INFERRED).
2. SP-1: a dated status line under principle 3 names the three granularities as the data has them (spine stage fields per field; next_stages links unlabelled, provenance by backbone_version; default rows at record level). No label was added.
3. 1,406 field_labels cells on 572 default rows hold 'INFERRED (read from the source text by the drafting session)': read each as status INFERRED with the row's own sources (INFERRED: the sentence names no source); map them or leave them blank.
4. dft_67f33b87ba6b59, dft_93c9e65ffca644, dft_c161f187fc215d, dft_e0afb09e4f91df, dft_fb2e1acea092cf: the source key is 'EXT-USAB-RB2026'; '(edition in force; the cited provisions are present)' is a note for the row's evidence entry; with that the 5 rows load (2,918 of 2,918).
5. evidence_label 'n/a' on 28 role 'related' cross-references: no label was set on the pointer; omit the key or pass it through.
6. link_kind: the app's derived kinds stand; under the rule T2 to RC1 and T2 to FT1 are lateral, while P2's wording calls them branch points. Put to Jason only if a screen or rule comes to depend on the kind (P2: links describe the map and restrict no placement).
7. Information: verbatim quotes, as section 1.
8. Found here (PK-200 item 7): 101 evidence entries on 22 default rows (the weight-cut second evidence lines, all 18 stages) carry check_state 'checked in the weight pass', not in the enum; scorecard item sci_98fe7063b799ea ('fight_iq_components') has no protocol_id and no item_number (both required).

## 5. Lines the Backbone sessions owe this note

- FUTURE (D-PK13, Jason 2026-11-08; ACTIONS A-58): pose tracking of gym footage for youth scorecard items and anchor-clip help, with its preconditions: the app's video pipeline, media consent with parent or guardian consent for minors, suitable hardware, validation against coach scoring. No footage or member data enters the Backbone.
- Not ruled (Q-209, RH-Q03 A; PK-179 A): RULES s1 (overridable defaults, each override recorded) and the RULES s9 USA Boxing medical-restriction note that never blocks, against AGENT_KERNEL.md 'Authority doctrine (owner decision, 2026-08-20)' (line 336; the coach may not override 'a medical hold or return-to-play restriction;', line 347; OBSERVED at df9b3916). To be put to Jason before any lane builds hold or medical-restriction behaviour.
- 'Escalate' is defined (D-ESC01, Jason 2026-11-04, A-25): the app shows the full information and also alerts the responsible person (the athlete's coach; for a minor also the parent or guardian), the alert logged and attributable; it never means withholding, blocking or the AI deciding; a failure to escalate is a safety test scenario where no alert reaches that person. Whether the app can send alerts is not checked. So the PK-10 release checklist applies at the handoff (D-PK10): superseded rulebook (membership moved from Rule 1.1 to 1.2), unreliable measurement, weak citation support for high-consequence claims, undocumented youth or medical data handling, failures to escalate in safety scenarios, unreproducible authorization trails; software release criteria, not blocks on members.
- Not written (PK-197 A): 151 drills have no exit_condition and 190 no correction_path, with no gap line for either; the three PK-156 drills (drl_44d4c0b52f4dbd, drl_47c74661807ae5, drl_f9bd51a246ea63; DOC-123, FT1) are among them. Show the two fields as not written, never as empty or complete.
- K-31's pointer (PK-164): 'Part 0 to Part 8 s5; the 90-day start is s6' (the register's words), for automated linking.
- Not drafted (PK-170): DOC-041 (drill KPI scorecards and evaluation forms) and DOC-154's weigh-in checklist sheet (Google Drive and SharePoint, outside the side jobs' read scope; G-CT08); for a session with those connectors.
- docs/METHODS.md section 12 (the PN-05 search) is not written (PK-171, D-PK49); its method, deviations and audits are in working/evidence/PN05_SEARCH_2026-10-28.json.
- Evidence rules: no shared copy was chosen; v5 is the newest, for the app side to choose (PK-172).
- The B4 owner pass's limits (session 27): DOC-072 cells beyond the columns read were placed verbatim but not read cell by cell; three DOC-023 manuals (Punxsy_Drill_Assignment_Matrix_Source_v3, Punxsy_Sparring_Architecture_Source_v3, Punxsy_Competition_Execution_Source_v3) are not in DOC-027 and stay unquoted; the research the Evidence_Map rows name is unverified (RULES s4).
- trk_98f1b755dce913 no longer matches pypdf's text layer after PK-189 (12 U+007F written as U+2022); pdfium's text layer and the rendered page agree with the record.
- Carried: the v69 Inventory locations for DOC-040, DOC-042 and DOC-110 are not resolved; working/evidence/__pycache__ was not re-checked.
- After-handoff research items stay FUTURE: D-PK09 (blinded expert benchmark), D-PK19 (derived-metric definitions), PK-11 (study designs); see the archive's docs/GAP_LIST_AND_AGENDA.md.
- What the 'Status: DRAFT, not app source until handoff (RULES.md)' first lines become in the repo is not recorded; the archive keeps them.

## 6. Gaps

- The repo layout was read at df9b3916 only; the proposed docs/backbone/ paths are not checked against Claude Code's conventions.
- The five spec and design files were not checked for verbatim research passages; the register was not read in full for them.
- OWNER_DECISIONS.md overlaps rest on the repo-prep draft's keyword map (14:10 on 2026-11-09) plus OD-2026-11-09-002, read in full here; the other two entries added since 00ec726b (OD-2026-11-09-001 and -003) were read by title only.
- Whether a 34 MB body passes Azure ingress for the catalog upload is UNVERIFIED (OD-2026-11-09-002, REPORTED).
