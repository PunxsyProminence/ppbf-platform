# Lane YR: AI drafts of blank template fields (review sheet)

Ruling: OD-2026-11-17-001 (Jason: "B: AI drafts the values"). 17 of the 27 loaded youth and recreational templates have blank required fields: `session_type` 17, `difficulty` 17, `duration_minutes` 7 and `intent` 2, 43 values in all. Each is drafted by the order of basis below: from the template's own frozen content where it has the answer, otherwise from its source document's matching sheet. The four fields stay required.

## Order of basis (Overwatch, applying OD-2026-11-17-001)

1. The template's own content: its name, items, stated minutes, stage keys and source. A value from here is labelled `INFERRED`.
2. Otherwise, the same source document's sheet that matches the template's contact structure. A value from here is labelled `UNVERIFIED`; its sources name the exact sheets, and its basis names any contrary values.

Jason's pick, "B: AI drafts the values", asks for values drafted, labelled as AI drafts and checked by the lane's two reviewers. The order above is Overwatch's reading of it; nothing of his is reversed. 41 values come from (1) and 2 durations from (2).

Every drafted field is labelled in `field_labels`:
- `INFERRED` or `UNVERIFIED`, as above;
- the marker `draft: "AI draft, lane YR, 2026-11-17 (OD-2026-11-17-001)"`;
- its `basis` and its sources.

Jason does not review these drafts (OD-2026-11-15-011). Both adversarial reviewers pass this sheet before merge, and a miss is fixed by a new template version.

A written value is never drafted over: the 10-minute "permanent circuit" (`wtp_b314d9a0582d20`) keeps its written 10 (YR-a widens the check to 1-180).

Not drafted, because they are not loaded: the six DOC-136 home-program days, held out under OD-2026-10-02-013 answers 2A and 4A (Overwatch, option B). They are `wtp_40b6956ea37245`, `wtp_0f42c41a78dea4`, `wtp_fb399b5d31e70d`, `wtp_35c593e3b96cdf`, `wtp_b965c8174bd41a` and `wtp_f20745471ef7c4`.

## Rules used

- **session_type:** one of the eight values already on committed templates, read from the template's own name, intent and items. The eight are technical, footwork, defense, sparring, conditioning, strength, tactical and observation.
  - Where every item is a warm-up or a cool-down block, the app's own item block word (`warmup`, `cooldown`) is used.
  - **Flag:** those two are new session_type values; no in-use value fits a warm-up or cool-down protocol.
- **difficulty:** the lowest stage the template serves, read as the Backbone's written templates of the same lowest stage show it (Overwatch):
  - `beginner`: lowest stage Y1-Y2, T1 or FT1, or all ages (the written T1/RC1 templates are `beginner`);
  - `intermediate`: lowest stage Y3-Y5, or T2 (the written T2, T2/RC1 and T2/AM1/RC1 templates are `intermediate`);
  - `advanced`: lowest stage AM1 or above (the written AM1 and AM2/AM3 templates are `advanced`).
  - RC1 does not change the level, and neither does a template's name.
- **duration_minutes:** the template's own stated length or range (its upper end), else the sum of its own item times; where a range's items add up to more, the basis says so.
  - Where the record states no minutes at all: order of basis (2), labelled `UNVERIFIED`.
- **intent:** the template's own block titles and source lines in plain words. Nothing is added that its items do not say.

## Drafts

### The Cool-Down — Standard Protocol (`wtp_0053dde5c924db`)

Stages T1, T2, AM1, AM2, AM3, PR1, PR2, PR3, PR4, PR5, RC1; contact structure `non_contact`; age band "any"; sources LR-237, Jason 2026-10-30 (D-PK62).

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| session_type | cooldown | INFERRED | every item is a cool-down block (blocks: cooldown x7); no in-use session type fits, so the app's own item block word |
| difficulty | beginner | INFERRED | rule: difficulty follows the lowest stage the template serves, as the Backbone's own written values do: lowest stage T1/RC1, non-contact, unloaded (easy movement, mobility, breathing) |
| duration_minutes | 10 | INFERRED | its own use_rule: "8–10 minutes" (upper end); its item times add up to 11 |

### Conditioning session A — SIT, 45 min (`wtp_01de3f48606d4c`)

Stages T1, T2, AM1, AM2, AM3, PR1, PR2, PR3, PR4, PR5, RC1; contact structure `non_contact`; age band "any"; sources LR-225, Jason 2026-10-30 (D-PK62).

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| session_type | conditioning | INFERRED | its name "Conditioning session A — SIT"; main set block conditioning |
| difficulty | beginner | INFERRED | rule: difficulty follows the lowest stage the template serves, as the Backbone's own written values do: lowest stage T1/RC1 (the written T1 conditioning, sparring and strength templates are beginner) |

### Youth Boxing Curriculum System — Class Structure (`wtp_151338565aea69`)

Stages Y1, Y2, Y3, Y4, Y5; contact structure `non_contact`; age band "youth: Y1 to Y5 by age (5 to 18)"; sources DOC-156, Jason 2026-10-25 (D-PN10: PPBF owner-authored), Jason 2026-11-04 (side-job card TR-Q01, A).

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| session_type | technical | INFERRED | its items: skill instruction and skill drills (2 of 5 parts), with warm-up, conditioning and reflection |
| difficulty | beginner | INFERRED | rule: difficulty follows the lowest stage the template serves, as the Backbone's own written values do: lowest stage Y1; non-contact |
| duration_minutes | 60 | INFERRED | its own record: the DOC-027 owner passage carried beside its items, "Base 60 Minute Session Template" (Session Templates and Weekly Build Patterns Source Manual v3), gives the class's block shape as a 60-minute session. The gym's youth sheets agree: the 48-session youth manual's session_minutes 60 (DOC-151, trk_c517c15740fb41) and the non-contact after-school sheet's "Session Length: 60 Minutes" (DOC-091, wtp_3557c34e022c31). Contrary: "About 30 to 45 minutes" (wtp_840621865a088d, an active recovery session, not a class). |

### Advanced Non-Contact Trial Session (60 Minutes) (`wtp_1696a57348cd45`)

Stages Y3, Y4, Y5; contact structure `non_contact`; age band "youth: Y3 (ages 12-14), Y4 (ages 14-16) and Y5 (ages 16-18) by age"; sources DOC-091, Jason 2026-10-25 (D-PN10), Jason 2026-10-30 (D-PK56).

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| session_type | technical | INFERRED | its technique work (technical precision rounds 0:05–0:20, defense and reaction 0:35–0:48, perfect round challenge 0:48–0:55: 35 of 60 min) outweighs its conditioning circuit (0:20–0:35, 15 min) |
| difficulty | intermediate | INFERRED | rule: difficulty follows the lowest stage the template serves, as the Backbone's own written values do: lowest stage Y3. Its name says "Advanced"; the convention goes by stage, not by name. |
| intent | Technical precision rounds, a conditioning circuit, defense and reaction rounds and a perfect round challenge, closed by a leadership reflection; no contact. | INFERRED | its own block titles after the opening start block, in order, and its contact structure non_contact |

### Advanced Contact Sparring Simulation (`wtp_16acacbeaa1eeb`)

Stages T2, AM1, AM2, AM3, RC1; contact structure `split_non_contact_then_contact`; age band "adult contact stages: T2, AM1, AM2, AM3, RC1"; sources DOC-091, Jason 2026-10-25 (D-PN10: PPBF owner-authored), Jason 2026-11-04 (card CM-PK01, A, in side job 'PPBF Side Job Cowork Merge Draft': this job holds the pre-manual), Jason 2026-11-04 (side-job card TR-Q11, A).

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| session_type | sparring | INFERRED | its name "Advanced Contact Sparring Simulation"; 4 sparring blocks (60 of 90 min) |
| difficulty | intermediate | INFERRED | rule: difficulty follows the lowest stage the template serves, as the Backbone's own written values do: lowest stage T2, with RC1, as the written T2/AM1/RC1 and T2/RC1 templates (wtp_080c41583b3757, wtp_7069f515b9b84e, wtp_da83ce464ffa96), all intermediate. Its name says "Advanced"; the convention goes by stage, not by name. |

### Friday Sparring Coach Sheet (`wtp_1ad3c846b03ecc`)

Stages Y3, Y4, Y5; contact structure `contact`; age band "youth: Y3 (ages 12-14), Y4 (ages 14-16) and Y5 (ages 16-18) by age"; sources DOC-091, Jason 2026-10-25 (D-PN10), Jason 2026-10-30 (D-PK56).

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| session_type | sparring | INFERRED | its name "Friday Sparring Coach Sheet"; sparring drill rounds and open sparring |
| difficulty | intermediate | INFERRED | rule: difficulty follows the lowest stage the template serves, as the Backbone's own written values do: lowest stage Y3 |

### Wednesday Coach Sheet Defense Day (`wtp_3557c34e022c31`)

Stages Y3, Y4, Y5; contact structure `non_contact`; age band "youth: Y3 (ages 12-14), Y4 (ages 14-16) and Y5 (ages 16-18) by age"; sources DOC-091, Jason 2026-10-25 (D-PN10), Jason 2026-10-30 (D-PK56).

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| session_type | defense | INFERRED | its name "Defense Day" and focus "Slip • Roll • Guard Recovery" |
| difficulty | intermediate | INFERRED | rule: difficulty follows the lowest stage the template serves, as the Backbone's own written values do: lowest stage Y3 |

### Strength session B — upper explosive + power, 70 min (`wtp_4346e280d811e3`)

Stages T1, T2, AM1, AM2, AM3, PR1, PR2, PR3, PR4, PR5, RC1; contact structure `non_contact`; age band "any"; sources LR-223, Jason 2026-10-30 (D-PK62).

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| session_type | strength | INFERRED | its name "Strength session B — upper explosive + power" |
| difficulty | beginner | INFERRED | rule: difficulty follows the lowest stage the template serves, as the Backbone's own written values do: lowest stage T1/RC1 (the written T1 strength template is beginner) |

### Iso + Plyo 60-Minute Boxing Session – FULL Coach Execution Manual (`wtp_456e418b1741b8`)

Stages T1, T2, AM1, AM2, AM3, PR1, PR2, PR3, PR4, PR5, RC1, FT1; contact structure `non_contact`; age band "adult stages and FT1 (any age on FT1)"; sources DOC-089, Jason 2026-11-04 (side-job card TR-Q02, A: PPBF owner-authored), Jason 2026-11-04 (side-job card TR-Q01, A).

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| session_type | strength | INFERRED | its goal "Build tension (iso), convert to explosive power (plyo)"; the power block is the longest (18:00–35:00) |
| difficulty | beginner | INFERRED | rule: difficulty follows the lowest stage the template serves, as the Backbone's own written values do: lowest stage T1 and FT1 (any age on FT1); bodyweight iso and plyo, non-contact |

### VERTICAL LINE & HOOK PLANE AWARENESS SESSION (`wtp_4b192f174699bc`)

Stages Y3, Y4, Y5; contact structure `non_contact`; age band "youth: Y3 (ages 12-14), Y4 (ages 14-16) and Y5 (ages 16-18) by age"; sources DOC-091, Jason 2026-10-25 (D-PN10), Jason 2026-10-30 (D-PK56).

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| session_type | technical | INFERRED | its items: mirror awareness, mirror movement, shadowboxing and partner application |
| difficulty | intermediate | INFERRED | rule: difficulty follows the lowest stage the template serves, as the Backbone's own written values do: lowest stage Y3 |
| duration_minutes | 60 | UNVERIFIED | UNVERIFIED: the record states no minutes. Its source document's non-contact sheets state 60: "Session Length: 60 Minutes" (wtp_3557c34e022c31), "Advanced Non-Contact Trial Session (60 Minutes)" (wtp_1696a57348cd45), "Scripted 60-Minute Class" (wtp_900c0a3fd4422a). Contrary: DOC-091's contact sheets state 90 and 120. |

### FULL ACTIVE RECOVERY BOXING SESSION (`wtp_840621865a088d`)

Stages Y1, Y2, Y3, Y4, Y5, T1, T2, AM1, AM2, AM3, PR1, PR2, PR3, PR4, PR5, RC1, FT1, EX1; contact structure `non_contact`; age band "all ages"; sources DOC-089, Jason 2026-11-04 (side-job card TR-Q02, A: PPBF owner-authored), Jason 2026-11-04 (side-job card TR-Q01, A).

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| session_type | technical | INFERRED | its own words: technical shadowboxing is "the heart of the session"; "This is not a conditioning workout" |
| difficulty | beginner | INFERRED | rule: difficulty follows the lowest stage the template serves, as the Backbone's own written values do: serves every stage from Y1 and all ages; non-contact, recovery |
| duration_minutes | 45 | INFERRED | its own total: "About 30 to 45 minutes" (upper end); its parts, at the top of each range and without the optional walk, add up to about 48 |

### Scripted 60-Minute Class (test run 4-5) (`wtp_900c0a3fd4422a`)

Stages Y3, Y4, Y5; contact structure `non_contact`; age band "youth: Y3 (ages 12-14), Y4 (ages 14-16) and Y5 (ages 16-18) by age"; sources DOC-091, Jason 2026-10-25 (D-PN10), Jason 2026-10-30 (D-PK56).

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| session_type | technical | INFERRED | its technical rounds block (footwork, jab, slip, jab-cross), the teaching block; the conditioning block runs as long (15 min) |
| difficulty | intermediate | INFERRED | rule: difficulty follows the lowest stage the template serves, as the Backbone's own written values do: lowest stage Y3 |
| duration_minutes | 60 | INFERRED | its name "Scripted 60-Minute Class"; its items run 4:00–5:00 |
| intent | Footwork, jab and slip technique rounds, a conditioning block and a shadowboxing integration round, closed by stretching and a reflection on discipline. | INFERRED | its own block titles after the opening warm-up, in order, and its source line "Topic: Discipline" |

### The Warm-Up — Standard Protocol (`wtp_9e9710b7ff5736`)

Stages T1, T2, AM1, AM2, AM3, PR1, PR2, PR3, PR4, PR5, RC1; contact structure `non_contact`; age band "any"; sources LR-236, Jason 2026-10-30 (D-PK62).

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| session_type | warmup | INFERRED | every item is a warm-up block (blocks: warmup x7); no in-use session type fits, so the app's own item block word |
| difficulty | beginner | INFERRED | rule: difficulty follows the lowest stage the template serves, as the Backbone's own written values do: lowest stage T1/RC1, non-contact, unloaded |
| duration_minutes | 15 | INFERRED | its own use_rule: "12–15 minutes" (upper end); its item times add up to 16 |

### Wednesday – Gold Standard Coach Script (`wtp_9fbf7f8edf5016`)

Stages Y3, Y4, Y5; contact structure `split_non_contact_then_contact`; age band "youth: Y3 (ages 12-14), Y4 (ages 14-16) and Y5 (ages 16-18) by age"; sources DOC-091, Jason 2026-10-25 (D-PN10), Jason 2026-10-30 (D-PK56).

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| session_type | technical | INFERRED | its first hour (4:00–5:00, non-contact drills) and theme "Perception → Decision → Composure → Execution"; the second hour is contact |
| difficulty | intermediate | INFERRED | rule: difficulty follows the lowest stage the template serves, as the Backbone's own written values do: lowest stage Y3 |

### The permanent circuit — every warm-up, forever, ~10 min (`wtp_b314d9a0582d20`)

Stages Y1, Y2, Y3, Y4, Y5, T1, T2, AM1, AM2, AM3, PR1, PR2, PR3, PR4, PR5, RC1, FT1, EX1; contact structure `non_contact`; age band "any"; sources LR-171, Jason 2026-10-30 (D-PK62).

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| session_type | warmup | INFERRED | every item is a warm-up block (blocks: warmup x7); its name "every warm-up, forever" |
| difficulty | beginner | INFERRED | rule: difficulty follows the lowest stage the template serves, as the Backbone's own written values do: serves every stage from Y1 and all ages; unloaded |

### WEEK 1 | TUESDAY HARD LOAD | FLOW CARD (`wtp_c5d6897640434c`)

Stages Y3, Y4, Y5; contact structure `contact`; age band "youth: Y3 (ages 12-14), Y4 (ages 14-16) and Y5 (ages 16-18) by age"; sources DOC-091, Jason 2026-10-25 (D-PN10), Jason 2026-10-30 (D-PK56).

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| session_type | tactical | INFERRED | its rule "score clean, exit immediately, do not chase" and its entry, score and exit rounds |
| difficulty | intermediate | INFERRED | rule: difficulty follows the lowest stage the template serves, as the Backbone's own written values do: lowest stage Y3 |
| duration_minutes | 120 | UNVERIFIED | UNVERIFIED: the record states no minutes. Its contact structure is contact, and the contact sheet in its own track (trk_bfd0fb2129bc8d), wtp_1ad3c846b03ecc, states 120: "Training Block: 3:30 PM to 5:30 PM". The track's split-structure sheet wtp_9fbf7f8edf5016 also states 120: "Time: 4:00 PM – 6:00 PM". Contrary: "90-Minute Training Session" (wtp_16acacbeaa1eeb, DOC-091, split structure) and DOC-091's non-contact sheets, 60. |

### Session structure for skill development (`wtp_f2488df4fa331a`)

Stages T1, T2, AM1, AM2, AM3, PR1, PR2, PR3, PR4, PR5, RC1; contact structure `contact`; age band "any"; sources LR-116, Jason 2026-10-30 (D-PK62).

| Field | Draft | Label | Basis |
| --- | --- | --- | --- |
| session_type | technical | INFERRED | its name "Session structure for skill development"; acquisition and refinement blocks (40 of its 95 item minutes; its written length is 90) |
| difficulty | beginner | INFERRED | rule: difficulty follows the lowest stage the template serves, as the Backbone's own written values do: lowest stage T1/RC1 (the written T1 sparring templates with controlled sparring are beginner) |

## Flags for the reviewers

- `UNVERIFIED` (order of basis 2), durations of records that state no minutes: `wtp_4b192f174699bc` duration_minutes = 60; `wtp_c5d6897640434c` duration_minutes = 120.
- `warmup` and `cooldown` are new session_type values: `wtp_0053dde5c924db`, `wtp_9e9710b7ff5736`, `wtp_b314d9a0582d20`.
- The active recovery session (`wtp_840621865a088d`) is drafted `technical`, from its own words ("the heart of the session" is technical shadowboxing; "not a conditioning workout"). A coach may file it as recovery.

## Reviewer marks

- Fidelity reviewer: PENDING
- Scoping reviewer: PENDING
