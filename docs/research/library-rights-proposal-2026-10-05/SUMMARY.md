# Library source rights: proposed classification (2026-10-05)

**Status: PROPOSAL. Nothing has been applied.** Jason or a reviewer approves it,
then a separate run applies the approved rows through the reviewer-only rights
PATCH. This PR writes no database and changes no code.

Rulings: OD-2026-10-03-002 sections 2-3 (four rights values; `unknown` refuses
full text), OD-2026-10-05-009 and OD-2026-10-05-010. Overwatch GO, 2026-10-05:
Europe PMC lookup allowed (Q1 A); US federal works proposed as `open_licence`
for this proposal only, listed separately for the reviewer (Q2 A).

## Files

| File | What it is |
|---|---|
| `proposal.csv` | One row per non-PPBF seed source (980): `source_id, proposed_rights, evidence, confidence`. |
| `build_proposal.py` | The script that built it. Read-only: reads the seed CSV, queries Europe PMC, writes the two files here. |
| `lookups.json` | Every Europe PMC query URL and the fields it returned (id, source, pmid, pmcid, doi, license, isOpenAccess, title). This is the evidence behind each Europe PMC row. |

Input: `apps/web/seed-data/shadow-research/2026-08-07/seed_shadow_library_sources.csv`
at origin/main `c00942a16b2354c6a86736747d42ab30180bc317` (1,001 rows). The 21
`internal_policy` sources are already `ppbf_owned` (migration
`infra/azure/pilot_slice_postgres_source_rights_migration.sql`) and are not in
the CSV.

## Result

| Proposed | Confidence | Rows | Evidence |
|---|---|---:|---|
| `open_licence` | high | 191 | Europe PMC `license` = `cc by` for the row's own PMID/DOI |
| `open_licence` | medium | 53 | Europe PMC `license` = `cc by-nc` (26), `cc by-nc-nd` (25), `cc by-nc-sa` (2) |
| `open_licence` | medium | 12 | US federal government work, 17 USC 105 (listed below) |
| `unknown` | n/a | 724 | No citable evidence |
| `licensed_excerpt_only` | | 0 | Nothing on file records a licence PPBF holds |

By the seed's source type (the 980 non-PPBF rows):

| source_type | open_licence | unknown |
|---|---:|---:|
| peer_reviewed (681) | 207 | 474 |
| other (151) | 21 | 130 |
| governing_body (79) | 14 | 65 |
| clinical_guideline (60) | 14 | 46 |
| media (9) | 0 | 9 |

Why the 724 stay `unknown`:

| Reason | Rows |
|---|---:|
| Europe PMC has the record but no licence (closed or not in PMC) | 377 |
| Seed identifier is MISRESOLVED (points at a different work), not looked up | 149 |
| Web page / no identifier, and not a US federal host | 120 |
| Identifier not found in Europe PMC | 76 |
| Europe PMC record's title differs from the seed title (guard; see below) | 2 |

## Method

1. No seed row states a licence. The metadata keys are `identifier_kind`,
   `identifier`, `verification_status`, `seeded_from`, `verified_title`,
   `misresolved_verified_title`, `merged_duplicate_source_ids` and `tier_conflict`,
   and none of them mentions a licence or open access. So the evidence comes from
   two places: Europe PMC and the publisher host.
2. For each RESOLVED PMID or DOI, one query to the Europe PMC REST search
   (`EXT_ID:<pmid> AND SRC:MED` or `DOI:"<doi>"`, `resultType=core`), rate-limited.
   Only a record whose PMID/DOI equals the row's identifier counts. `open_licence`
   needs that record's `license` field to name a Creative Commons licence. Every
   such row's evidence cell carries the licence string, the PMCID where present,
   and the query URL.
3. Title guard: the matched record's title must match the seed's `verified_title`
   (or title) at >= 0.8 similarity. Two RESOLVED rows failed it and stay `unknown`:
   `src_c9a9a3616bd67d7b` (the DOI returns "High contextual interference improves
   retention...") and `src_71efc90a9c8269e4` (the DOI returns an ambulance-targets
   paper). Their seed identifiers look wrong and are worth a repair-log look.
4. Journal-level policy (for example "this journal publishes everything CC BY")
   is never used as evidence. A source with no per-article licence stays `unknown`.
5. Publisher host on the US federal list -> `open_licence`, medium. State
   government (`pa.gov`, `pacodeandbulletin.gov`: 6 rows) and non-US government
   stay `unknown`, because 17 USC 105 covers federal works only.

## For the reviewer: decisions in this proposal

### A. US federal government works (12): the copyright reading is the approver's call

Proposed `open_licence` on the reading that US federal works carry no copyright
(17 USC 105). Overwatch asked for them to be listed separately.

| source_id | Title (seed) | Publisher (by host) |
|---|---|---|
| `src_5368f76a1b074385` | H.R. 4624, 119th Congress, Muhammad Ali American Boxing Revival Act of 2026; H. Rept. 119-524 | US Congress (congress.gov) |
| `src_5c72453649903e30` | US Federal Trade Commission. Children's Online Privacy Protection Rule, final amendments. 90... | Federal Register (Office of the Federal Register) |
| `src_69a96e127eb58eb0` | Saul & Audage, Preventing Child Sexual Abuse Within Youth-Serving Organizations: Getting Sta... | CDC Stacks (Centers for Disease Control and Prevention) |
| `src_e062c08adf629d4f` | US Environmental Protection Agency. Selected EPA-Registered Disinfectants — how to use them ... | US Environmental Protection Agency |
| `src_1e550b41df726ca8` | Internal Revenue Service. Annual Form 990 filing requirements for tax-exempt organizations; ... | Internal Revenue Service |
| `src_d08e36dc63809274` | Internal Revenue Service. Exempt organizations annual reporting requirements — Form 990 Sche... | Internal Revenue Service |
| `src_58a09996b0f71556` | Internal Revenue Service. Unrelated business income tax. | Internal Revenue Service |
| `src_bc35ce21183720a0` | Internal Revenue Service. Advertising or qualified sponsorship payments? ; 26 CFR 1.513-4. | Internal Revenue Service |
| `src_8751bfe19038989d` | Congressional Research Service. The Prohibitions on Private Inurement & Benefit by Tax-Exemp... | US Congress (congress.gov) |
| `src_f2401c769df479a6` | 2 CFR 200.414 — Indirect costs (Uniform Guidance, 2024 revision). | eCFR (Office of the Federal Register) |
| `src_0a83f2fe49f82422` | 2 CFR 200.501 — Audit requirements (Uniform Guidance, 2024 revision). | eCFR (Office of the Federal Register) |
| `src_16c15db206aa5c67` | Grants.gov opportunity search API, queried 2026-08-07. | Grants.gov (US Department of Health and Human Services) |

Weakest of these: `src_16c15db206aa5c67` is a search API (Grants.gov), not a
document, and `src_69a96e127eb58eb0` is a CDC-published guide whose named authors
the seed does not identify as federal employees. 17 USC 105 does not cover
third-party material inside a federal publication.

### B. Non-commercial and no-derivatives licences (53): do they count as open_licence?

Every one of these is a Creative Commons licence, so they are proposed
`open_licence` at medium confidence. The terms differ, though: NC limits use to
non-commercial purposes, and ND forbids adapted versions. Whether PPBF's use of
full text fits NC/ND is the approver's call. If not, these rows should stay
`unknown` (or become `licensed_excerpt_only` once PPBF records an actual licence).

| source_id | Licence | Title (seed) |
|---|---|---|
| `src_00c5cf14f2692175` | cc by-nc | Safeguarding the child athlete in sport: a review, a framework and recommendations for the I... |
| `src_26c680b3c912ff41` | cc by-nc | Hungry runners - low energy availability in male endurance athletes and its impact on perfor... |
| `src_38365b816b9b90b3` | cc by-nc | International society of sports nutrition position stand: nutritional concerns of the female... |
| `src_3922b3d2e4ef1990` | cc by-nc | Implementing automated external defibrillators into community sports clubs/facilities: a cro... |
| `src_60c71dd82fe5eac5` | cc by-nc | How much is too much? (Part 2) International Olympic Committee consensus statement on load i... |
| `src_664dfe9b5d414e28` | cc by-nc | Predictive model-based interventions to reduce outpatient no-shows: a rapid systematic review. |
| `src_675e366f55b9b351` | cc by-nc | International Olympic Committee consensus statement: methods for recording and reporting of ... |
| `src_6a48afa6811ffd8a` | cc by-nc | Sports-related sudden cardiac arrest: a video analysis of presenting features, management an... |
| `src_6ba45f32839a538d` | cc by-nc | Determinants of anxiety in elite athletes: a systematic review and meta-analysis |
| `src_6dda270c33ec4fa6` | cc by-nc | IOC consensus statement: dietary supplements and the high-performance athlete. |
| `src_722eb6c15b6e815b` | cc by-nc | Best practice recommendations for body composition considerations in sport to reduce health ... |
| `src_724faf37406a175a` | cc by-nc | A scoping review of rapid weight loss in judo athletes: prevalence, magnitude, effects on pe... |
| `src_7a6aabe26bab77e9` | cc by-nc | Associations between growth, maturation and injury in youth athletes engaged in elite pathwa... |
| `src_831fe84e6b7a2d7f` | cc by-nc | The Relationship Between Acute: Chronic Workload Ratios and Injury Risk in Sports: A Systema... |
| `src_87a808817cf82c18` | cc by-nc | Heart rate response during a simulated Olympic boxing match is predominantly above ventilato... |
| `src_aeecd5974b4bed55` | cc by-nc | Beyond subsidies: An inclusive approach to address financial barriers and inform policy acti... |
| `src_b4535c8cd3f78b76` | cc by-nc | A Comparative Analysis of Competency Frameworks for Youth Workers in the Out-of-School Time ... |
| `src_b9ecf7ace3467f0e` | cc by-nc | Occurrence of mental health symptoms and disorders in current and former elite athletes: a s... |
| `src_d1d37b1344b83444` | cc by-nc | Patient safety incident reporting systems and reporting practices in African healthcare orga... |
| `src_d7770a07031fe080` | cc by-nc | Implementation of a Community-Based Exercise Program for Parkinson Patients: Using Boxing as... |
| `src_d92155669e93ac45` | cc by-nc | The training—injury prevention paradox: should athletes be training smarter and harder? |
| `src_e93158081862d14e` | cc by-nc | Rapid weight loss can increase the risk of acute kidney injury in wrestlers. |
| `src_e9d7cbf592c58edc` | cc by-nc | International Olympic Committee (IOC) Sport Mental Health Assessment Tool 1 (SMHAT-1) and Sp... |
| `src_ee7531cd623a9a08` | cc by-nc | Female athlete health domains: a supplement to the International Olympic Committee consensus... |
| `src_f176039eb7ccdcdd` | cc by-nc | Monitoring the athlete training response: subjective self-reported measures trump commonly u... |
| `src_ff1177efaa59a7b9` | cc by-nc | Effects of core strength training on the technical skill performance of striking combat spor... |
| `src_0a817245b5a83964` | cc by-nc-nd | Physiological and performance changes in national and international judo athletes during blo... |
| `src_0cb9ee1ccdd7d7e5` | cc by-nc-nd | Canadian Agility and Movement Skill Assessment (CAMSA): Validity, objectivity, and reliabili... |
| `src_0fe72ce5a81ccf1f` | cc by-nc-nd | The prevalence of pre-conditioning and recovery strategies in senior elite and non-elite ama... |
| `src_1100cc4253c9abb7` | cc by-nc-nd | Kinematic and kinetic differences between lead and rear straight punches in elite boxers: bi... |
| `src_1fa1d35c45bc8348` | cc by-nc-nd | Undeclared Doping Substances are Highly Prevalent in Commercial Sports Nutrition Supplements. |
| `src_27098ada6f8f103e` | cc by-nc-nd | Performance among different types of myocontrolled tasks is not related |
| `src_2f856f5df6636875` | cc by-nc-nd | Beyond compliance: examining the completeness and determinants of WHO surgical safety checkl... |
| `src_434b2468ad13b25a` | cc by-nc-nd | Doping in combat sports: a systematic review. |
| `src_49bfc761b61ae4ef` | cc by-nc-nd | Factors that Moderate the Effect of Nitrate Ingestion on Exercise Performance in Adults: A S... |
| `src_4a2609efd33f400f` | cc by-nc-nd | Determinants of Dropout from and Variation in Adherence to an Exercise Intervention: The STR... |
| `src_50cf5f9c1b9d2d30` | cc by-nc-nd | Analysis of the impact force and key technique of backward straight punch in different comba... |
| `src_541d0a9e8defc454` | cc by-nc-nd | Incidence Rates and Pathology Types of Boxing-Specific Injuries: A Systematic Review and Met... |
| `src_62da4dc132f02fdb` | cc by-nc-nd | Automated external defibrillator accessibility is crucial for bystander defibrillation and s... |
| `src_6c3a73203a65f865` | cc by-nc-nd | Elementary physical education: A focus on fitness activities and smaller class sizes are ass... |
| `src_6cefb3a6aeb9b066` | cc by-nc-nd | Mouthguard Use and Cardiopulmonary Capacity - A Systematic Review and Meta-Analysis. |
| `src_76cf603d6c5f5e0c` | cc by-nc-nd | AOSSM Early Sport Specialization Consensus Statement. |
| `src_8742970d108dd2dd` | cc by-nc-nd | Maturity-associated considerations for training load, injury risk, and physical performance ... |
| `src_b001691dfcb1d75e` | cc by-nc-nd | Integrating psychological profiling with deep learning for enhanced boxing action recognition. |
| `src_b61baf7ebebde173` | cc by-nc-nd | Characterizing Head Impact Exposure in Men and Women During Boxing and Mixed Martial Arts |
| `src_c1c9cee6b09b2228` | cc by-nc-nd | Emergency Preparedness for Sudden Cardiac Arrest in Amateur Athletic Union Basketball Teams:... |
| `src_ca997230fe7297cb` | cc by-nc-nd | Validity of Commercially Available Punch Trackers |
| `src_d1ef7417636f97c7` | cc by-nc-nd | Effect of High-Intensity Interval Training With Varying Work-to-Rest Ratios on Specific Phys... |
| `src_ddc062c08f6073ac` | cc by-nc-nd | Emergency Action Planning in School-Based Athletics: A Systematic Review. |
| `src_e35814038155df68` | cc by-nc-nd | High satisfaction and improved quality of life with Rock Steady Boxing in Parkinson's diseas... |
| `src_ec94dd971496f030` | cc by-nc-nd | Barriers and facilitators of sports participation among rural-dwelling, Hispanic girls in so... |
| `src_007baaeadb5ffd1e` | cc by-nc-sa | Impact of mouthguards on the prevention of dentofacial injuries and sports performance among... |
| `src_f96c5c5d92e95fad` | cc by-nc-sa | Systematic Review and Meta-Analysis of the Y-Balance Test Lower Quarter: Reliability, Discri... |

## Limits

- **Coverage.** Europe PMC holds a licence only for articles in its open-access
  subset. A paper can be open on the publisher's site and still read `unknown`
  here. That is "no evidence", not "closed".
- **Version.** The licence is the one Europe PMC records for the article version
  it holds. It is evidence for that article, recorded on 2026-10-05.
- **Seed ids vs. live ids.** Rows are keyed by the seed `source_id`. Production
  may hold copies (`metadata.copied_from_source_id`, as the migration's ppbf_owned
  step handles), and the apply run must decide whether a copy inherits its
  original's approved class.
- **MISRESOLVED rows (149)** were not looked up. Once their identifiers are
  repaired, re-running `build_proposal.py` classifies them.

## Rebuild

From the repo root: `python docs/research/library-rights-proposal-2026-10-05/build_proposal.py`.
It reuses `lookups.json` as a cache. Delete that file first to re-query Europe PMC.
