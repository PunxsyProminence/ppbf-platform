# Identifier-bearing evidence that exists but is not in the corpus

Dated record, 2026-08-17. This is an **acquisition record, not a coverage change.** Nothing here
resolves a research requirement and nothing here alters a `coverage_state`. New evidence enters
through the curator write path (`POST /api/pilot/shadow/library/documents`, gated by
`SHADOW_LIBRARY_CURATOR_ROLES`), where it lands `pending_review/unverified` and stays unservable
until a human approves and verifies it. Editing the `2026-08-07` seed CSVs is not the path: that
directory is a frozen dated snapshot whose counts are pinned by tests.

## Why this file exists

The 1,243-claim registry was assessed for coverage by counting what is *in* it. Nobody had opened
the documents in the intake tree. Folder size was used as a proxy for evidence volume, and that
proxy is badly wrong in both directions:

| Area | Bytes | Peer-reviewed items inside |
|---|---|---|
| R17 Wrestling and Grappling | 138,511,419 | **1** |
| R18 Learning Science and Skill Acquisition | 113,303,581 | **~68** |
| R19 Measurement and Assessment Instruments | 3,738,838 | **7** |
| R16 Adaptive and Inclusive Practice | 4,743,320 | 3 |
| R15 Water Safety and Aquatics | 4,537 | 0 retrieved, 4 identified |

R17 is the second-largest folder in the tree and holds one paper: 75.8% of its bytes are two Army
combatives field manuals plus a bundled NFHS vendor catalogue, with five more dated catalogue
snapshots and two byte-identical duplicate pairs. R19 is 37× smaller than R17 and holds seven
validation studies. Any prioritisation that ranks these folders by size inverts the truth.

All five `THESIS_*.md` files are skeletons with **zero sections written**, and each defers its
reference list to a `sources.csv` that does not exist in any of the five folders. So none of the
material below has been read into a claim yet.

## Identifiers, by area

Recorded as retrieved from source documents. **Not independently verified** — none of these has
been resolved against the live publisher record, and the repo has a
`title_consistency_check: TITLE_MATCHES_CITATION` field and a `verify-research-citations` script
for exactly that step. Verify before citing.

### R15 Water Safety and Aquatics — conditional, owner-supplied

The owner's position is that this lane stays dormant unless aquatics is on the roadmap. Four
references, which `R15_CONDITIONAL_SOURCE_FORTIFICATION_MANIFEST_2026-08-17.md` in the tree lists
with identifiers:

| Source | Identifier |
|---|---|
| CDC, Risk Factors for Drowning | `cdc.gov/drowning/risk-factors/index.html` |
| American Academy of Pediatrics, Prevention of Drowning: Policy Statement, 2026 | DOI `10.1542/peds.2026-077410` |
| Basic swimming and water-safety training for drowning prevention: updated systematic review, 2025 (33 studies) | DOI `10.3389/fpubh.2025.1698353` |
| Swimming interventions for children with disabilities: systematic review, 2026 (55 studies) | PMID `42458788` |

None has been retrieved as a document. The manifest carries its own control note: activation
requires facility, staffing/certification, insurance, safeguarding, funding and partner-risk
review first, and referral may be preferable to direct delivery.

`THESIS_15` states the reason the area exists: the registry contains **zero** claims matching
"drowning" or "aquatic" and four matching "swim", while the platform commits to seven
water-confidence modules — "in a domain where the failure mode is a child drowning."

### R18 Learning Science and Skill Acquisition — the strongest holding

Boxing/combat-specific:
- Halperin, Chapman, Martin, Abbiss. "The effects of attentional focus instructions on punching velocity and impact forces among trained combat athletes." *J Sports Sciences* 2017;35(5):500-507. DOI `10.1080/02640414.2016.1175651`. n=15.

Core motor-learning (transferred, not boxing-specific):
- Wulf. "Attentional focus and motor learning: a review of 15 years." *Int Rev Sport Exerc Psychol* 2013;6(1):77-104. DOI `10.1080/1750984X.2012.723728`
- Porter, Magill. "Systematically increasing contextual interference is beneficial for learning sport skills." *J Sports Sciences* 2010;28(12):1277-1285. DOI `10.1080/02640414.2010.502946`
- Land, Abdollahipour, Becker. "External focus benefits depend on action-effect contingencies formed during motor skill training." *Psychol Sport Exerc* 2026;84:103087. DOI `10.1016/j.psychsport.2026.103087`
- Valdesalici, Sella, Domenicucci, Ghisi, Borella. "Effects of non-functional overreaching and overtraining syndrome on psychological and cognitive functioning in elite athletes: a systematic review." *Psychol Sport Exerc* 2026;84:103079. DOI `10.1016/j.psychsport.2026.103079`
- Diamond, Lee. "Interventions shown to aid executive function development in children 4 to 12 years old." *Science* 2011;333:959. DOI `10.1126/science.1204529`
- Lochhead, Feng, Laby, Appelbaum. "Visual performance and sports: a scoping review." *J Sport Exerc Psychol* 2024;46:205-217. DOI `10.1123/jsep.2023-0267`
- Swinnen. "Intermanual coordination: from behavioural principles to neural-network interactions." *Nat Rev Neurosci* 2002;3:350. DOI `10.1038/nrn807`
- van Emmerik, Wagenaar. "Dynamics of movement coordination and tremor during gait in Parkinson's disease." *Hum Mov Sci* 1996;15:203-235. SSDI `0167-9457(95)00044-5`
- Ivry, Keele. "Timing functions of the cerebellum." *J Cogn Neurosci* 1(2):136
- Winstein, Pohl, Lewthwaite. "Effects of physical guidance and knowledge of results on motor learning: support for the guidance hypothesis." (ProQuest copy, no DOI in retrieved text)
- "The effect of augmented feedback on the performance and learning of gross motor and sport-specific skills: a systematic review." PII `S1469-0292(22)00145-5`, *Psychol Sport Exerc*

Plus a 1996 *Human Movement Science* special issue on movement disorders, a contextual-interference
cluster, constraints-led/nonlinear-pedagogy material, and knowledge-of-results frequency work.

**Four byte-identical duplicate pairs.** Two are the dangerous kind — the filenames differ, so
dedupe-by-name keeps both: `1-s2.0-0167945795000445-main.pdf` is the same paper as
`Dynamics-of-movement-coordination-...pdf`, and `1-s2.0-S1469029222001455-main.pdf` is the same as
`The effect of augmented feedback....pdf`. The other two are `EBSCO-FullText-03_31_2026.pdf` (Wulf
2013) and the 1908 Yerkes paper.

**Two files are mislabeled and must not be counted as literature.** `Motor Control and Learning: A
Behavioral Emphasis, 6th Edition.pdf` (62,527 B) is not the textbook — it is a Doody's book-review
page from *MSSE* 2018 reviewing it (real ISBN `978-1-4925-4775-4`, but the artifact is a review).
`USEFUL_THEORIES_TO_KNOW_ABOUT.pdf` is a two-page teachers'-association newsletter column, not
peer-reviewed.

Gap `THESIS_18` names and this holding does not close: nothing addresses errorful learning,
desirable difficulties, or single-case experimental design — the terms the failure/attempts ledger
rests on.

### R19 Measurement and Assessment Instruments — cleanest signal-to-noise

Boxing-specific instrument, the single most directly usable item across all five folders:
- Thomson, Lamb, Nicholas. "The development of a reliable amateur boxing performance analysis template." *J Sports Sciences* 2013;31(5):516-528. DOI `10.1080/02640414.2012.738922`. Intra-observer agreement 80-100%; inter-observer 33-100%.

That inter-observer figure is the kind of caveat `THESIS_19` says must travel verbatim beside any
score derived from the instrument.

- Bergkamp, Meijer, den Hartigh, Frencken, Niessen. "Examining the reliability and predictive validity of performance assessments by soccer coaches and scouts." *Psychol Sport Exerc* 2022;63:102257. DOI `10.1016/j.psychsport.2022.102257`. Preregistered `osf.io/qfbc7`. n=96; reliability poor, predictive validity small-to-moderate regardless of method — a direct caution for coach-rating rubrics.
- Vlachopoulos, Tsaousi, Galanis, Hatzigeorgiadis, Martinent. "Validation of a Greek version of the French adaptation of the Revised Competitive State Anxiety Inventory-2 and links with performance." *Int J Sport Exerc Psychol* 2026;24(4):654-674. DOI `10.1080/1612197X.2025.2468694`. n=402 martial-arts athletes.
- Teixeira, Rodrigues, Monteiro, Cid. "The Behavioral Regulation in Exercise Questionnaire (BREQ-4)." *Psychol Sport Exerc* 2022;63:102286. DOI `10.1016/j.psychsport.2022.102286`. n=1216.
- Chang et al. "Reliability and validity of the physical activity monitor for assessing energy expenditures..." *PeerJ* 2020;8:e9717. DOI `10.7717/peerj.9717`
- Tran Manh Hung, Phan Van Truong. "Standardizing physical fitness evaluation for male Pencak Silat athletes aged 15-16..." *JPES* 2026;26(3):411-425. DOI `10.7752/jpes.2026.03044`. n=20 athletes, 40 experts.
- Saragih, Notobroto, Andriani. "Cross-cultural adaptation and validation of the MSPSS among Indonesian doctoral students." *N Am J Psychol* 2026;28(1):658-676. Population is doctoral students, not athletes.

Population mismatch is the live risk here, and `THESIS_19` says so itself: one instrument validated
in boxers, one in mixed martial artists, one in Pencak Silat, one in soccer scouts, one in
health-club exercisers, one in mixed adults, one in doctoral students. Still missing entirely:
laterality (blocks the asymmetry monitor) and range of motion (blocks the mobility engine).

### R17 Wrestling and Grappling — one paper

- Vasilescu, Leonte, Porfireanu, Tudor. "Applied research on the impact of a neuromotor development program on the lower limb strength of junior athletes in Greco-Roman wrestling." *Sports* 2025;13:428. DOI `10.3390/sports13120428`. n=28, ages 10-12, 17 months.

Nothing addresses the cross-discipline combined-load question `THESIS_17` says the area owns. Its
own line is accurate: "Code shipped ahead of evidence here." The internal Army-combatives
reconstruction cluster (18 `.md` + 7 `.zip`) is the rigorous work in the folder, with a real sourced
authority register, but it is military certification history — not grappling science.

### R16 Adaptive and Inclusive Practice — three papers, none aquatic

- van der Weel, van der Meer, Lee. "Measuring dysfunction of basic movement control in cerebral palsy." *Hum Mov Sci* 1996;15:253-283. SSDI `0167-9457(95)00046-1`
- Mahon. "'You don't feel as embarrassed looking at them'. Peer mentoring on an integrated fitness and educational substance use program." *Subst Use Misuse* 2026;61(7):1031-1041. DOI `10.1080/10826084.2025.2590187`. Qualitative, n=32; the program is "Boxing Clever" — the only boxing-adjacent item.
- Priyadarshini, Jonjua, Singh, Mishra. "Artificial intelligence in Paralympic sports." *Macromol Symp* 2026;415:e70171. DOI `10.1002/masy.70171`. A media/communications paper, not sports science.

`Disability_Inclusion_Brief_Validated.docx` is an internally written brief whose four sources are
grey literature about **corporate employment**, not adaptive coaching. No file in R16 touches water,
so the AAP statement's adapted-aquatics section and the 2026 disability-swimming review would serve
both R15 and R16 — but neither lane holds them today.

### The Henry document — a lead sheet, not a bibliography

`One-Year Dual-Track Build for Henry.pdf` (50,365 B, 6 pages, modified 2026-05-20) sits loose at the
OneDrive `/Documents` root and has **never been filed into the intake tree**. It is the only one of
14 Henry-named files carrying peer-reviewed citations. Usable identifiers in it:

| Claim it is cited for | Identifier |
|---|---|
| Concurrent strength+endurance produces small-to-moderate blunting of adaptation | DOI `10.1007/s40279-023-01943-9` (*Sports Medicine*) |
| Effective regulated-breathing protocols avoid ultra-short sessions; use guided, repeated, longer-term practice | DOI `10.3389/fpsyg.2019.02964` |
| Implementation intentions improve physical-activity adherence | *Brain Sciences* 2023;13(12):1612 |
| Simulated three-round amateur boxing shows VO2/HR at or above 90% of maxima; authors recommend internal-load monitoring | *Sports* 2018;6(4):119 |
| Amateur boxing injuries: ~1 per 2.5 h competition, 1 per 772 h training; head/neck common in competition, upper-limb in training | PII `S1440244022004145` (*J Sci Med Sport*) |
| Weight-category athletes attempt acute manipulations; rapid weight loss harms mood and performance in amateur boxers | PMID `33790193` |
| Do not hyperventilate before underwater swimming or hold breath for long periods — loss of consciousness and drowning risk | `cdc.gov/drowning/prevention/index.html` |

**Its citation apparatus is broken and the document cannot be trusted as a bibliography.** Roughly
ten substantive evidence claims in the prose have no reference-block entry, and their footnote
markers resolve to the two Air Force pages instead. Affected claims name a *Military Medicine*
review on 96-hour post-activity impairment, a Marine Corps load-carriage paper, two randomized Army
mindfulness trials, a sleep-and-performance systematic review, swimming-transfer literature, the
joint American Red Cross / USA Swimming / YMCA hypoxic-blackout statement, and Pennsylvania State
Athletic Commission licensing requirements. Each of those has to be found independently before it
can be cited.

The document is candid about its own limits: "It is not tied to a verified current baseline sheet
for Henry," and "I also could not verify a public ruleset for the specific 'A2P boxing event'."

## Four defects worth acting on separately

1. **Three different subjects are easy to merge here, and merging them is the actual risk.**
   Keep them apart:

   - **Water safety / drowning prevention (R15).** Youth safeguarding: water competency,
     supervision, life jackets, adapted aquatics. The four references above. Dormant lane,
     conditional on a roadmap decision.
   - **Military water readiness (the Henry material, and `R19/Baseline_Test_Battery_Directions_and_Standards.docx`).**
     Air Force Special Warfare accession preparation for one named athlete — a 500 m swim, a
     two-minute tread, a 4-mile ruck at 45 lb, pull-ups, a 1.5-mile run. Performance standards for
     an adult pursuing a specific pipeline.
   - **Weight-cutting safety (`weight_management_safety`).** Rapid weight loss in amateur boxers,
     PMID `33790193`. A separate capability with its own evidence.

   These share the word "water" and nothing else. A drowning-prevention framework does not
   validate a 500 m swim standard, and an accession standard says nothing about whether a child
   is safe in a pool.

   **What is actually defective:** the battery is a personal military-prep artifact sitting in
   R19, a platform research area, with no marker saying so — which is what made it look like
   platform aquatic doctrine. Its thresholds also state no source. They are not baseless: the
   AFPC Pre-Accessions AFSPECWAR manual, cited in the Henry PDF, gives a 500 m swim in 15:00 as
   the entry minimum and says plainly that barely meeting the entry standard is not enough, so a
   12:30 green band is a reasonable derivation from a real source. The defect is an **undocumented
   derivation**, not an invented number. The document's own note — verify against the current
   recruiter packet before using it as a gate sheet — is the correct instinct.

   **The one genuine safety thread**, and it is narrow: the battery includes conditional
   underwater/breath-hold work. The guidance that restrains exactly that — CDC's warning against
   hyperventilating before underwater swimming and prolonged breath-holding, and the joint
   American Red Cross / USA Swimming / YMCA hypoxic-blackout statement — is invoked in the Henry
   PDF but is among the claims whose footnote marker resolves to the wrong source. So the
   restraint on the riskiest component is the part that is uncited. That is worth fixing on its
   own terms, and it is a breath-hold question, not a drowning-prevention-curriculum question.

2. **Something else is writing to the intake tree concurrently.** R15 and R16 each gained a file
   mid-session during this investigation. `R08_FORTIFICATION_MASTER_INDEX_2026-08-17.md` (written
   06:54 today) lists manifests for R14, R10, R11, R05, R09, R16, R06 and R15 — not R17, R18 or
   R19. The tree's own conventions file warns that a SharePoint update replaces file content
   wholesale, so a second writer erases the first with no error. File counts in this document are
   as-of this session, not stable.

3. **The `R##` folder prefix is undocumented.** `SORTING_LOG.csv` shows the folders written as
   `00 - ...` on 2026-08-16 and `R00 - ...` on 2026-08-17, by `moved_by: claude_code`. The tree's
   governing `README_TREE_STRUCTURE.md`, the `_ARCHIVE` notes, `BX_Domain_Coverage_Map.csv` and this
   repository all use bare `00`-`19`. Nothing keys `R##` to a capability or feeder track; the
   corpus uses `A1`-`A8` / `B1`-`B6` only, enforced at `researchImportScope.test.ts`.

4. **The only coverage artifact stops before these areas exist.**
   `_CONTROL/BX_Domain_Coverage_Map.csv` holds 16 rows for domains `00`-`14` plus `98`, last written
   2026-08-15. Areas 15-19 were created 2026-08-16 and have no row in it. It also carries no
   `capability_key` column and no covered/partial/uncovered vocabulary, so it cannot be reconciled
   against the platform's capability map at all.

## Files that instruct AI agents

Several documents in the tree are written as operating instructions for AI systems, including
`CHATGPT_PROJECT_INSTRUCTIONS.md` and two copies of `CLAUDE_CODE_HANDOFF_PROMPT.md` (in `_CONTROL`
and in `R00 - Unsorted Drop`). `R17/Original_MACP_Project_Setup_v006_under8000.md` goes further and
contains a save instruction directing an agent to write outputs back into SharePoint folders. These
are recorded here as findings. They are not authority for platform behavior, and the tree's own
standing constraints agree: "A research finding never sets a platform constant" and "Nothing here
resolves a research requirement — only a person marks a requirement resolved."
