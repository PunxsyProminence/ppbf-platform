STATUS: NOT APP SOURCE — research for Jason's review
TOPIC: App scrub stage 3: ranked fix list in 13 build batches, every stage 1 finding placed, order, size and lane fit
DATE: 2026-11-19
ASKED BY: Jason (cards OW25-43 A and OW25-44, 2026-11-18; stage 2 cards S2-1 to S2-5, 2026-11-19)

## 1. Answer
- All 144 problems from stage 1 are sorted into 13 build batches, about 36 to 49 small pull requests in all (estimate).
- First come three small batches that need no redesign: screens that say false things or lead nowhere (all 6 serious problems), sign-out on the shared gym tablet, and the medical-stop mark used for ordinary errors.
- Next is the job bar and Search, which everything else hangs on. Then the coach safety page, the class screen and the coach home, then athlete, parent and office.
- Run one usability build lane at a time, because these batches edit the same menu and home files. It fits your two-lane limit by taking the clean-up slot.
- You answered Q1 to Q4 (OW25-45 to OW25-48), and lane SH is building them with the other serious fixes. Q5 still holds back AS-2, and new Q6 asks where the next batch runs.

## 2. Recommendation
For Jason to decide. A finding is not a decision; nothing here is built until you approve it.

- **A (Recommended): run AS-1 to AS-13 in this order in one usability lane.** While AS-1 to AS-3 build (they do not depend on the redesign), walk the stage 2 sketches on the gym tablet, a phone and the TV, with one coach, one athlete and one parent if you can. AS-4 starts after that walk. After AS-4 and each home batch, you check it on staging, as G3 already asks for sign-in, minors' data and safety screens.
  - Pros: the 6 serious problems go first and are small; the shell lands before the homes, so no home is built twice; one lane owns the shared files, so no merge fights.
  - Cons: the full redesign is long (36 to 49 pull requests in one lane); coaches wait for AS-4 to AS-7 before the floor feels different.
- **B: fixes only for now.** Run AS-1 to AS-3 (about 6 to 9 pull requests), then decide on the redesign (AS-4 onward) after the pilot has run longer.
  - Pros: least change while the pilot runs. Cons: the navigation problems Jason saw stay (79 menu entries for a coach, about 30 to 35 taps for a head knock).
- **C: redesign first.** Run AS-4 to AS-7 first and fold the fixes into them.
  - Pros: the coach floor changes soonest. Cons: the 6 serious problems wait weeks; batches get bigger than the 400-line lane size.

**Questions for Jason**

Update, 2026-11-19: you answered Q1 to Q4 as cards OW25-45 to OW25-48 (CARDS_OW25.md, sha256[:16] 346e3a46b7813cee, OBSERVED). Overwatch then issued lane SH for those four plus OFF-02, BOA-01 and BOA-02 (STATUS.md line 524 and LANE_SH_SCRUB_HIGH_BRIEF.md, OBSERVED). Only Q5 is still open.

| Question | Your answer | Effect on the batches |
|---|---|---|
| Q1 Who sets clearance | OW25-45 B: coaches and the office both set it, on the Clearance Board, and the words say so; the Decision Loop control moves there | CS-01 is in lane SH (SH-2). AS-5 builds the Athlete safety page around this |
| Q2 PIN reset words | OW25-46 A: "ask the gym office" | OFF-01 is in lane SH (SH-4) |
| Q3 Parent safety line | OW25-47 A: count restrictions and missing waivers, and name the child | FAM-01 is in lane SH (SH-3) |
| Q4 Critical escalation mark | OW25-48 A: the medical-stop mark only for a medical stop | CS-10 and CF-19 are in lane SH (SH-1); the rest of AS-3 is unchanged |
| Q5 Gym tablet idle time | open | AS-2 |

**Q6 (new). Official form:** Where does the next no-redesign scrub batch (AS-1 remainder, then AS-3) run?

The rulings conflict here, and this file does not settle it. OD-2026-11-16-005 caps Claude Code build lanes at two. OD-2026-11-19-001 (main `a0f70fb2`, line 691) says it does not rule on any change to that cap. Overwatch's STATUS.md (line 524) runs three build lanes, R6-a, NW and SH, "per OD-2026-11-19-001" (all OBSERVED).
- **A (Recommended):** Lane SH continues into it after SH-4 merges, under G6 ("continue only with a next item in the same area"). It needs no new session, and SH already knows these files.
- **B:** A separate scrub lane starts in its own worktree when R6-a or NW closes, and stays off SH's files.
- **C:** A separate scrub lane starts now, as a fourth build lane. This needs your ruling on the cap.

Plain English: A keeps the scrub fixes in the session already doing them. B and C open another session; C makes four at once.

Also for Overwatch, not a question: record your S2-2 (job bar) and S2-3 (one job page) answers as changes to OD-2026-10-17-001 rulings 4 and 3 before AS-4 and AS-5 are briefed. This file does not record them.

## 3. Findings

### 3.1 How the list is ranked (INFERRED)
Order of priority, highest first. Each rule comes from the pack or an owner decision; using them to rank is my reasoning.
1. Screens that state something false or offer a control that does nothing. Pack 02 says no fake controls or invented data, and an unknown value never looks complete. All 6 HIGH findings are of this kind or close to it: a screen says something untrue, asks for a step it gives no way to do, or opens empty (stage 1, 3.10).
2. Privacy of minors on shared devices (ATH-10; S2-4 A).
3. Breaches of pack 02 binding rules: the medical-stop mark means only that, colour is never the only channel, and kiosk text and target floors.
4. The shell every home depends on (job bar, Search, back links). Building homes first would mean building them twice.
5. Safety paths. OD-2026-09-19-001 says safety information is never deep, but the head-knock trace is about 30 to 35 taps (stage 1, CS T1).
6. Daily-use flows, by how often and by how many people: class (every session), coach home, athlete tablet, parent phone, office desk.
7. Tidy-ups for few users (board, platform, lab).
8. Words that are left over.

### 3.2 The 13 batches, in run order
Sizes are pull requests of about 400 changed lines or fewer, not counting tests (lane size rule G5). Line counts of the main files are OBSERVED in the mirror at `045c0bd7`. PR counts are estimates (INFERRED).

| # | Batch | What changes (proposal) | Who gains | Findings fixed (H/M/L) | Size (PRs) |
|---|---|---|---|---|---|
| AS-1 | Honesty and safety fixes (no redesign needed) | Screens stop saying things the app does not do: PIN reset words, the parent safety line, where clearance is set, 'Start a session', 'Full list', Group / One-on-One, Revenue payment placeholders, no-op Capabilities buttons, Scout and store fake buttons. Admin gets the existing TV pairing panel. Calibration pages get a clip link or picker. | Everyone; fixes all 6 HIGH findings | 14 (6/6/2) | 2–3 |
| AS-2 | Gym tablet idle sign-out (S2-4 A) | On the shared gym tablet a signed-in screen shows a countdown, then signs out unless someone taps. Time per Q5. | Athletes (minors) on the shared tablet; parents | 1 (0/1/0) | 1–2 |
| AS-3 | Medical-stop mark and floor-size sweep (outside the three homes) | The medical-stop colour leaves load errors, 'ADMINS ONLY', overdue grants and similar states; they take the warning or restricted style with a glyph and a word. Floor pages missing the kiosk surface get it; the HELP toggle loses its 44 px override. | All roles; keeps pack 02 rule 1 true | 9 (0/6/3) | 3–4 |
| AS-4 | Shell: job bar, Search with All pages, back links, tab in the address (S2-2 A) | Each role gets its 3 to 5 job sections on every page (bottom bar on a phone, side rail on a tablet). Search replaces Jump; the Rooms list becomes 'All pages' inside Search. Lab doors go to a Lab group. Every dead-end page gets a way home. Going back keeps the open tab. Plain links on floor pages reach 55 px. Menus show only pages the person can open. | Every role on every device | 22 (0/14/8) | 4–5 |
| AS-5 | Coach safety job pages: Athlete safety, Sparring and limits (S2-3 A) | One page per athlete holds training hold, injury record, USA Boxing medical restriction, tell the family and return to training, with status at the top; old addresses open the right section. One Sparring and limits page shows minor status, cap and restriction before a sparring entry. The Safety badge's table rows link to the athlete. | Coaches; athletes (minors) and parents indirectly | 6 (0/6/0) | 4–5 |
| AS-6 | Class screen (S2-5 A) | Today's class rows open one class screen: who is here (register), the plan block, round timer, Send to TV, pain reports by name with a link, well done, sparring segment, floor groups. One register word for coaches. Test Day picks a class first. One TV clock question settled. | Coaches every session; athletes see the TV | 8 (0/6/2) | 3–4 |
| AS-7 | Coach task home (S2-1 A) | The coach home fits one tablet screen: a needs-you strip (safety escalations, pain reports, cards to verify), four job buttons (Run tonight's class, Athletes, Plan, Safety) and a More line. The code-written Floor tab template goes. Read-only SHADOW cards link to SHADOW Intel. Escalation border per Q4. Open tab carries a mark, not colour alone. | Coaches | 7 (0/4/3) | 3–4 |
| AS-8 | Athlete Today and Progress (S2-1 A, S2-4 A) | The tablet opens on I'm here and How I feel today; End training sits beside Start training; one Start training; walk-ins see today's open classes; film, progression, plan and mental skills one tap from Progress; one Ask SHADOW; one meaning per 'Corner'; kiosk text 19.1 px; reduced motion on the pain jump. | Athletes, many of them minors | 18 (0/9/9) | 3–4 |
| AS-9 | Parent home, Safety and consent, This week, Progress, Messages | Safety and consent first on the phone; a child picker that remembers; one SHADOW entry; counts name the child; Messages empty state points somewhere real; parent email-link sign-in first; film and progress pages under Progress; one family ground on safety and consent pages. | Parents and guardians | 24 (0/14/10) | 4–5 |
| AS-10 | Gym Office home, Morning check, New member, Sign-in codes, Setup | One morning-check list on Gym Office (a count and link per queue); a roster search and role filter; one new-member path (athlete, guardian, waivers, sign-in code, each step with Next); one place to issue codes; Setup linked and returning; Safety Review rows link to where they are acted on. | Gym admin and office staff | 14 (0/8/6) | 4–5 |
| AS-11 | Athletes: Who needs you, athlete page, Interventions | One athlete page links passbook, plan, tests, cards and interventions; links carry the drill or athlete they name; planning limits named on Session Plans; empty pickers say what to do first. | Coaches | 4 (0/2/2) | 2–3 |
| AS-12 | Office, board and platform tidy | Board links under the header and on the hub; seat wording by the viewer's access; President links to Board Seats; payment secret steps move to the platform owner; Customize gets an index; one wording for suppressed figures; Retro Lab out of Gym Floor; /director/dashboard redirects. | Board members, gym admin, platform owner | 14 (0/7/7) | 2–3 |
| AS-13 | One name per thing (words sweep) | Link labels match page titles (ruling 1) where earlier batches left them: film sharing words, SHADOW research links, Clearance Board footer names. | All roles | 3 (0/1/2) | 1–2 |
| | **Total** | | | **144 (6/84/54)** | **36–49** |

### 3.3 Batch details: screens, files, what holds it back, review route, done when
Files are where each change most likely lands, taken from the stage 1 evidence lines (INFERRED). Line counts in brackets are OBSERVED. The review route quotes the existing rules; Overwatch chooses.

**AS-1 Honesty and safety fixes (no redesign needed)**
- Findings: BOA-01, BOA-02, CS-01, FAM-01, OFF-01, OFF-02, CF-04, CF-05, CF-14, CS-04, OFF-12, OFF-16, CS-17, FAM-21.
- Screens: /login, /parent/dashboard, /coach/sports-medicine, /coach/decision-loop (words only), coach home floor board, /admin (Capabilities, Revenue tab), /admin/setup TV line, /admin/calibration/adjudicate, /admin/calibration/review, /shadow/scout, /store/[organizationId], /admin/athletes.
- Main files: SignInPanel.tsx (849), ParentHub.tsx (2,180; one block), sports-medicine (1,134) and decision-loop (1,901) one line each, CoachFloorFocus.tsx (613), RevenueFundingCenter.tsx (982), admin/page.tsx (3,084; two cards), gymSetupStatus.ts, calibration pages, buildingMap.ts (one keyword).
- Waits on: nothing. Q1 to Q3 are answered (OW25-45 B, OW25-46 A, OW25-47 A). The six HIGH items are in lane SH (SH-2 to SH-4). Left for the next lane: CF-04, CF-05, CF-14, CS-04, CS-17, FAM-21, OFF-12, OFF-16.
- Review route: Mixed: the PIN, parent-safety and clearance PR touches sign-in, minors' data and safety (Opus under G5 and U1; Jason staging check under G3); the rest Sonnet.
- Done when (user outcome, proposal): No screen promises a control, a person or a connection that does not exist; an admin can pair a TV from the setup line.

**AS-2 Gym tablet idle sign-out (S2-4 A)**
- Findings: ATH-10.
- Screens: every kiosk-surface page while signed in (shell).
- Main files: GlobalRoleHeader.tsx (313) or the kiosk shell; ProfileSettings.tsx sign-out path.
- Waits on: Q5 (who sets the time, first value).
- Review route: Opus (sign-in, minors' data, G5); Jason staging check (G3).
- Done when (user outcome, proposal): A tablet left signed in signs itself out after the set time, and the countdown shows first.

**AS-3 Medical-stop mark and floor-size sweep (outside the three homes)**
- Findings: ATH-11, BOA-15, CF-18, CS-09, CS-10, OFF-10, ATH-13, ATH-14, CF-24.
- Screens: about 40 route files: 10 coach pages (CS-09), 21 of 35 office route files (OFF-10), board and platform pages (BOA-15), /notices, athlete sign-in, /activate, /change-pin, Safety badge, 9 desk-sized floor pages (CF-24).
- Main files: class swaps in many files; SafetyAttentionBadge.tsx (427); RoleSummaryPanels.tsx; no home files.
- Waits on: nothing. Q4 is answered (OW25-48 A); CS-10, plus admin/escalations and the board tile, are in lane SH (SH-1).
- Review route: Sonnet; the Safety badge PR and the sign-in pages go the Opus route (safety, sign-in).
- Done when (user outcome, proposal): Outside the three homes, the medical-stop mark appears only for a medical stop, and every floor page carries the kiosk floor.

**AS-4 Shell: job bar, Search with All pages, back links, tab in the address (S2-2 A)**
- Findings: ATH-09, BOA-05, BOA-08, BOA-09, BOA-10, BOA-14, CF-10, CF-16, CF-17, CS-11, FAM-06, FAM-16, OFF-04, OFF-14, ATH-16, ATH-18, BOA-21, CF-20, CS-13, CS-14, CS-15, OFF-22.
- Screens: header on all 165 routes; 26 pages with no in-page way home or one that goes to the wrong place: CF-20 (9), OFF-04 (6), BOA-10 (7), ATH-18 (2), CS-14 (1), FAM-16 (1); plus one bottom-only exit (BOA-21); board seat links; /research links; Operations table.
- Main files: GlobalRoleHeader.tsx (313), buildingMap.ts (891), CardCatalog.tsx (663), Corridor.tsx (157), ClusterNav.tsx (97), globals.css (2,887); small edits in CoachWorkspace, AthleteWorkspace, ParentHub for the tab in the address.
- Waits on: Overwatch records the S2-2 change to OD-2026-10-17-001 ruling 4; the Stage 2 walk-through on the tablet (Recommendation A).
- Review route: Sonnet for layout; the menu-by-role filter PR is about who sees what (Opus if Overwatch counts it as permissions); Jason staging check.
- Done when (user outcome, proposal): On every page each role sees its job bar, Search finds any page by name, no page is a dead end, and back keeps the tab.

**AS-5 Coach safety job pages: Athlete safety, Sparring and limits (S2-3 A)**
- Findings: CS-02, CS-03, CS-05, CS-06, CS-07, CS-08.
- Screens: /coach/sports-medicine, /coach/injuries, /coach/medical-restrictions, Decision Loop family post, /coach/sparring-exposure, /coach/sparring-caps, /coach/athlete-limits, /admin/escalations (coach view).
- Main files: sports-medicine (1,134), decision-loop (1,901), injuries (439), MedicalRestrictionsPanel.tsx (469), sparring-exposure (596), MinorLimitsPanel.tsx (433), ContactCapPanel.tsx (350), sparring-caps (110), athlete-limits (118), escalations (561).
- Waits on: Q1 and Q4 are answered (OW25-45 B, OW25-48 A); lane SH's clearance PR (SH-2) merging first; Overwatch records the S2-3 change to ruling 3.
- Review route: Opus at high effort (safety and minors, G5 and U1); Jason staging check (G3).
- Done when (user outcome, proposal): From a sparring entry marked 'Unsteady', a coach reaches hold, injury, restriction, family note and return plan on one athlete page.

**AS-6 Class screen (S2-5 A)**
- Findings: CF-01, CF-02, CF-07, CF-08, CF-09, CF-13, ATH-22, CF-26.
- Screens: /coach/session-scripts live delivery, /schedule class rows, coach home today rows, Gym TVs, /coach/test-day.
- Main files: SessionScriptLiveDelivery.tsx (1,134), session-scripts (984), SessionRunPresence.tsx (338), RoundTimerControls.tsx (313), GymTvPanel.tsx (507), schedule (1,637), test-day (374).
- Waits on: Which TV clocks show (ATH-22, Jason's call); AS-4.
- Review route: Opus for the pain-report and sparring parts (safety, minors' data); Sonnet for timer, TV and register layout; Jason staging check.
- Done when (user outcome, proposal): A coach runs a whole class without going back to the home page.

**AS-7 Coach task home (S2-1 A)**
- Findings: CF-03, CF-06, CF-12, CF-19, CF-21, CF-22, CF-25.
- Screens: /coach/environment/intake-router (Coach Workspace) and its tabs.
- Main files: CoachWorkspace.tsx (5,060), CoachFloorFocus.tsx (613), uiStyles.ts.
- Waits on: AS-4, AS-5 and AS-6 (the buttons open them). CF-19 is in lane SH (SH-1).
- Review route: Sonnet for layout; the needs-you strip PR Opus (safety); Jason staging check.
- Done when (user outcome, proposal): A coach sees what needs them and opens any of the four jobs without scrolling.

**AS-8 Athlete Today and Progress (S2-1 A, S2-4 A)**
- Findings: ATH-01, ATH-02, ATH-03, ATH-04, ATH-05, ATH-06, ATH-07, ATH-08, ATH-12, ATH-15, ATH-17, ATH-19, ATH-20, ATH-21, ATH-23, ATH-24, ATH-25, ATH-26.
- Screens: /athlete/dashboard and tabs, /athlete/sign-in, /change-pin, /athlete/video-analysis, /athlete/progression-intelligence, /profile.
- Main files: AthleteWorkspace.tsx (4,559), AthleteCorner.tsx (185), AthleteImHere.tsx, SignInPanel.tsx (PIN form).
- Waits on: AS-2, AS-4.
- Review route: Opus (minors' data, sign-in, G5); Jason staging check.
- Done when (user outcome, proposal): An athlete checks in, says how they feel, trains and ends training on one screen without scrolling for the button.

**AS-9 Parent home, Safety and consent, This week, Progress, Messages**
- Findings: FAM-02, FAM-03, FAM-04, FAM-05, FAM-07, FAM-08, FAM-09, FAM-10, FAM-11, FAM-12, FAM-13, FAM-14, FAM-15, FAM-17, FAM-18, FAM-19, FAM-20, FAM-22, FAM-23, FAM-24, FAM-25, FAM-26, FAM-27, FAM-28.
- Screens: /parent/dashboard, /parent/safety, /parent/consent, /parent/video, /parent/progression-visibility, /parent/development-blocks, /parent/mental-skills, /schedule (parent view), /login, / (public page), /store.
- Main files: ParentHub.tsx (2,180), parent/safety (430), parent/consent (346), schedule (1,637), SignInPanel.tsx (849), app/page.tsx (698).
- Waits on: AS-4; AS-1 FAM-01.
- Review route: Opus (minors' data, consent, sign-in); Jason staging check.
- Done when (user outcome, proposal): A parent sees each child's safety and consent state first, and every tab and empty state leads somewhere.

**AS-10 Gym Office home, Morning check, New member, Sign-in codes, Setup**
- Findings: OFF-03, OFF-05, OFF-06, OFF-07, OFF-08, OFF-09, OFF-11, OFF-13, OFF-15, OFF-17, OFF-18, OFF-19, OFF-20, OFF-21.
- Screens: /admin/people, /admin (Capabilities), /admin/setup, /admin/pin, /admin/activation-codes, /admin/safety-review, /admin/consent, /admin/import, /workspace.
- Main files: admin/people (2,388), admin/page.tsx (3,084), pin (461), activation-codes (362), setup (74), safety-review (351).
- Waits on: AS-4.
- Review route: Opus for codes and new member (sign-in, minors' records); Sonnet for the rest; Jason staging check.
- Done when (user outcome, proposal): The admin's morning check is one list, and a new member goes from name to sign-in code on one guided path.

**AS-11 Athletes: Who needs you, athlete page, Interventions**
- Findings: CF-11, CF-15, CF-23, CS-19.
- Screens: /coach/passbook, /coach/passbook-gaps, /coach/athlete-intelligence, /coach/intelligence, /coach/cue-library, /coach/session-scripts, /teach-shadow/annotation, intervention pages.
- Main files: passbook (300), passbook-gaps (257), athlete-intelligence (409), intelligence (271), intervention-protocols (380).
- Waits on: AS-4, AS-7.
- Review route: Sonnet; Opus if the athlete page shows health data.
- Done when (user outcome, proposal): From any athlete's name a coach reaches that athlete's whole record in one tap.

**AS-12 Office, board and platform tidy**
- Findings: BOA-03, BOA-04, BOA-06, BOA-07, BOA-11, BOA-12, BOA-13, BOA-16, BOA-17, BOA-18, BOA-19, BOA-20, BOA-22, BOA-23.
- Screens: /board/<seat>, /board, /admin/payments, /admin/customize, /admin/memberships, /admin/system, /research, /admin/platform, /admin/platform/overview, /retro-lab, /director/dashboard.
- Main files: BoardMemberDashboard.tsx (365), board/page.tsx (52), payments (262), customize (378), research (1,605).
- Waits on: AS-4.
- Review route: Sonnet; payments move Opus if it touches who may see secrets.
- Done when (user outcome, proposal): Each board member reaches the three board reads from where they land, and no page shows another role's setup steps.

**AS-13 One name per thing (words sweep)**
- Findings: CS-12, CS-16, CS-18.
- Screens: Video Analysis, Video Publications, Video Library, /shadow, /coach/sports-medicine footer.
- Main files: copy only.
- Waits on: All earlier batches (names settle first).
- Review route: Sonnet, low effort.
- Done when (user outcome, proposal): Every link label is the title of the page it opens.

### 3.4 Why one usability lane, in this order (INFERRED from the files)
These shared files are edited by more than one batch, so the batches must run one after another:

| Shared file | Batches that edit it |
|---|---|
| GlobalRoleHeader.tsx (header on every page) | AS-2, AS-4 |
| buildingMap.ts (all 144 menu entries) | AS-1 (one keyword), AS-4, AS-13 |
| CoachWorkspace.tsx (coach home, 5,060 lines) | AS-4 (tab in address), AS-7 |
| AthleteWorkspace.tsx (athlete home, 4,559 lines) | AS-4, AS-8 |
| ParentHub.tsx (parent home, 2,180 lines) | AS-1, AS-4, AS-9 |
| SignInPanel.tsx (sign-in, 849 lines) | AS-1, AS-8, AS-9 |
| schedule/page.tsx (1,637 lines) | AS-6, AS-9 |
| sports-medicine and decision-loop pages | AS-1, AS-5 |
| admin/people/page.tsx (2,388 lines) | AS-3, AS-10 |

- Separate worktrees give each session its own checkout, so edits do not collide while sessions work (Claude Code docs, REPORTED). Clashes still surface at rebase or merge time when two branches changed the same file (third-party guide, REPORTED; git behaviour, INFERRED).
- OD-2026-11-16-005 allows at most two Claude Code build lanes, with research as the third stream (OBSERVED, line 34 at `045c0bd7`). OD-2026-11-19-001 does not change that cap, but Overwatch runs three citing it (see Q6; conflict shown, not settled).
- Content lanes, such as the backbone content work, mostly touch other files. One exception was seen: a content lane added a menu entry to buildingMap.ts (2026-11-17 design check). Proposal: while AS-4 runs, other lanes' menu entries go through the usability lane or wait for AS-4 to merge.
- The OW25-51 edit path (Edit on drill and template pages, AI-draft marks; stage 2, 3.11) is a separate Claude Code lane that Overwatch requested, not an AS batch. Its likely files are the drill page, DrillDetail, the workout-templates page and the drills and templates APIs, which overlap none of AS-1 to AS-3 (INFERRED; Overwatch confirms).
- AS-3 leaves the three home files alone. Their mark and text fixes (CF-19, CF-25, ATH-12, ATH-23, FAM-13, FAM-14) ride with AS-7, AS-8 and AS-9, so no home is edited twice in a row.
- Q1 and Q4 are answered, so AS-5 no longer needs a fallback order.

### 3.5 Review route rules that apply (OBSERVED in the owner decisions)
- G5 lane size (OD-2026-09-30-003): one lane is one work item and one PR, with a file allowlist and a 'done when' sentence. It is about 400 changed lines or fewer, not counting tests, and anything bigger is split before it starts. Lanes touching sign-in, permissions, migrations or minors' data run on Opus (OWNER_DECISIONS.md lines 12445-12449).
- U1 lane models: sign-in, permissions, migrations, minors' data and safety lanes on Opus at high effort; other lanes on Sonnet at medium effort (OD-2026-09-30-007, lines 11853-11854).
- G3 (OD-2026-09-30-003): changes to screens for sign-in, minors' data or safety also need Jason's own signed-in check on staging (lines 12436-12440; narrowed for one SHADOW check only, line 11868).
- So at least one PR in 9 of the 13 batches touches safety, sign-in or minors' data: AS-1, AS-2, AS-3 (badge, sign-in pages), AS-5, AS-6, AS-7 (needs-you strip), AS-8, AS-9 and AS-10. AS-4, AS-11 and AS-12 join them only if Overwatch counts menu filtering, athlete health data or payment secrets that way (INFERRED from the batch contents).

### 3.6 Left out of every batch: FUTURE or an owner ruling first
- Parent starts a new message to the coach (FAM-09 compose box): FUTURE. AS-9 only points the empty state somewhere real.
- Adding drills or blocks to a session plan, and scheduling a class from a plan (CF-11): FUTURE. AS-11 only names the limits on screen.
- A 'who has stopped coming' page (CF-14): FUTURE. AS-1 only removes the misleading keyword.
- Coach PIN reset was not chosen (OW25-46 A). An athlete sign-in on/off switch (OFF-16) is an owner ruling; AS-1 only fixes the words.
- Kiosk idle time value (Q5) and which TV clocks show (ATH-22): Jason's call.

### 3.7 Overlap with earlier work (REDUNDANCY check)
- The October audits UX-A (A-1 to A-16) and UX-B (UXB-01 to UXB-38, batches UXB-L1 to UXB-L12) were chipped to lanes on 2026-10-17 (OVERWATCH-HANDOVER-2026-10-13.md line 339, REPORTED).
- Every one of the 144 stage 1 findings was read in the current code at `045c0bd7`. So these batches are what is still open, not a repeat of finished work (OBSERVED in stage 1).
- Where an old batch covered the same ground but the problem is still in the code, this list carries it again: UXB-L3 tap floor vs CF-17 and CS-11 (links still miss 55 px); UXB-L7 parent vs AS-9; UXB-L11 words vs AS-13. Overwatch should check open PRs and chips in these areas before briefing (UNVERIFIED here).
- The research registry (1,193 claims) has no UI or navigation track (stage 1). No REDUNDANCY.

### 3.8 Every finding and its batch
Fix wording is from stage 1, section 3.10. Severity as in stage 1.

| ID | Sev | Batch | Fix in brief |
|---|---|---|---|
| CF-01 | MEDIUM | AS-6 | Offer the Gym TVs send on the live panel. |
| CF-02 | MEDIUM | AS-6 | Make the live tile link to the report. |
| CF-03 | MEDIUM | AS-7 | Put the tab row directly under the masthead. |
| CF-04 | MEDIUM | AS-1 | Label it for what it does, or start from there. |
| CF-05 | MEDIUM | AS-1 | Remove it from the board or say what it changes. |
| CF-06 | MEDIUM | AS-7 | Drop the block list; keep the link to Session Plans. |
| CF-07 | MEDIUM | AS-6 | Make each of today's classes open its register and a start button. |
| CF-08 | MEDIUM | AS-6 | Scroll to (or open beside) the opened plan; repeat the class choice by the start button. |
| CF-09 | MEDIUM | AS-6 | Name one register for coaches and link the others to it. |
| CF-10 | MEDIUM | AS-4 | Add both to the planning sub-nav. |
| CF-11 | MEDIUM | AS-11 | Name these limits on Session Plans and Schedule (FUTURE for any build). |
| CF-12 | MEDIUM | AS-7 | Show a "to verify" count on home that opens Cards. |
| CF-13 | MEDIUM | AS-6 | Let the coach pick a class or program first. |
| CF-14 | MEDIUM | AS-1 | Remove "stopped coming" from the door keywords until such a page exists. |
| CF-15 | MEDIUM | AS-11 | Cross-link the two and link Passbook to the athlete's plan, tests and cards. |
| CF-16 | MEDIUM | AS-4 | Add a "More for the floor" row on the home Dashboard. |
| CF-17 | MEDIUM | AS-4 | Give these links the tap class or extend the floor to links. |
| CF-18 | MEDIUM | AS-3 | Use the warning badge. |
| CF-19 | MEDIUM | AS-7 | Use --restricted unless the escalation is a medical stop. |
| CF-20 | LOW | AS-4 | Add BackHome to each. |
| CF-21 | LOW | AS-7 | Link each read-only card to the SHADOW Intel item. |
| CF-22 | LOW | AS-7 | One word per thing from the glossary; button text = page title. |
| CF-23 | LOW | AS-11 | Carry the drill or athlete in the link. |
| CF-24 | LOW | AS-3 | Mark floor-used pages kiosk. |
| CF-25 | LOW | AS-7 | Add a mark (glyph) on the open tab. |
| CF-26 | LOW | AS-6 | Title the block by what it lists. |
| CS-01 | HIGH | AS-1 | One line on each page naming the other, or the owner rules which page holds clearance. |
| CS-02 | MEDIUM | AS-5 | A clinic line (like ClusterNav) on Clearance Board, Injury Record, Medical Restrictions and Sparring Record. |
| CS-03 | MEDIUM | AS-5 | A "Tell the family" link on the Clearance Board row that opens the Decision Loop on that athlete. |
| CS-04 | MEDIUM | AS-1 | Rename the link, and add a few words per page to the shared line. |
| CS-05 | MEDIUM | AS-5 | A name filter at the top, and the footer links moved above the list. |
| CS-06 | MEDIUM | AS-5 | Say on each which one to use when, or drop the Log from the coach's Sparring line. |
| CS-07 | MEDIUM | AS-5 | One status line on Sparring Record after the athlete pick: minor, cap, restriction, with links. |
| CS-08 | MEDIUM | AS-5 | Row links to the athlete's Clearance Board row and Decision Loop; one link to Safety Flags from Escalations. |
| CS-09 | MEDIUM | AS-3 | Same swap as the Clearance Board: warning style with ▲ and a word. |
| CS-10 | MEDIUM | AS-3 | Owner rules whether a critical escalation is a medical stop; badge follows. |
| CS-11 | MEDIUM | AS-4 | Add the tap-floor class to links on kiosk pages; mark Sparring Caps kiosk. |
| CS-12 | MEDIUM | AS-13 | Say "share with athlete and family" at Release; say "no playback" on the library; drop or reword the planned panel. |
| CS-13 | LOW | AS-4 | Split the line into "Film" and "Teach Shadow". |
| CS-14 | LOW | AS-4 | Add BackHome. |
| CS-15 | LOW | AS-4 | One "More tools" row on the home, or accept as menu-only. |
| CS-16 | LOW | AS-13 | Link both names in the strip; use door names. |
| CS-17 | LOW | AS-1 | Turn the disabled button into a status line. |
| CS-18 | LOW | AS-13 | Use door labels in links; plain words for ids. |
| CS-19 | LOW | AS-11 | One line saying what to do first. |
| ATH-01 | MEDIUM | AS-8 | Start on the tab the Today button opens. |
| ATH-02 | MEDIUM | AS-8 | Put the group nav right under the header. |
| ATH-03 | MEDIUM | AS-8 | Show "End training" in My Corner while training. |
| ATH-04 | MEDIUM | AS-8 | Add the five links to the Development group. |
| ATH-05 | MEDIUM | AS-8 | Point the Corner button at "Ask SHADOW"; retitle the alert. |
| ATH-06 | MEDIUM | AS-8 | One meaning per word in the glossary. |
| ATH-07 | MEDIUM | AS-8 | Offer today's open classes on the card. |
| ATH-08 | MEDIUM | AS-8 | Use the ruled words everywhere. |
| ATH-09 | MEDIUM | AS-4 | Hide the door from athlete/parent menus. |
| ATH-10 | MEDIUM | AS-2 | Jason decision: kiosk idle sign-out. |
| ATH-11 | MEDIUM | AS-3 | Use the warning/plain alert for errors. |
| ATH-12 | MEDIUM | AS-8 | Remove --t-sm overrides on athlete routes. |
| ATH-13 | LOW | AS-3 | Use the tap token. |
| ATH-14 | LOW | AS-3 | Mark both pages as kiosk. |
| ATH-15 | LOW | AS-8 | One PIN form, one link name. |
| ATH-16 | LOW | AS-4 | Keep the open tab in the URL. |
| ATH-17 | LOW | AS-8 | Reword the eyebrow. |
| ATH-18 | LOW | AS-4 | Add BackHome; link the named pages. |
| ATH-19 | LOW | AS-8 | Hide or explain the empty section. |
| ATH-20 | LOW | AS-8 | One label each. |
| ATH-21 | LOW | AS-8 | Link "Log rounds" from the symptom check. |
| ATH-22 | LOW | AS-6 | Jason's call on which clocks show. |
| ATH-23 | LOW | AS-8 | Honour reduced motion in the scroll. |
| ATH-24 | LOW | AS-8 | Keep one. |
| ATH-25 | LOW | AS-8 | Scroll to the player; BackHome at top. |
| ATH-26 | LOW | AS-8 | Hide the route chip. |
| FAM-01 | HIGH | AS-1 | Count restrictions and missing waivers in the line and name the child. |
| FAM-02 | MEDIUM | AS-9 | Move the Safety & Consent card to the top of Overview. |
| FAM-03 | MEDIUM | AS-9 | Fewer tabs or one scrolling row; a distinct child picker. |
| FAM-04 | MEDIUM | AS-9 | Keep one entry and name the move of the others. |
| FAM-05 | MEDIUM | AS-9 | Drop the tab-switch actions or scroll to the tab top. |
| FAM-06 | MEDIUM | AS-4 | Keep the tab in the address. |
| FAM-07 | MEDIUM | AS-9 | Move "Your athlete's film" to the Progress tab. |
| FAM-08 | MEDIUM | AS-9 | Put the page links at the top of Progress. |
| FAM-09 | MEDIUM | AS-9 | Point the empty Messages state to Report a Barrier, Observations and the coach (a compose box would be FUTURE). |
| FAM-10 | MEDIUM | AS-9 | One "Which child" picker at the top, reading the remembered child. |
| FAM-11 | MEDIUM | AS-9 | One shared picker that defaults to the only or remembered child. |
| FAM-12 | MEDIUM | AS-9 | Name the child on every count. |
| FAM-13 | MEDIUM | AS-9 | Use `alert--warning` as safety/consent now do. |
| FAM-14 | MEDIUM | AS-9 | Give those rows `.t-body`. |
| FAM-15 | MEDIUM | AS-9 | Parent email-link block first; button "Email me a sign-in link". |
| FAM-16 | MEDIUM | AS-4 | Footer link to /store; "Back to the front page" on /store. |
| FAM-17 | MEDIUM | AS-9 | Anchor link to #interest-intake on cards and in the hero. |
| FAM-18 | LOW | AS-9 | Menu label = h1; one back label. |
| FAM-19 | LOW | AS-9 | One status vocabulary; "Change to photos only" when signed. |
| FAM-20 | LOW | AS-9 | Remove the repeats. |
| FAM-21 | LOW | AS-1 | Plain text line. |
| FAM-22 | LOW | AS-9 | Loading line; gym name in h1. |
| FAM-23 | LOW | AS-9 | Parent label "Check <name> in". |
| FAM-24 | LOW | AS-9 | Tasks first; plainer tab name. |
| FAM-25 | LOW | AS-9 | Alert line for failure. |
| FAM-26 | LOW | AS-9 | Say "Privacy: interest form" or link app privacy if one exists. |
| FAM-27 | LOW | AS-9 | Reuse the fuller sentence. |
| FAM-28 | LOW | AS-9 | Convert safety/consent to the family ground. |
| OFF-01 | HIGH | AS-1 | Name only who can reset (gym office), or the owner rules on coach reset. |
| OFF-02 | HIGH | AS-1 | Show the existing TV panel on an admin page and link it from the setup line. |
| OFF-03 | MEDIUM | AS-10 | One "needs review today" list on Gym Office: a count and a link per queue. |
| OFF-04 | MEDIUM | AS-4 | Add BackHome to these six. |
| OFF-05 | MEDIUM | AS-10 | Move the launcher row (grouped) to Gym Office. |
| OFF-06 | MEDIUM | AS-10 | Reuse the "Find an athlete" box and add a role filter on the roster. |
| OFF-07 | MEDIUM | AS-10 | Add "Next: add guardian / record waivers" links to the code panel. |
| OFF-08 | MEDIUM | AS-10 | Point the Setup line and the Reset door at one path; fix the sentence. |
| OFF-09 | MEDIUM | AS-10 | Link Setup from Gym Office; point the guardian step at the Gym Office guardian tab. |
| OFF-10 | MEDIUM | AS-3 | Move to --restricted, as Safety Review and Escalations already did (safety-review:197-199). |
| OFF-11 | MEDIUM | AS-10 | Add a link per section (holds to Clearance Board) and a "Safety Review" link on each queue. |
| OFF-12 | MEDIUM | AS-1 | Remove or relabel these items. |
| OFF-13 | MEDIUM | AS-10 | Move it to Athlete Records or Gym Office. |
| OFF-14 | MEDIUM | AS-4 | Sub-group admin doors; add doors for Athlete Records and Export. |
| OFF-15 | LOW | AS-10 | Label = page title (OD-2026-10-17-001). |
| OFF-16 | MEDIUM | AS-1 | Name the real control, or the owner rules on an athlete switch. |
| OFF-17 | LOW | AS-10 | Cross-link the two pages. |
| OFF-18 | LOW | AS-10 | Show names; drop the duplicates. |
| OFF-19 | LOW | AS-10 | Cross-link and say which one is the record. |
| OFF-20 | LOW | AS-10 | Move the secondary blocks below the main list. |
| OFF-21 | LOW | AS-10 | Add next-step links. |
| OFF-22 | LOW | AS-4 | Filter table rows by the target page's roles. |
| BOA-01 | HIGH | AS-1 | Link each clip from Teach SHADOW agreement/annotation, or show a clip picker when none is named. |
| BOA-02 | HIGH | AS-1 | Replace the placeholder cards with a link to Payment Accounts and its real status. |
| BOA-03 | MEDIUM | AS-12 | Put Workspace Links directly under the header. |
| BOA-04 | MEDIUM | AS-12 | Add the same Workspace Links row to the hub. |
| BOA-05 | MEDIUM | AS-4 | Show only the seats the session may open. |
| BOA-06 | MEDIUM | AS-12 | Word the refusal by the viewer's access ("Not your seat"), not by occupancy. |
| BOA-07 | MEDIUM | AS-12 | Add "Board Seats" to the President's (and hub's) links. |
| BOA-08 | MEDIUM | AS-4 | One "Lab" room for these, out of the default corridor. |
| BOA-09 | MEDIUM | AS-4 | Hide each link with the target's role check (as chat:42-44 already does for SHADOW Admin). |
| BOA-10 | MEDIUM | AS-4 | Add BackHome to each header. |
| BOA-11 | MEDIUM | AS-12 | Link label = page title (ruling 1). |
| BOA-12 | MEDIUM | AS-12 | Add a short in-page index at the top and a Quotes link. |
| BOA-13 | MEDIUM | AS-12 | Move those steps to Omega or System. |
| BOA-14 | MEDIUM | AS-4 | Add a door for Equipment; group money/records links on Gym Office. |
| BOA-15 | MEDIUM | AS-3 | Use the restricted/brass rung (the calibration pages already do, review:256-261). |
| BOA-16 | LOW | AS-12 | Say grants are kept by the gym admin; drop the "Treasurer" eyebrow. |
| BOA-17 | LOW | AS-12 | Add an empty line. |
| BOA-18 | LOW | AS-12 | Split the hint or the title per role. |
| BOA-19 | LOW | AS-12 | Use one wording. |
| BOA-20 | LOW | AS-12 | Put the programs block first when empty. |
| BOA-21 | LOW | AS-4 | Use BackHome at top. |
| BOA-22 | LOW | AS-12 | Move out of Gym Floor (see BOA-08). |
| BOA-23 | LOW | AS-12 | Redirect to /admin/escalations. |

## 4. What it could change in the app (proposals, not specs)
- After AS-1 to AS-3: no structural change. Screens stop making false promises, the shared tablet signs itself out, and the red medical-stop mark means only a medical stop outside the homes.
- After AS-4: every role has a 3 to 5 section job bar and Search. 'Jump' and the Rooms list are folded into Search, which is a named move (stage 2, 3.4). Both header menus go, as card S2-2 changed it.
- After AS-5 to AS-7: a coach handles a head knock on one athlete page, runs a class on one screen, and sees what needs them on a home that fits one tablet screen.
- After AS-8 to AS-10: athletes open on check-in, parents see safety first, and the admin's morning check is one list.
- After AS-11 to AS-13: athlete records join up, board and platform pages tidy, and the words line up.
- Every move and removal is already named in stage 2, 3.4 (53 moves). Pack 02 requires that a moved or removed action is named; each batch's PR should carry its rows from that list (proposal).

## 5. Gaps
- Sizes are estimates from file lengths and finding counts, not from a design of each change. Real PR counts can differ. No time per batch is given, because there is no basis for one.
- Not tested on devices or with users. The order assumes the stage 2 structure holds up in the walk-through (Recommendation A puts the walk before AS-4).
- Whether the October chips (UX-A batches and UXB-L1 to UXB-L12) are closed was not checked. Only the code was.
- The mirror is `045c0bd7` (2026-11-18 06:21 −05:00). GitHub main was 2 commits ahead when checked earlier today, dependency files only, so it does not change any finding (OBSERVED then).
- AS-2 may need a stored setting for the idle time (Q5 option A). Whether an existing settings store can hold it was not checked. If it needs a schema change, that is Overwatch's call (flagged, not designed here).
- Updated 2026-11-19, after lane SH and the OW25-45 to OW25-48 answers. The batch contents are unchanged. The 3.2 and 3.8 counts still list SH's items under AS-1, AS-3 and AS-7, but lane SH does them.
- Review routes are read from the owner decisions. Choosing models and effort is Overwatch's job.
- DRIFT check: this file names batches, screens, likely files and user outcomes. It stops before components, data, schema or code; Overwatch writes the lane briefs.

## 6. Sources
- Stage 1: `2026-11-19-app-scrub-stage-1.md` (sha256[:16] 1bac7c253891d063; one count corrected today, earlier copy 95fb1028d144b170), sections 3.3 (traces), 3.9 (165 routes) and 3.10 (144 findings).
- Stage 2: `2026-11-19-app-scrub-stage-2.md` (sha256[:16] 89a6e4099cae479a; section 3.11 added 2026-11-19 after OW25-51; earlier copy a4725a60b6bbb013), section 3.4 (53 named moves) and the five sketches `2026-11-19-app-scrub-stage-2-fig1` to `fig5`.
- Your card answers S2-1 to S2-5 (this session, 2026-11-19); CARDS_OW25.md OW25-43, OW25-44.
- Repo `docs/current/OWNER_DECISIONS.md` at `045c0bd7`: OD-2026-11-16-005 (line 34; section at 1023); OD-2026-09-30-003 G3 (12436-12440) and G5 (12445-12449); OD-2026-09-30-007 U1 (11853-11854) and its G3 note (11868); OD-2026-10-17-001 (4495-4516); OD-2026-09-19-001 (14120-14164).
- `C:\Users\jason\Documents\PPBF-overwatch\audit\UX-COHERENCE-B-SCREENS-2026-10-16.md` section 5 (lines 289-308, earlier batch format); `OVERWATCH-HANDOVER-2026-10-13.md` line 339.
- Pack 02 binding rules (knowledge pack, file 02).
- `OneDrive …\PPBF-AI-Lanes\Research\Backbone\working\overwatch\CARDS_OW25.md` (sha256[:16] 346e3a46b7813cee): OW25-45 to OW25-48 and your answers.
- `C:\Users\jason\Documents\PPBF-overwatch\backbone-crossover\STATUS.md` lines 518-526; `lane-briefs\LANE_SH_SCRUB_HIGH_BRIEF.md` (2026-11-19).
- GitHub main `a0f70fb2` `docs/current/OWNER_DECISIONS.md` line 691: OD-2026-11-19-001.
- `findings\2026-11-17-coach-screens-design-check.md` (content lane menu entry in buildingMap.ts).
- Claude Code docs: https://code.claude.com/docs/en/worktrees and https://code.claude.com/docs/en/agents (worktrees isolate edits per session).
- Third-party guide, merge-time conflicts: https://www.agent37.com/blog/git-worktree-claude-code
- Mirror line counts: files named in 3.3, `C:\Dev\research-mirror\ppbf-platform\apps\web` at `045c0bd7`.
