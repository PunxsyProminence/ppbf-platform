# Lane AP: AI drafts of blank template fields (review sheet)

Ruling: OD-2026-11-17-001 (Jason: "B: AI drafts the values"), whose plain principle reaches this lane ("apply, do not ask again").

## Order of basis (Overwatch, applying OD-2026-11-17-001; OWNER_DECISIONS "Applied, 2026-11-17", extended for lane AP)

1. The template's own frozen content: its name, items, stated minutes, day role, stage keys and source. A value from here is labelled `INFERRED`.
2. Otherwise, the same source document's sheet that matches the template's kind and contact structure. A value from here is labelled `UNVERIFIED`. Its label's sources name the exact sheets, and its basis names any contrary values.
3. Where neither speaks to the activity, Jason's owner system (DOC-072, DOC-027), where it addresses the same activity directly. It leads by source order (OWNER_DECISIONS section 3). A value from here is labelled `UNVERIFIED`, naming the owner rows and the contrary values (Overwatch, lane AP Q-B).

**Difficulty** takes the value the WRITTEN templates of the same lowest stage carry, with no name exception. Where no written template has that lowest stage, it takes the nearest written stage below, labelled `UNVERIFIED` (Overwatch, 2026-11-17, correcting the brief's "T2 and up = advanced" line: the written templates whose lowest stage, in the app's STAGE_KEYS order, is T2 are mixed, 16 advanced and 4 intermediate).

**Scope.** 49 of the 66 amateur and pro templates have blank required fields, 68 values in all:

| Field | Values |
| --- | --- |
| `session_type` | 10 |
| `difficulty` | 5 |
| `duration_minutes` | 46 |
| `intent` | 7 |

Each value is drafted by the order of basis below. The four fields stay required. 44 values come from the template's own content (INFERRED). 24 are UNVERIFIED: 14 durations from the same document's sheet, the 5 mitt durations from Jason's owner system (basis 3), and the 5 mitt difficulties from the nearest written stage.

**Where the drafts live.** They are the `DRAFTS` table in `apps/web/scripts/backbone-export-amateur-pro.mjs`, so a rerun on the frozen Backbone is byte-identical to the committed seed (approved by Overwatch, lane AP step 1). The exporter stops on:
- a blank field with no draft;
- a draft over a written value;
- a draft the field's checks would refuse.

**Who checks them.** Jason does not review these drafts (OD-2026-11-15-011). Both adversarial reviewers, fidelity and scoping, pass this sheet before merge. A miss is fixed by a new template version.

## The label on every drafted field

In `field_labels.<field>`:
- `status`: `INFERRED` or `UNVERIFIED`;
- `draft`: "AI draft, lane AP, 2026-11-17 (OD-2026-11-17-001)";
- `basis`;
- `sources`: the template's own sources, then the sheets used, then this sheet's path;
- for the five mitt templates, `caveat`;
- where the frozen record already labelled the blank field (58 of the 68, mostly `{"status": "UNVERIFIED", "sources": []}`), that frozen label is kept whole inside as `backbone_label`.

## Rules used

- **difficulty** (5, the DOC-023 mitt templates A-E): `advanced`, UNVERIFIED. Their lowest stage is PR1, and no template whose lowest stage is PR1-PR5 writes a difficulty (PR1's only templates are these five, all blank; the 12 PR-stage drills are blank too). So the nearest written stage below applies: every written template whose lowest stage is AM1 (9 of 9) or AM2 (7 of 7) is `advanced`, for example `wtp_0b2bb48d17e3be` and `wtp_060d401d23d474`. Contrary: none; no frozen template uses `elite` (Overwatch, lane AP, ruling A).
- **intent** (7, Phase 1 Scenario B and C days): the template's own items' text joined by " | ". That is the form its written sibling days use: 20 of the 21 multi-slot templates in the frozen set that write an intent join their slots that way, and the other one, wtp_d359ba85193b3b, names its main slot only.
- **session_type** (10):
  - The competition-day warm-up (`wtp_c0c9286e8bc870`) is `warmup`. 8 of its 9 items are warm-up blocks, and no in-use session type fits, so it takes the app's own item block word, as lane YR did.
  - The 9 rest and recovery days are `rest`, read from their day role and their own text (Overwatch, lane AP Q4 A).
  - **Flag:** `rest` is a new session_type value. session_type is free text with no vocabulary or database check (workout_templates_v2 migration; `specs/templates.ts`). The only `session_type` check, `pilot_sessions_session_type_check`, is on `pilot.sessions`, the athlete's own check-out tag, which templates never write.
- **duration_minutes, from the template's own content (27):**
  - The template's own stated minutes, taking the upper end of a range (its name, an item's `block_time`, or "N min" in an item's text).
  - A day with more than one slot (AM / Midday / PM) takes **its longest single slot** (Overwatch, lane AP Q1 A). This follows the one written two-slot day, `wtp_d359ba85193b3b` (LR-050, REPORTED), which writes 90 for PM 90 + AM 40. The sum of the slots is named in the basis as the contrary value.
- **duration_minutes, UNVERIFIED (19):**
  - **The 13 "Block Templates — Copy and Adapt" days** (LR-231, LR-234) state no minutes. Each slot takes the Long Road's written session sheet of the same kind and contact structure, at T2 (the lowest stage they serve) where one exists. The day takes its longest slot. The values (Overwatch, lane AP Q2):
    - Boxing skill 90 (the non_contact sheet `wtp_c2c4bec001a56b` is T1; the T2 sheet `wtp_080c41583b3757` is contact; both 90). "Boxing tactical" is read as boxing work; the Long Road tactical sheets `wtp_a2d9f97418ec52` and `wtp_bc964fe230d8f3` (contact) also write 90;
    - Strength 75 (`wtp_7069f515b9b84e`, T2; contrary: 70 `wtp_4346e280d811e3` "Strength session B" and `wtp_363e43d4f3f870`, 55 `wtp_0b2bb48d17e3be`);
    - "Strength B" 70 (`wtp_a7b1f9ac59530e`): the sheet with its own name, "Strength session B" (`wtp_4346e280d811e3`, LR-223, non_contact, serves T2; contrary: 75 `wtp_7069f515b9b84e`, 55 `wtp_0b2bb48d17e3be`) (Overwatch, lane AP Q-A);
    - Buffering 50 (`wtp_da83ce464ffa96`, T2);
    - Sparring 75 (`wtp_040289603033b6`; no T2 sparring sheet; contrary: 100 `wtp_25a003f73a472c`);
    - the rest days 20.
  - **The 3 rest-only days** (2 Block Templates Sundays and the First 90 Days Sunday) take the Long Road's written off days of the same contact structure, `wtp_84cb2cf887a94a` and `wtp_485b1e28f6cf9a`, both 20.
  - **The 5 DOC-023 mitt templates A-E** (basis 3) are 6 rounds each, with no round or session length in their own records, and DOC-023 and DOC-022 state no mitt round length. Jason's owner system DOC-072 Workout_Map runs pad work in 2:00 rounds: W-S10-007, an owner passage on `trk_5ca8d83f2a1a66`, with equipment "mitts or pads" and rounds "3 x 2:00 single straight defend-return; 2 x 2:00 defend or exit; ...". So each is 6 x 2:00 = **12**, UNVERIFIED (Overwatch, lane AP Q-B, replacing Q3's 18). Contrary: DOC-022's "Pro contests can extend up to 12 x 3-minute rounds" (`trk_24e2dcbf4b0edc`, DIRECT CLAIM LIMITS), 6 x 3 = 18. The caveat, word for word on all five: "pad round length from DOC-072 Workout_Map (W-S10-007); rest between rounds not counted; DOC-022 and DOC-023 state no mitt round length". Holding them would undo Jason's pick: he chose "B: AI drafts the values" over "C: Hold".
- **A written value is never drafted over.** The exporter stops if a draft names a field the Backbone writes.

## Sparring minutes (OD-2026-11-17-002; not drafts)

Three items above light technical carry their frozen minutes in `details.duration_minutes`, with the duration column blank:

| Template | Item | Contact | Minutes |
| --- | --- | --- | --- |
| `wtp_25a003f73a472c` | 2 | open_sparring | 55 |
| `wtp_a2d9f97418ec52` | 4 | controlled_sparring | 30 |
| `wtp_bc964fe230d8f3` | 6 | controlled_sparring | 30 |

`pilot_wti_no_contact_volume` is unchanged. The template page shows these minutes as information. Timers and issuing never read them.

## What a reviewer checks

- Each value equals what its basis says: the minutes quoted are on the frozen record or the named sheet.
- Each label carries the marker, the right status, the basis and the sheets.
- The caveat is on all five mitt templates, word for word.
- No value invents a field the frozen set does not support.

## Drafts, by template name

### Block Templates — Copy and Adapt — Anatomical adaptation block Friday (`wtp_a7b1f9ac59530e`)

Stages T2, AM1, AM2, AM3, PR1, PR2, PR3, PR4, PR5; contact structure `non_contact`; day role "optional support"; age band "any"; sources LR-231, Jason 2026-10-31 (D-PK67-6).

Written, not drafted: session_type "strength"; difficulty "advanced"; intent "Strength B".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| duration_minutes | 70 | UNVERIFIED | its own items state no minutes ('Strength B' -> Strength B 70); the same document's (The Long Road) written session sheet of the same kind, of the same contact structure and at T2 where one exists (Overwatch, lane AP Q2) (Strength B: the sheet with its own name, 'Strength session B' (wtp_4346e280d811e3, LR-223, non_contact, serves T2), 70 (Overwatch, lane AP Q-A)); contrary: the other Long Road strength sheets, 75 (wtp_7069f515b9b84e, T2) and 55 (wtp_0b2bb48d17e3be, AM1); wtp_363e43d4f3f870 (T1) also writes 70 |

Sheets named in the label:
- duration_minutes: LR-223 (wtp_4346e280d811e3, Strength session B — upper explosive + power, 70 min; T1/T2/AM1/AM2/AM3/PR1/PR2/PR3/PR4/PR5/RC1, non_contact, written 70 min)
- duration_minutes: LR-061 (wtp_7069f515b9b84e, Phase 2 — Competitive Amateur — Strength session — lower-body emphasis, 75 min; T2/RC1, non_contact, written 75 min)
- duration_minutes: LR-051 (wtp_363e43d4f3f870, Phase 1 — Foundation / Novice — Strength session, 70 minutes (months 3–9, lower emphasis); T1/RC1, non_contact, written 70 min)
- duration_minutes: LR-073 (wtp_0b2bb48d17e3be, Phase 3 — Advanced — Strength session — Phase 3 maintenance, 55 min; AM1, non_contact, written 55 min)

### Block Templates — Copy and Adapt — Anatomical adaptation block Monday (`wtp_53b2fb2632b55b`)

Stages T2, AM1, AM2, AM3, PR1, PR2, PR3, PR4, PR5; contact structure `non_contact`; day role "hard skill"; age band "any"; sources LR-231, Jason 2026-10-31 (D-PK67-6).

Written, not drafted: session_type "technical"; difficulty "advanced"; intent "Boxing skill".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| duration_minutes | 90 | UNVERIFIED | its own items state no minutes ('Boxing skill' -> Boxing skill 90); the same document's (The Long Road) written session sheet of the same kind, of the same contact structure and at T2 where one exists (Overwatch, lane AP Q2) (Boxing skill: the non_contact boxing-skill sheet is LR-051 (wtp_c2c4bec001a56b, T1); the T2 one, LR-218 (wtp_080c41583b3757), is contact; both 90) |

Sheets named in the label:
- duration_minutes: LR-051 (wtp_c2c4bec001a56b, Phase 1 — Foundation / Novice — Boxing skill session, 90 minutes (months 3–9); T1/RC1, non_contact, written 90 min)
- duration_minutes: LR-218 (wtp_080c41583b3757, Phase 2 — Competitive Amateur — Boxing skill session, 90 min (Phase 2–3, refinement); T2/AM1/RC1, contact, written 90 min)

### Block Templates — Copy and Adapt — Anatomical adaptation block Saturday (`wtp_4d509fa48087ab`)

Stages T2, AM1, AM2, AM3, PR1, PR2, PR3, PR4, PR5; contact structure `non_contact`; day role "reinforcement"; age band "any"; sources LR-231, Jason 2026-10-31 (D-PK67-6).

Written, not drafted: session_type "technical"; difficulty "advanced"; intent "Boxing + aerobic".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| duration_minutes | 90 | UNVERIFIED | its own items state no minutes ('Boxing + aerobic' -> Boxing skill 90); the same document's (The Long Road) written session sheet of the same kind, of the same contact structure and at T2 where one exists (Overwatch, lane AP Q2) (Boxing skill: the non_contact boxing-skill sheet is LR-051 (wtp_c2c4bec001a56b, T1); the T2 one, LR-218 (wtp_080c41583b3757), is contact; both 90) |

Sheets named in the label:
- duration_minutes: LR-051 (wtp_c2c4bec001a56b, Phase 1 — Foundation / Novice — Boxing skill session, 90 minutes (months 3–9); T1/RC1, non_contact, written 90 min)
- duration_minutes: LR-218 (wtp_080c41583b3757, Phase 2 — Competitive Amateur — Boxing skill session, 90 min (Phase 2–3, refinement); T2/AM1/RC1, contact, written 90 min)

### Block Templates — Copy and Adapt — Anatomical adaptation block Sunday (`wtp_7db7ce1a5c11d8`)

Stages T2, AM1, AM2, AM3, PR1, PR2, PR3, PR4, PR5; contact structure `non_contact`; day role "off day"; age band "any"; sources LR-231, Jason 2026-10-31 (D-PK67-6).

Written, not drafted: difficulty "advanced"; intent "Rest".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| session_type | rest | INFERRED | its day_role 'off day' and its own text 'Rest'; no in-use session type fits a rest day, so 'rest' (Overwatch, lane AP Q4 A) |
| duration_minutes | 20 | UNVERIFIED | its own items state no minutes ('Rest' -> Rest 20); the same document's (The Long Road) written off days of the same contact structure, which write 20 (Overwatch, lane AP Q2) |

Sheets named in the label:
- duration_minutes: LR-050 (wtp_84cb2cf887a94a, Phase 1 — Foundation / Novice — Scenario A Sunday; T1, non_contact, written 20 min)
- duration_minutes: LR-050 (wtp_485b1e28f6cf9a, Phase 1 — Foundation / Novice — Scenario C Sunday; T1, non_contact, written 20 min)

### Block Templates — Copy and Adapt — Anatomical adaptation block Thursday (`wtp_fe550473f8a412`)

Stages T2, AM1, AM2, AM3, PR1, PR2, PR3, PR4, PR5; contact structure `non_contact`; day role "reinforcement"; age band "any"; sources LR-231, Jason 2026-10-31 (D-PK67-6).

Written, not drafted: session_type "technical"; difficulty "advanced"; intent "Boxing skill".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| duration_minutes | 90 | UNVERIFIED | its own items state no minutes ('Boxing skill' -> Boxing skill 90); the same document's (The Long Road) written session sheet of the same kind, of the same contact structure and at T2 where one exists (Overwatch, lane AP Q2) (Boxing skill: the non_contact boxing-skill sheet is LR-051 (wtp_c2c4bec001a56b, T1); the T2 one, LR-218 (wtp_080c41583b3757), is contact; both 90) |

Sheets named in the label:
- duration_minutes: LR-051 (wtp_c2c4bec001a56b, Phase 1 — Foundation / Novice — Boxing skill session, 90 minutes (months 3–9); T1/RC1, non_contact, written 90 min)
- duration_minutes: LR-218 (wtp_080c41583b3757, Phase 2 — Competitive Amateur — Boxing skill session, 90 min (Phase 2–3, refinement); T2/AM1/RC1, contact, written 90 min)

### Block Templates — Copy and Adapt — Anatomical adaptation block Tuesday (`wtp_66e85b0fc287ea`)

Stages T2, AM1, AM2, AM3, PR1, PR2, PR3, PR4, PR5; contact structure `non_contact`; day role "optional support"; age band "any"; sources LR-231, Jason 2026-10-31 (D-PK67-6).

Written, not drafted: session_type "strength"; difficulty "advanced"; intent "Strength A".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| duration_minutes | 75 | UNVERIFIED | its own items state no minutes ('Strength A' -> Strength 75); the same document's (The Long Road) written session sheet of the same kind, of the same contact structure and at T2 where one exists (Overwatch, lane AP Q2); contrary: the other Long Road strength sheets, 70 (wtp_4346e280d811e3, "Strength session B"; wtp_363e43d4f3f870, T1) and 55 (wtp_0b2bb48d17e3be, AM1) |

Sheets named in the label:
- duration_minutes: LR-061 (wtp_7069f515b9b84e, Phase 2 — Competitive Amateur — Strength session — lower-body emphasis, 75 min; T2/RC1, non_contact, written 75 min)
- duration_minutes: LR-223 (wtp_4346e280d811e3, Strength session B — upper explosive + power, 70 min; T1/T2/AM1/AM2/AM3/PR1/PR2/PR3/PR4/PR5/RC1, non_contact, written 70 min)
- duration_minutes: LR-051 (wtp_363e43d4f3f870, Phase 1 — Foundation / Novice — Strength session, 70 minutes (months 3–9, lower emphasis); T1/RC1, non_contact, written 70 min)
- duration_minutes: LR-073 (wtp_0b2bb48d17e3be, Phase 3 — Advanced — Strength session — Phase 3 maintenance, 55 min; AM1, non_contact, written 55 min)

### Block Templates — Copy and Adapt — Anatomical adaptation block Wednesday (`wtp_ca384cb3b5581a`)

Stages T2, AM1, AM2, AM3, PR1, PR2, PR3, PR4, PR5; contact structure `non_contact`; day role "optional support"; age band "any"; sources LR-231, Jason 2026-10-31 (D-PK67-6), Jason 2026-11-09 (D-PK190).

Written, not drafted: session_type "conditioning"; difficulty "advanced"; intent "Aerobic 30 min".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| duration_minutes | 30 | INFERRED | its own stated minutes: conditioning '30 min' |

### Block Templates — Copy and Adapt — Buffering block Friday (`wtp_f581f36db0076e`)

Stages T2, AM1, AM2, AM3, PR1, PR2, PR3, PR4, PR5; contact structure `non_contact`; day role "primer"; age band "any"; sources LR-234, Jason 2026-10-31 (D-PK67-6).

Written, not drafted: session_type "technical"; difficulty "advanced"; intent "Strength (reduced) | Boxing skill + fatigued technique".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| duration_minutes | 90 | UNVERIFIED | its own items state no minutes ('Strength (reduced)' -> Strength 75, 'Boxing skill + fatigued technique' -> Boxing skill 90); the same document's (The Long Road) written session sheet of the same kind, of the same contact structure and at T2 where one exists (Overwatch, lane AP Q2) (Boxing skill: the non_contact boxing-skill sheet is LR-051 (wtp_c2c4bec001a56b, T1); the T2 one, LR-218 (wtp_080c41583b3757), is contact; both 90); the longest single slot, as the written two-slot day wtp_d359ba85193b3b writes 90 for PM 90 + AM 40 (Overwatch, lane AP Q1 A); contrary: the sum of its slots, 165; the other Long Road strength sheets, 70 (wtp_4346e280d811e3, "Strength session B"; wtp_363e43d4f3f870, T1) and 55 (wtp_0b2bb48d17e3be, AM1) |

Sheets named in the label:
- duration_minutes: LR-061 (wtp_7069f515b9b84e, Phase 2 — Competitive Amateur — Strength session — lower-body emphasis, 75 min; T2/RC1, non_contact, written 75 min)
- duration_minutes: LR-051 (wtp_c2c4bec001a56b, Phase 1 — Foundation / Novice — Boxing skill session, 90 minutes (months 3–9); T1/RC1, non_contact, written 90 min)
- duration_minutes: LR-218 (wtp_080c41583b3757, Phase 2 — Competitive Amateur — Boxing skill session, 90 min (Phase 2–3, refinement); T2/AM1/RC1, contact, written 90 min)
- duration_minutes: LR-223 (wtp_4346e280d811e3, Strength session B — upper explosive + power, 70 min; T1/T2/AM1/AM2/AM3/PR1/PR2/PR3/PR4/PR5/RC1, non_contact, written 70 min)
- duration_minutes: LR-051 (wtp_363e43d4f3f870, Phase 1 — Foundation / Novice — Strength session, 70 minutes (months 3–9, lower emphasis); T1/RC1, non_contact, written 70 min)
- duration_minutes: LR-073 (wtp_0b2bb48d17e3be, Phase 3 — Advanced — Strength session — Phase 3 maintenance, 55 min; AM1, non_contact, written 55 min)

### Block Templates — Copy and Adapt — Buffering block Monday (`wtp_bdb23cdf150b86`)

Stages T2, AM1, AM2, AM3, PR1, PR2, PR3, PR4, PR5; contact structure `non_contact`; day role "hard skill"; age band "any"; sources LR-234, Jason 2026-10-31 (D-PK67-6).

Written, not drafted: session_type "technical"; difficulty "advanced"; intent "Strength (reduced) | Boxing skill".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| duration_minutes | 90 | UNVERIFIED | its own items state no minutes ('Strength (reduced)' -> Strength 75, 'Boxing skill' -> Boxing skill 90); the same document's (The Long Road) written session sheet of the same kind, of the same contact structure and at T2 where one exists (Overwatch, lane AP Q2) (Boxing skill: the non_contact boxing-skill sheet is LR-051 (wtp_c2c4bec001a56b, T1); the T2 one, LR-218 (wtp_080c41583b3757), is contact; both 90); the longest single slot, as the written two-slot day wtp_d359ba85193b3b writes 90 for PM 90 + AM 40 (Overwatch, lane AP Q1 A); contrary: the sum of its slots, 165; the other Long Road strength sheets, 70 (wtp_4346e280d811e3, "Strength session B"; wtp_363e43d4f3f870, T1) and 55 (wtp_0b2bb48d17e3be, AM1) |

Sheets named in the label:
- duration_minutes: LR-061 (wtp_7069f515b9b84e, Phase 2 — Competitive Amateur — Strength session — lower-body emphasis, 75 min; T2/RC1, non_contact, written 75 min)
- duration_minutes: LR-051 (wtp_c2c4bec001a56b, Phase 1 — Foundation / Novice — Boxing skill session, 90 minutes (months 3–9); T1/RC1, non_contact, written 90 min)
- duration_minutes: LR-218 (wtp_080c41583b3757, Phase 2 — Competitive Amateur — Boxing skill session, 90 min (Phase 2–3, refinement); T2/AM1/RC1, contact, written 90 min)
- duration_minutes: LR-223 (wtp_4346e280d811e3, Strength session B — upper explosive + power, 70 min; T1/T2/AM1/AM2/AM3/PR1/PR2/PR3/PR4/PR5/RC1, non_contact, written 70 min)
- duration_minutes: LR-051 (wtp_363e43d4f3f870, Phase 1 — Foundation / Novice — Strength session, 70 minutes (months 3–9, lower emphasis); T1/RC1, non_contact, written 70 min)
- duration_minutes: LR-073 (wtp_0b2bb48d17e3be, Phase 3 — Advanced — Strength session — Phase 3 maintenance, 55 min; AM1, non_contact, written 55 min)

### Block Templates — Copy and Adapt — Buffering block Saturday (`wtp_b368e0355b3bbb`)

Stages T2, AM1, AM2, AM3, PR1, PR2, PR3, PR4, PR5; contact structure `contact`; day role "sparring anchor"; age band "any"; sources LR-234, Jason 2026-10-31 (D-PK67-6).

Written, not drafted: session_type "sparring"; difficulty "advanced"; intent "Sparring".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| duration_minutes | 75 | UNVERIFIED | its own items state no minutes ('Sparring' -> Sparring 75); the same document's (The Long Road) written session sheet of the same kind, of the same contact structure and at T2 where one exists (Overwatch, lane AP Q2); contrary: the Phase 3 competition-simulation sparring sheet, 100 (wtp_25a003f73a472c, AM1) |

Sheets named in the label:
- duration_minutes: LR-220 (wtp_040289603033b6, Phase 1 — Foundation / Novice — Sparring session, 75 min (Phase 1, Stage 5); T1/RC1, contact, written 75 min)
- duration_minutes: LR-073 (wtp_25a003f73a472c, Phase 3 — Advanced — Competition-simulation sparring session, 100 min; AM1, contact, written 100 min)

### Block Templates — Copy and Adapt — Buffering block Sunday (`wtp_9cd67911f6c526`)

Stages T2, AM1, AM2, AM3, PR1, PR2, PR3, PR4, PR5; contact structure `non_contact`; day role "off day"; age band "any"; sources LR-234, Jason 2026-10-31 (D-PK67-6).

Written, not drafted: difficulty "advanced"; intent "Rest | Film".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| session_type | rest | INFERRED | its day_role 'off day' and its own text 'Rest \| Film'; no in-use session type fits a rest day, so 'rest' (Overwatch, lane AP Q4 A) |
| duration_minutes | 20 | UNVERIFIED | its own items state no minutes ('Rest' -> Rest 20, 'Film' (no sheet)); the same document's (The Long Road) written off days of the same contact structure, which write 20 (Overwatch, lane AP Q2) |

Sheets named in the label:
- duration_minutes: LR-050 (wtp_84cb2cf887a94a, Phase 1 — Foundation / Novice — Scenario A Sunday; T1, non_contact, written 20 min)
- duration_minutes: LR-050 (wtp_485b1e28f6cf9a, Phase 1 — Foundation / Novice — Scenario C Sunday; T1, non_contact, written 20 min)

### Block Templates — Copy and Adapt — Buffering block Thursday (`wtp_52f7e4342df818`)

Stages T2, AM1, AM2, AM3, PR1, PR2, PR3, PR4, PR5; contact structure `non_contact`; day role "reinforcement"; age band "any"; sources LR-234, Jason 2026-10-31 (D-PK67-6).

Written, not drafted: session_type "technical"; difficulty "advanced"; intent "Buffering | Boxing skill + fatigued technique".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| duration_minutes | 90 | UNVERIFIED | its own items state no minutes ('Buffering' -> Buffering 50, 'Boxing skill + fatigued technique' -> Boxing skill 90); the same document's (The Long Road) written session sheet of the same kind, of the same contact structure and at T2 where one exists (Overwatch, lane AP Q2) (Boxing skill: the non_contact boxing-skill sheet is LR-051 (wtp_c2c4bec001a56b, T1); the T2 one, LR-218 (wtp_080c41583b3757), is contact; both 90); the longest single slot, as the written two-slot day wtp_d359ba85193b3b writes 90 for PM 90 + AM 40 (Overwatch, lane AP Q1 A); contrary: the sum of its slots, 140 |

Sheets named in the label:
- duration_minutes: LR-061 (wtp_da83ce464ffa96, Phase 2 — Competitive Amateur — Buffering conditioning session, 50 min; T2/RC1, non_contact, written 50 min)
- duration_minutes: LR-051 (wtp_c2c4bec001a56b, Phase 1 — Foundation / Novice — Boxing skill session, 90 minutes (months 3–9); T1/RC1, non_contact, written 90 min)
- duration_minutes: LR-218 (wtp_080c41583b3757, Phase 2 — Competitive Amateur — Boxing skill session, 90 min (Phase 2–3, refinement); T2/AM1/RC1, contact, written 90 min)

### Block Templates — Copy and Adapt — Buffering block Tuesday (`wtp_a6af9b142437ca`)

Stages T2, AM1, AM2, AM3, PR1, PR2, PR3, PR4, PR5; contact structure `non_contact`; day role "reinforcement"; age band "any"; sources LR-234, Jason 2026-10-31 (D-PK67-6).

Written, not drafted: session_type "technical"; difficulty "advanced"; intent "Buffering | Boxing tactical".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| duration_minutes | 90 | UNVERIFIED | its own items state no minutes ('Buffering' -> Buffering 50, 'Boxing tactical' -> Boxing skill 90); the same document's (The Long Road) written session sheet of the same kind, of the same contact structure and at T2 where one exists (Overwatch, lane AP Q2) (Boxing skill: the non_contact boxing-skill sheet is LR-051 (wtp_c2c4bec001a56b, T1); the T2 one, LR-218 (wtp_080c41583b3757), is contact; both 90; 'Boxing tactical' read as boxing work; the Long Road tactical sheets wtp_a2d9f97418ec52 and wtp_bc964fe230d8f3 (contact) also write 90); the longest single slot, as the written two-slot day wtp_d359ba85193b3b writes 90 for PM 90 + AM 40 (Overwatch, lane AP Q1 A); contrary: the sum of its slots, 140 |

Sheets named in the label:
- duration_minutes: LR-061 (wtp_da83ce464ffa96, Phase 2 — Competitive Amateur — Buffering conditioning session, 50 min; T2/RC1, non_contact, written 50 min)
- duration_minutes: LR-051 (wtp_c2c4bec001a56b, Phase 1 — Foundation / Novice — Boxing skill session, 90 minutes (months 3–9); T1/RC1, non_contact, written 90 min)
- duration_minutes: LR-218 (wtp_080c41583b3757, Phase 2 — Competitive Amateur — Boxing skill session, 90 min (Phase 2–3, refinement); T2/AM1/RC1, contact, written 90 min)
- duration_minutes: LR-219 (wtp_a2d9f97418ec52, Tactical session, 90 min (archetype focus); T2/AM1/AM2/AM3/PR1/PR2/PR3/PR4/PR5, contact, written 90 min)
- duration_minutes: LR-061 (wtp_bc964fe230d8f3, Phase 2 — Competitive Amateur — Archetype tactical session — vs. pressure fighter, 90 min; T2, contact, written 90 min)

### Block Templates — Copy and Adapt — Buffering block Wednesday (`wtp_d6eb362e8eca13`)

Stages T2, AM1, AM2, AM3, PR1, PR2, PR3, PR4, PR5; contact structure `non_contact`; day role "recovery"; age band "any"; sources LR-234, Jason 2026-10-31 (D-PK67-6).

Written, not drafted: session_type "technical"; difficulty "advanced"; intent "Recovery | Boxing skill".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| duration_minutes | 90 | UNVERIFIED | its own items state no minutes ('Recovery' (no sheet), 'Boxing skill' -> Boxing skill 90); the same document's (The Long Road) written session sheet of the same kind, of the same contact structure and at T2 where one exists (Overwatch, lane AP Q2) (Boxing skill: the non_contact boxing-skill sheet is LR-051 (wtp_c2c4bec001a56b, T1); the T2 one, LR-218 (wtp_080c41583b3757), is contact; both 90) |

Sheets named in the label:
- duration_minutes: LR-051 (wtp_c2c4bec001a56b, Phase 1 — Foundation / Novice — Boxing skill session, 90 minutes (months 3–9); T1/RC1, non_contact, written 90 min)
- duration_minutes: LR-218 (wtp_080c41583b3757, Phase 2 — Competitive Amateur — Boxing skill session, 90 min (Phase 2–3, refinement); T2/AM1/RC1, contact, written 90 min)

### Eight-week camp — Competition-day warm-up, 35–40 min (`wtp_c0c9286e8bc870`)

Stages T2, AM1, AM2, AM3, PR1, PR2, PR3, PR4, PR5; contact structure `non_contact`; age band "any"; sources LR-230, Jason 2026-10-30 (D-PK62).

Written, not drafted: difficulty "advanced"; intent "Competition-day warm-up, 35–40 min".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| session_type | warmup | INFERRED | 8 of its 9 items are warm-up blocks (the other is 'Rest, breathe, gloves on') and its name is a competition-day warm-up; no in-use session type fits, so the app's own item block word, as lane YR |
| duration_minutes | 40 | INFERRED | its name: '35–40 min' (upper end) |

### Phase 1 — Foundation / Novice — Scenario A Sunday (`wtp_84cb2cf887a94a`)

Stages T1; contact structure `non_contact`; day role "off day"; age band "any"; sources LR-050, Jason 2026-10-30 (D-PK62), Jason 2026-10-30 (D-PK63-2).

Written, not drafted: difficulty "beginner"; duration_minutes 20; intent "Rest. 20 min film/mental practice".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| session_type | rest | INFERRED | its day_role 'off day' and its own text 'Rest. 20 min film/mental practice'; no in-use session type fits a rest day, so 'rest' (Overwatch, lane AP Q4 A) |

### Phase 1 — Foundation / Novice — Scenario A Wednesday (`wtp_1e77dabdfa54f8`)

Stages T1; contact structure `non_contact`; day role "recovery"; age band "any"; sources LR-050, Jason 2026-10-30 (D-PK62), Jason 2026-10-30 (D-PK63-2), Jason 2026-11-08 (D-PK64-FR).

Written, not drafted: difficulty "beginner"; duration_minutes 20; intent "Rest or 20 min mobility".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| session_type | rest | INFERRED | its day_role 'recovery' and its own text 'Rest or 20 min mobility'; no in-use session type fits a rest day, so 'rest' (Overwatch, lane AP Q4 A) |

### Phase 1 — Foundation / Novice — Scenario B Monday (`wtp_6bdab8e5169726`)

Stages T1; contact structure `non_contact`; day role "hard skill"; age band "any"; sources LR-050, Jason 2026-10-30 (D-PK62), Jason 2026-10-30 (D-PK63-2).

Written, not drafted: session_type "technical"; difficulty "beginner"; intent "Boxing skill 75–90 min: new technical material".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| duration_minutes | 90 | INFERRED | its own stated minutes: PM '75–90 min' (upper end) |

### Phase 1 — Foundation / Novice — Scenario B Saturday (`wtp_000d2b85b29bbb`)

Stages T1; contact structure `non_contact`; day role "optional support"; age band "any"; sources LR-050, Jason 2026-10-30 (D-PK62), Jason 2026-10-30 (D-PK63-2), Jason 2026-11-08 (D-PK64-FR).

Written, not drafted: session_type "conditioning"; difficulty "beginner"; intent "Conditioning 45–60 min: aerobic intervals or easy long run; mobility".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| duration_minutes | 60 | INFERRED | its own stated minutes: AM '45–60 min' (upper end) |

### Phase 1 — Foundation / Novice — Scenario B Sunday (`wtp_73621edf20014a`)

Stages T1; contact structure `non_contact`; day role "off day"; age band "any"; sources LR-050, Jason 2026-10-30 (D-PK62), Jason 2026-10-30 (D-PK63-2), Jason 2026-11-08 (D-PK64-FR).

Written, not drafted: difficulty "beginner"; intent "Full rest or 20–30 min walk + mobility; weekly review".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| session_type | rest | INFERRED | its day_role 'off day' and its own text 'Full rest or 20–30 min walk + mobility; weekly review'; no in-use session type fits a rest day, so 'rest' (Overwatch, lane AP Q4 A) |
| duration_minutes | 30 | INFERRED | its own stated minutes: AM '20–30 min' (upper end) |

### Phase 1 — Foundation / Novice — Scenario B Thursday (`wtp_5303f3ce867b0c`)

Stages T1; contact structure `non_contact`; day role "optional support"; age band "any"; sources LR-050, Jason 2026-10-30 (D-PK62), Jason 2026-10-30 (D-PK63-2), Jason 2026-11-08 (D-PK64-FR).

Written, not drafted: session_type "strength"; difficulty "beginner".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| duration_minutes | 75 | INFERRED | its own slot minutes: AM '30–40 min', PM '60–75 min' (upper end of a range); the longest single slot, as the written two-slot day wtp_d359ba85193b3b writes 90 for PM 90 + AM 40 (Overwatch, lane AP Q1 A); contrary: the sum of its slots, 115 |
| intent | Easy run 30–40 min \| Strength 60–75 min: upper emphasis + MB ballistics + neck | INFERRED | its own items' text joined by ' \| ', the form its written sibling days use |

### Phase 1 — Foundation / Novice — Scenario B Tuesday (`wtp_b604cd74564a8c`)

Stages T1; contact structure `non_contact`; day role "optional support"; age band "any"; sources LR-050, Jason 2026-10-30 (D-PK62), Jason 2026-10-30 (D-PK63-2).

Written, not drafted: session_type "strength"; difficulty "beginner".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| duration_minutes | 75 | INFERRED | its own slot minutes: AM '10 min', PM '60–75 min' (upper end of a range); the longest single slot, as the written two-slot day wtp_d359ba85193b3b writes 90 for PM 90 + AM 40 (Overwatch, lane AP Q1 A); contrary: the sum of its slots, 85 |
| intent | Mobility 10 min \| Strength 60–75 min: lower emphasis + neck + carries | INFERRED | its own items' text joined by ' \| ', the form its written sibling days use |

### Phase 1 — Foundation / Novice — Scenario C Friday (`wtp_4d5eb0ed94d617`)

Stages T1; contact structure `non_contact`; day role "reinforcement"; age band "any"; sources LR-050, Jason 2026-10-30 (D-PK62), Jason 2026-10-30 (D-PK63-2).

Written, not drafted: session_type "technical"; difficulty "beginner".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| duration_minutes | 75 | INFERRED | its own slot minutes: AM '70 min', PM '75 min'; the longest single slot, as the written two-slot day wtp_d359ba85193b3b writes 90 for PM 90 + AM 40 (Overwatch, lane AP Q1 A); contrary: the sum of its slots, 145 |
| intent | Strength 70 min: upper explosive + plyos \| Boxing skill 75 min: pads, footwork | INFERRED | its own items' text joined by ' \| ', the form its written sibling days use |

### Phase 1 — Foundation / Novice — Scenario C Monday (`wtp_e3aa9cda9f1675`)

Stages T1; contact structure `non_contact`; day role "hard skill"; age band "any"; sources LR-050, Jason 2026-10-30 (D-PK62), Jason 2026-10-30 (D-PK63-2), Jason 2026-11-08 (D-PK64-FR).

Written, not drafted: session_type "technical"; difficulty "beginner".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| duration_minutes | 90 | INFERRED | its own slot minutes: AM '40 min', PM '90 min'; the longest single slot, as the written two-slot day wtp_d359ba85193b3b writes 90 for PM 90 + AM 40 (Overwatch, lane AP Q1 A); contrary: the sum of its slots, 130 |
| intent | Conditioning 40 min: HIIT \| Boxing skill 90 min: acquisition | INFERRED | its own items' text joined by ' \| ', the form its written sibling days use |

### Phase 1 — Foundation / Novice — Scenario C Sunday (`wtp_485b1e28f6cf9a`)

Stages T1; contact structure `non_contact`; day role "off day"; age band "any"; sources LR-050, Jason 2026-10-30 (D-PK62), Jason 2026-10-30 (D-PK63-2).

Written, not drafted: difficulty "beginner"; duration_minutes 20; intent "Full rest; weekly review; film study 20 min".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| session_type | rest | INFERRED | its day_role 'off day' and its own text 'Full rest; weekly review; film study 20 min'; no in-use session type fits a rest day, so 'rest' (Overwatch, lane AP Q4 A) |

### Phase 1 — Foundation / Novice — Scenario C Thursday (`wtp_43010f10a6b0b3`)

Stages T1; contact structure `contact`; day role "reinforcement"; age band "any"; sources LR-050, Jason 2026-10-30 (D-PK62), Jason 2026-10-30 (D-PK63-2), Jason 2026-10-30 (D-PK63-4), Jason 2026-11-08 (D-PK64-FR).

Written, not drafted: session_type "technical"; difficulty "beginner".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| duration_minutes | 75 | INFERRED | its own slot minutes: AM '40 min', PM '75 min'; the longest single slot, as the written two-slot day wtp_d359ba85193b3b writes 90 for PM 90 + AM 40 (Overwatch, lane AP Q1 A); contrary: the sum of its slots, 115 |
| intent | Restoration 40 min: low-load movement and aerobic restoration work \| Boxing tactical 75 min: constrained live | INFERRED | its own items' text joined by ' \| ', the form its written sibling days use |

### Phase 1 — Foundation / Novice — Scenario C Tuesday (`wtp_6664906527b540`)

Stages T1; contact structure `non_contact`; day role "reinforcement"; age band "any"; sources LR-050, Jason 2026-10-30 (D-PK62), Jason 2026-10-30 (D-PK63-2).

Written, not drafted: session_type "technical"; difficulty "beginner".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| duration_minutes | 75 | INFERRED | its own slot minutes: AM '70 min', PM '75 min'; the longest single slot, as the written two-slot day wtp_d359ba85193b3b writes 90 for PM 90 + AM 40 (Overwatch, lane AP Q1 A); contrary: the sum of its slots, 145 |
| intent | Strength 70 min: lower, heavy \| Boxing skill 75 min: refinement, bag | INFERRED | its own items' text joined by ' \| ', the form its written sibling days use |

### Phase 1 — Foundation / Novice — Scenario C Wednesday (`wtp_c4ce7036fc104d`)

Stages T1; contact structure `contact`; day role "live or sparring anchor"; age band "any"; sources LR-050, Jason 2026-10-30 (D-PK62), Jason 2026-10-30 (D-PK63-2).

Written, not drafted: session_type "sparring"; difficulty "beginner".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| duration_minutes | 75 | INFERRED | its own slot minutes: AM '25 min', PM '75 min'; the longest single slot, as the written two-slot day wtp_d359ba85193b3b writes 90 for PM 90 + AM 40 (Overwatch, lane AP Q1 A); contrary: the sum of its slots, 100 |
| intent | Mobility + neck 25 min \| Sparring 75 min: 4–6 rounds Stage 5 | INFERRED | its own items' text joined by ' \| ', the form its written sibling days use |

### Phase 3 — Advanced — Peak-specific week Friday (`wtp_f448464103ec0a`)

Stages AM1; contact structure `non_contact`; day role "primer"; age band "any"; sources LR-072, Jason 2026-10-31 (D-PK67-6).

Written, not drafted: session_type "technical"; difficulty "advanced"; intent "Strength 45 min: power/contrast, throws, plyometrics | Nap; feed; film study 20 min | Boxing skill 75 min: pads, bag, speed work".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| duration_minutes | 75 | INFERRED | its own slot minutes: AM '45 min', Midday '20 min', PM '75 min'; the longest single slot, as the written two-slot day wtp_d359ba85193b3b writes 90 for PM 90 + AM 40 (Overwatch, lane AP Q1 A); contrary: the sum of its slots, 140 |

### Phase 3 — Advanced — Peak-specific week Monday (`wtp_2759a2e4865091`)

Stages AM1; contact structure `non_contact`; day role "hard skill"; age band "any"; sources LR-072, Jason 2026-10-31 (D-PK67-6), Jason 2026-11-09 (D-PK190).

Written, not drafted: session_type "technical"; difficulty "advanced"; intent "Conditioning 45 min: HIIT 4:2 × 4, HR-monitored, prescribed off VIFT | Nap 20–40 min; feed | Boxing skill 90 min: technical sharpening, pads, bag".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| duration_minutes | 90 | INFERRED | its own slot minutes: AM '45 min', Midday '20–40 min', PM '90 min' (upper end of a range); the longest single slot, as the written two-slot day wtp_d359ba85193b3b writes 90 for PM 90 + AM 40 (Overwatch, lane AP Q1 A); contrary: the sum of its slots, 175 |

### Phase 3 — Advanced — Peak-specific week Saturday (`wtp_70dc2415bd2c93`)

Stages AM1; contact structure `contact`; day role "sparring anchor"; age band "any"; sources LR-072, Jason 2026-10-31 (D-PK67-6).

Written, not drafted: session_type "sparring"; difficulty "advanced"; intent "Sparring 100 min: 8–10 rounds, hardest session of the week | Feed; recovery protocol".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| duration_minutes | 100 | INFERRED | its own stated minutes: AM '100 min' |

### Phase 3 — Advanced — Peak-specific week Sunday (`wtp_1881d8b08576e5`)

Stages AM1; contact structure `non_contact`; day role "off day"; age band "any"; sources LR-072, Jason 2026-10-31 (D-PK67-6).

Written, not drafted: difficulty "advanced"; intent "Rest; optional 30 min easy movement | Weekly review with coach; film study 30 min".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| session_type | rest | INFERRED | its day_role 'off day' and its own text 'Rest; optional 30 min easy movement \| Weekly review with coach; film study 30 min'; no in-use session type fits a rest day, so 'rest' (Overwatch, lane AP Q4 A) |
| duration_minutes | 30 | INFERRED | its own slot minutes: AM '30 min', Midday '30 min'; the longest single slot, as the written two-slot day wtp_d359ba85193b3b writes 90 for PM 90 + AM 40 (Overwatch, lane AP Q1 A); contrary: the sum of its slots, 60 |

### Phase 3 — Advanced — Peak-specific week Thursday (`wtp_cfa42f86002f98`)

Stages AM1; contact structure `contact`; day role "reinforcement"; age band "any"; sources LR-072, Jason 2026-10-31 (D-PK67-6), Jason 2026-11-09 (D-PK190).

Written, not drafted: session_type "technical"; difficulty "advanced"; intent "Conditioning 40 min: buffering 8 × 2 min, 3 min recovery | Nap; feed | Boxing tactical 90 min: opponent-specific drills, constrained live".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| duration_minutes | 90 | INFERRED | its own slot minutes: AM '40 min', PM '90 min'; the longest single slot, as the written two-slot day wtp_d359ba85193b3b writes 90 for PM 90 + AM 40 (Overwatch, lane AP Q1 A); contrary: the sum of its slots, 130 |

### Phase 3 — Advanced — Peak-specific week Tuesday (`wtp_7e4b1fcacf2a9b`)

Stages AM1; contact structure `contact`; day role "sparring anchor"; age band "any"; sources LR-072, Jason 2026-10-31 (D-PK67-6).

Written, not drafted: session_type "sparring"; difficulty "advanced"; intent "Strength 55 min: heavy lower + explosive upper, low volume, high intent | Nap; feed; film study 20 min | Sparring 100 min: 8–10 rounds competition-representative".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| duration_minutes | 100 | INFERRED | its own slot minutes: AM '55 min', Midday '20 min', PM '100 min'; the longest single slot, as the written two-slot day wtp_d359ba85193b3b writes 90 for PM 90 + AM 40 (Overwatch, lane AP Q1 A); contrary: the sum of its slots, 175 |

### Phase 3 — Advanced — Peak-specific week Wednesday (`wtp_10c6082f9d5089`)

Stages AM1; contact structure `non_contact`; day role "recovery"; age band "any"; sources LR-072, Jason 2026-10-31 (D-PK67-6), Jason 2026-11-09 (D-PK190).

Written, not drafted: session_type "technical"; difficulty "advanced"; intent "Recovery 40 min: easy bike or swim, mobility, soft tissue | Feed | Boxing skill 75 min: low intensity refinement, footwork, distance games".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| duration_minutes | 75 | INFERRED | its own slot minutes: AM '40 min', PM '75 min'; the longest single slot, as the written two-slot day wtp_d359ba85193b3b writes 90 for PM 90 + AM 40 (Overwatch, lane AP Q1 A); contrary: the sum of its slots, 115 |

### Phase 4 — Elite / Champion-tier — Mid-camp week Friday (`wtp_06679961df65bb`)

Stages AM2, AM3; contact structure `non_contact`; day role "primer"; age band "any"; sources LR-079, Jason 2026-10-31 (D-PK67-6).

Written, not drafted: session_type "technical"; difficulty "advanced"; intent "Power 40 min: contrast/ballistic, fully recovered | Skill 60 min: pads, precision, speed".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| duration_minutes | 60 | INFERRED | its own slot minutes: AM '40 min', PM '60 min'; the longest single slot, as the written two-slot day wtp_d359ba85193b3b writes 90 for PM 90 + AM 40 (Overwatch, lane AP Q1 A); contrary: the sum of its slots, 100 |

### Phase 4 — Elite / Champion-tier — Mid-camp week Monday (`wtp_588adc80b308df`)

Stages AM2, AM3; contact structure `non_contact`; day role "hard skill"; age band "any"; sources LR-079, Jason 2026-10-31 (D-PK67-6), Jason 2026-11-09 (D-PK190).

Written, not drafted: session_type "technical"; difficulty "advanced"; intent "Skill 75 min: opponent-specific technical work, high quality, low fatigue | Conditioning 40 min: HIIT prescribed off VIFT".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| duration_minutes | 75 | INFERRED | its own slot minutes: AM '75 min', PM '40 min'; the longest single slot, as the written two-slot day wtp_d359ba85193b3b writes 90 for PM 90 + AM 40 (Overwatch, lane AP Q1 A); contrary: the sum of its slots, 115 |

### Phase 4 — Elite / Champion-tier — Mid-camp week Saturday (`wtp_15fd46693aae7e`)

Stages AM2, AM3; contact structure `contact`; day role "sparring anchor"; age band "any"; sources LR-079, Jason 2026-10-31 (D-PK67-6).

Written, not drafted: session_type "sparring"; difficulty "advanced"; intent "Sparring 90 min: primary session of the week | Recovery protocol + weekly review".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| duration_minutes | 90 | INFERRED | its own stated minutes: AM '90 min' |

### Phase 4 — Elite / Champion-tier — Mid-camp week Sunday (`wtp_23849b29f8592f`)

Stages AM2, AM3; contact structure `non_contact`; day role "off day"; age band "any"; sources LR-079, Jason 2026-10-31 (D-PK67-6).

Written, not drafted: difficulty "advanced"; intent "Full rest | Film study 45 min; nutrition prep for the week".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| session_type | rest | INFERRED | its day_role 'off day' and its own text 'Full rest \| Film study 45 min; nutrition prep for the week'; no in-use session type fits a rest day, so 'rest' (Overwatch, lane AP Q4 A) |
| duration_minutes | 45 | INFERRED | its own stated minutes: PM '45 min' |

### Phase 4 — Elite / Champion-tier — Mid-camp week Thursday (`wtp_6bd117a9ae1263`)

Stages AM2, AM3; contact structure `contact`; day role "reinforcement"; age band "any"; sources LR-079, Jason 2026-10-31 (D-PK67-6), Jason 2026-11-09 (D-PK190).

Written, not drafted: session_type "technical"; difficulty "advanced"; intent "Conditioning 40 min: buffering or speed endurance | Tactical 90 min: constrained live, scenario drills".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| duration_minutes | 90 | INFERRED | its own slot minutes: AM '40 min', PM '90 min'; the longest single slot, as the written two-slot day wtp_d359ba85193b3b writes 90 for PM 90 + AM 40 (Overwatch, lane AP Q1 A); contrary: the sum of its slots, 130 |

### Phase 4 — Elite / Champion-tier — Mid-camp week Tuesday (`wtp_060d401d23d474`)

Stages AM2, AM3; contact structure `contact`; day role "sparring anchor"; age band "any"; sources LR-079, Jason 2026-10-31 (D-PK67-6).

Written, not drafted: session_type "sparring"; difficulty "advanced"; intent "Strength 50 min: heavy, low volume, velocity-monitored | Sparring 90 min: 6–8 rounds, opponent-emulating".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| duration_minutes | 90 | INFERRED | its own slot minutes: AM '50 min', PM '90 min'; the longest single slot, as the written two-slot day wtp_d359ba85193b3b writes 90 for PM 90 + AM 40 (Overwatch, lane AP Q1 A); contrary: the sum of its slots, 140 |

### Phase 4 — Elite / Champion-tier — Mid-camp week Wednesday (`wtp_b52e6a56afea4b`)

Stages AM2, AM3; contact structure `non_contact`; day role "recovery"; age band "any"; sources LR-079, Jason 2026-10-31 (D-PK67-6), Jason 2026-11-09 (D-PK190).

Written, not drafted: session_type "technical"; difficulty "advanced"; intent "Recovery 45 min: pool, mobility, soft tissue, sauna if heat adaptation indicated | Skill 60 min: low-intensity refinement + 45 min film study".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| duration_minutes | 60 | INFERRED | its own slot minutes: AM '45 min', PM '60 min'; the longest single slot, as the written two-slot day wtp_d359ba85193b3b writes 90 for PM 90 + AM 40 (Overwatch, lane AP Q1 A); contrary: the sum of its slots, 105 |

### Template A - Mechanics Mitts (`wtp_d2f730ec22b7fb`)

Stages PR1, PR2, PR3, PR4, PR5; contact structure `non_contact`; age band "18+"; sources DOC-023, DOC-022, Jason 2026-10-30 (D-PK56).

Written, not drafted: session_type "technical"; intent "refine one punch family.".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| difficulty | advanced | UNVERIFIED | no template whose lowest stage is PR1-PR5 writes a difficulty (its own stage PR1 has only mitt templates A-E, all blank), so the nearest written stage below: every written template whose lowest stage is AM1 (9 of 9) or AM2 (7 of 7) is advanced; contrary: none ('elite' is unused) (Overwatch, lane AP: the written-template rule, nearest written stage below) |
| duration_minutes | 12 | UNVERIFIED | its own items give 6 rounds (Round 1 to Round 6) and no length, and its source documents DOC-023 and DOC-022 state no mitt round length; Jason's owner system DOC-072 Workout_Map runs pad work in 2:00 rounds (W-S10-007, equipment 'mitts or pads'): 6 x 2:00 = 12 (order of basis 3: the owner system where it addresses the same activity, OWNER_DECISIONS s3; Overwatch, lane AP Q-B); contrary: DOC-022's 'Pro contests can extend up to 12 x 3-minute rounds', 6 x 3 = 18. Caveat: pad round length from DOC-072 Workout_Map (W-S10-007); rest between rounds not counted; DOC-022 and DOC-023 state no mitt round length |

Sheets named in the label:
- difficulty: LR-073 (wtp_0b2bb48d17e3be, Phase 3 — Advanced — Strength session — Phase 3 maintenance, 55 min; lowest stage AM1, written difficulty advanced)
- difficulty: LR-079 (wtp_060d401d23d474, Phase 4 — Elite / Champion-tier — Mid-camp week Tuesday; lowest stage AM2, written difficulty advanced)
- duration_minutes: DOC-072 W-S10-007 via trk_5ca8d83f2a1a66 (owner passage, Workout_Map "SKILL-10 Body Attack After Defensive Trigger Session": Equipment "timer, partner/coach, mitts or pads, legal body target marker, cones/ring line, notebook"; Rounds "5-min setup; 3 x 2:00 single straight defend-return; 2 x 2:00 defend or exit; ...")
- duration_minutes: DOC-022 (trk_24e2dcbf4b0edc, group "DOC-022 lines 123-184", DIRECT CLAIM LIMITS: "Pro contests can extend up to 12 x 3-minute rounds")

### Template B - Defense-to-Counter Mitts (`wtp_c49ef523671d1d`)

Stages PR1, PR2, PR3, PR4, PR5; contact structure `contact`; age band "18+"; sources DOC-023, DOC-022, Jason 2026-10-30 (D-PK56).

Written, not drafted: session_type "technical"; intent "link defense to scoring or exit.".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| difficulty | advanced | UNVERIFIED | no template whose lowest stage is PR1-PR5 writes a difficulty (its own stage PR1 has only mitt templates A-E, all blank), so the nearest written stage below: every written template whose lowest stage is AM1 (9 of 9) or AM2 (7 of 7) is advanced; contrary: none ('elite' is unused) (Overwatch, lane AP: the written-template rule, nearest written stage below) |
| duration_minutes | 12 | UNVERIFIED | its own items give 6 rounds (Round 1 to Round 6) and no length, and its source documents DOC-023 and DOC-022 state no mitt round length; Jason's owner system DOC-072 Workout_Map runs pad work in 2:00 rounds (W-S10-007, equipment 'mitts or pads'): 6 x 2:00 = 12 (order of basis 3: the owner system where it addresses the same activity, OWNER_DECISIONS s3; Overwatch, lane AP Q-B); contrary: DOC-022's 'Pro contests can extend up to 12 x 3-minute rounds', 6 x 3 = 18. Caveat: pad round length from DOC-072 Workout_Map (W-S10-007); rest between rounds not counted; DOC-022 and DOC-023 state no mitt round length |

Sheets named in the label:
- difficulty: LR-073 (wtp_0b2bb48d17e3be, Phase 3 — Advanced — Strength session — Phase 3 maintenance, 55 min; lowest stage AM1, written difficulty advanced)
- difficulty: LR-079 (wtp_060d401d23d474, Phase 4 — Elite / Champion-tier — Mid-camp week Tuesday; lowest stage AM2, written difficulty advanced)
- duration_minutes: DOC-072 W-S10-007 via trk_5ca8d83f2a1a66 (owner passage, Workout_Map "SKILL-10 Body Attack After Defensive Trigger Session": Equipment "timer, partner/coach, mitts or pads, legal body target marker, cones/ring line, notebook"; Rounds "5-min setup; 3 x 2:00 single straight defend-return; 2 x 2:00 defend or exit; ...")
- duration_minutes: DOC-022 (trk_24e2dcbf4b0edc, group "DOC-022 lines 123-184", DIRECT CLAIM LIMITS: "Pro contests can extend up to 12 x 3-minute rounds")

### Template C - Pressure Control Mitts (`wtp_a97e05c665c596`)

Stages PR1, PR2, PR3, PR4, PR5; contact structure `contact`; age band "18+"; sources DOC-023, DOC-022, Jason 2026-10-30 (D-PK56).

Written, not drafted: session_type "technical"; intent "solve forward pressure without straight retreat.".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| difficulty | advanced | UNVERIFIED | no template whose lowest stage is PR1-PR5 writes a difficulty (its own stage PR1 has only mitt templates A-E, all blank), so the nearest written stage below: every written template whose lowest stage is AM1 (9 of 9) or AM2 (7 of 7) is advanced; contrary: none ('elite' is unused) (Overwatch, lane AP: the written-template rule, nearest written stage below) |
| duration_minutes | 12 | UNVERIFIED | its own items give 6 rounds (Round 1 to Round 6) and no length, and its source documents DOC-023 and DOC-022 state no mitt round length; Jason's owner system DOC-072 Workout_Map runs pad work in 2:00 rounds (W-S10-007, equipment 'mitts or pads'): 6 x 2:00 = 12 (order of basis 3: the owner system where it addresses the same activity, OWNER_DECISIONS s3; Overwatch, lane AP Q-B); contrary: DOC-022's 'Pro contests can extend up to 12 x 3-minute rounds', 6 x 3 = 18. Caveat: pad round length from DOC-072 Workout_Map (W-S10-007); rest between rounds not counted; DOC-022 and DOC-023 state no mitt round length |

Sheets named in the label:
- difficulty: LR-073 (wtp_0b2bb48d17e3be, Phase 3 — Advanced — Strength session — Phase 3 maintenance, 55 min; lowest stage AM1, written difficulty advanced)
- difficulty: LR-079 (wtp_060d401d23d474, Phase 4 — Elite / Champion-tier — Mid-camp week Tuesday; lowest stage AM2, written difficulty advanced)
- duration_minutes: DOC-072 W-S10-007 via trk_5ca8d83f2a1a66 (owner passage, Workout_Map "SKILL-10 Body Attack After Defensive Trigger Session": Equipment "timer, partner/coach, mitts or pads, legal body target marker, cones/ring line, notebook"; Rounds "5-min setup; 3 x 2:00 single straight defend-return; 2 x 2:00 defend or exit; ...")
- duration_minutes: DOC-022 (trk_24e2dcbf4b0edc, group "DOC-022 lines 123-184", DIRECT CLAIM LIMITS: "Pro contests can extend up to 12 x 3-minute rounds")

### Template D - Feint and Read Mitts (`wtp_3ba3110f2428d2`)

Stages PR1, PR2, PR3, PR4, PR5; contact structure `non_contact`; age band "18+"; sources DOC-023, DOC-022, Jason 2026-10-30 (D-PK56).

Written, not drafted: session_type "technical"; intent "make athlete read reactions.".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| difficulty | advanced | UNVERIFIED | no template whose lowest stage is PR1-PR5 writes a difficulty (its own stage PR1 has only mitt templates A-E, all blank), so the nearest written stage below: every written template whose lowest stage is AM1 (9 of 9) or AM2 (7 of 7) is advanced; contrary: none ('elite' is unused) (Overwatch, lane AP: the written-template rule, nearest written stage below) |
| duration_minutes | 12 | UNVERIFIED | its own items give 6 rounds (Round 1 to Round 6) and no length, and its source documents DOC-023 and DOC-022 state no mitt round length; Jason's owner system DOC-072 Workout_Map runs pad work in 2:00 rounds (W-S10-007, equipment 'mitts or pads'): 6 x 2:00 = 12 (order of basis 3: the owner system where it addresses the same activity, OWNER_DECISIONS s3; Overwatch, lane AP Q-B); contrary: DOC-022's 'Pro contests can extend up to 12 x 3-minute rounds', 6 x 3 = 18. Caveat: pad round length from DOC-072 Workout_Map (W-S10-007); rest between rounds not counted; DOC-022 and DOC-023 state no mitt round length |

Sheets named in the label:
- difficulty: LR-073 (wtp_0b2bb48d17e3be, Phase 3 — Advanced — Strength session — Phase 3 maintenance, 55 min; lowest stage AM1, written difficulty advanced)
- difficulty: LR-079 (wtp_060d401d23d474, Phase 4 — Elite / Champion-tier — Mid-camp week Tuesday; lowest stage AM2, written difficulty advanced)
- duration_minutes: DOC-072 W-S10-007 via trk_5ca8d83f2a1a66 (owner passage, Workout_Map "SKILL-10 Body Attack After Defensive Trigger Session": Equipment "timer, partner/coach, mitts or pads, legal body target marker, cones/ring line, notebook"; Rounds "5-min setup; 3 x 2:00 single straight defend-return; 2 x 2:00 defend or exit; ...")
- duration_minutes: DOC-022 (trk_24e2dcbf4b0edc, group "DOC-022 lines 123-184", DIRECT CLAIM LIMITS: "Pro contests can extend up to 12 x 3-minute rounds")

### Template E - Fight-Plan Mitts (`wtp_e2302f73a5d19a`)

Stages PR1, PR2, PR3, PR4, PR5; contact structure `contact`; age band "18+"; sources DOC-023, DOC-022, Jason 2026-10-30 (D-PK56).

Written, not drafted: session_type "technical"; intent "rehearse 1 primary strategy, 2-3 tactics, 2 contingencies, 1 safety reminder.".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| difficulty | advanced | UNVERIFIED | no template whose lowest stage is PR1-PR5 writes a difficulty (its own stage PR1 has only mitt templates A-E, all blank), so the nearest written stage below: every written template whose lowest stage is AM1 (9 of 9) or AM2 (7 of 7) is advanced; contrary: none ('elite' is unused) (Overwatch, lane AP: the written-template rule, nearest written stage below) |
| duration_minutes | 12 | UNVERIFIED | its own items give 6 rounds (Round 1 to Round 6) and no length, and its source documents DOC-023 and DOC-022 state no mitt round length; Jason's owner system DOC-072 Workout_Map runs pad work in 2:00 rounds (W-S10-007, equipment 'mitts or pads'): 6 x 2:00 = 12 (order of basis 3: the owner system where it addresses the same activity, OWNER_DECISIONS s3; Overwatch, lane AP Q-B); contrary: DOC-022's 'Pro contests can extend up to 12 x 3-minute rounds', 6 x 3 = 18. Caveat: pad round length from DOC-072 Workout_Map (W-S10-007); rest between rounds not counted; DOC-022 and DOC-023 state no mitt round length |

Sheets named in the label:
- difficulty: LR-073 (wtp_0b2bb48d17e3be, Phase 3 — Advanced — Strength session — Phase 3 maintenance, 55 min; lowest stage AM1, written difficulty advanced)
- difficulty: LR-079 (wtp_060d401d23d474, Phase 4 — Elite / Champion-tier — Mid-camp week Tuesday; lowest stage AM2, written difficulty advanced)
- duration_minutes: DOC-072 W-S10-007 via trk_5ca8d83f2a1a66 (owner passage, Workout_Map "SKILL-10 Body Attack After Defensive Trigger Session": Equipment "timer, partner/coach, mitts or pads, legal body target marker, cones/ring line, notebook"; Rounds "5-min setup; 3 x 2:00 single straight defend-return; 2 x 2:00 defend or exit; ...")
- duration_minutes: DOC-022 (trk_24e2dcbf4b0edc, group "DOC-022 lines 123-184", DIRECT CLAIM LIMITS: "Pro contests can extend up to 12 x 3-minute rounds")

### The First 90 Days — A Concrete Start — Weeks 1–4 Sunday (`wtp_5df3589b9085d2`)

Stages T1; contact structure `non_contact`; age band "any"; sources LR-198.

Written, not drafted: difficulty "beginner"; intent "Rest".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| session_type | rest | INFERRED | its only item is a rest block and its own text 'Rest'; no in-use session type fits a rest day, so 'rest' (Overwatch, lane AP Q4 A) |
| duration_minutes | 20 | UNVERIFIED | its own items state no minutes ('Rest' -> Rest 20); the same document's (The Long Road) written off days of the same contact structure, which write 20 (Overwatch, lane AP Q2) |

Sheets named in the label:
- duration_minutes: LR-050 (wtp_84cb2cf887a94a, Phase 1 — Foundation / Novice — Scenario A Sunday; T1, non_contact, written 20 min)
- duration_minutes: LR-050 (wtp_485b1e28f6cf9a, Phase 1 — Foundation / Novice — Scenario C Sunday; T1, non_contact, written 20 min)

### The First 90 Days — A Concrete Start — Weeks 1–4 Wednesday (`wtp_aa6e79d35d0ec7`)

Stages T1; contact structure `non_contact`; age band "any"; sources LR-198.

Written, not drafted: session_type "conditioning"; difficulty "beginner"; intent "Rest or 25 min easy bike + mobility".

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| duration_minutes | 25 | INFERRED | its own stated minutes: conditioning '25 min' |
