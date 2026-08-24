// The controlled general-research classification taxonomy.
//
// This list is the code half of the crosswalk table in section 5 of
// docs/SHADOW_RESEARCH_ARCHITECTURE.md. researchClassification.test.ts parses
// that table out of the shipped markdown and asserts it equals this constant,
// so the two cannot drift apart.
//
// `archiveCode` IS A DOCUMENTATION CROSSWALK THAT NOTHING ENFORCES.
//
// Corrected 2026-08-24. This comment read "UNVERIFIED ... NOT ARCHIVE TRUTH"
// and said section 1 of that document was "an unconfirmed proposal: no
// manifest, export, connector record, or configuration value anywhere in this
// repository corroborates that those folders exist". The R01-R19 structure is
// now verified to exist in the permanent SharePoint archive, so that ground is
// gone.
//
// THE CONCLUSION IS UNCHANGED, for the half of the original reason that was
// always the load-bearing half: NO RESEARCH-SPECIFIC ROUTE OR CONFIGURATION IS
// WIRED TO THE PERMANENT RESEARCH ARCHIVE, AND NO RUNTIME CODE ROUTES OR FILES
// RESEARCH BY `archiveCode`. Nothing derives a destination from a subject code,
// and no test asserts where an `adaptive_inclusive_practice` source lands.
//
// Stated that precisely because the blunter version -- "no code in this
// repository reads or writes them" -- is not true. The generic uploader in
// server/document-intake/sharepoint.ts takes a CONFIGURABLE destination
// (`SHAREPOINT_FOLDER_PATH`, defaulting to `PPBF/Intake`), so a configuration
// value could in principle aim it at the archive. What does not exist is a
// research-specific path that does so.
//
// "The folder exists" and "this mapping is wired to it" are two claims, and
// only the first one changed. Do not build routing, filing, or upload behavior
// on `archiveCode` as though the destination were wired.
//
// R00 (Unsorted Drop) and R98 (Duplicate Hold) are workflow states, not subject
// domains, so neither belongs in this list -- by code and by key alike. Note
// that "duplicate" here would mean archive lineage hold, which is a different
// thing from the `duplicate` applicability verdict in /research/review.
//
// Classification remains organizational filing, not evidence doctrine: it
// carries no authority-tier meaning, changes no review gate, and promotes
// nothing.

export const RESEARCH_CLASSIFICATION_DOMAINS = [
  { key: 'boxing_athlete_development', label: 'Boxing and athlete development', archiveCode: 'R01' },
  { key: 'ai_ml_data_science', label: 'AI / ML / data science', archiveCode: 'R02' },
  { key: 'strength_conditioning_nutrition_recovery', label: 'Strength, conditioning, nutrition, recovery', archiveCode: 'R03' },
  { key: 'coaching_coach_development', label: 'Coaching / coach development', archiveCode: 'R04' },
  { key: 'staff_volunteer_development', label: 'Staff / volunteer development', archiveCode: 'R05' },
  { key: 'parent_guardian_engagement', label: 'Parent / guardian engagement', archiveCode: 'R06' },
  { key: 'youth_development_safeguarding', label: 'Youth development / safeguarding', archiveCode: 'R07' },
  { key: 'nonprofit_management_governance', label: 'Nonprofit management / governance / boards', archiveCode: 'R08' },
  { key: 'fundraising_donor_development', label: 'Fundraising / donor development', archiveCode: 'R09' },
  { key: 'finance_sustainability', label: 'Finance / sustainability', archiveCode: 'R10' },
  { key: 'community_engagement_partnerships', label: 'Community engagement / partnerships', archiveCode: 'R11' },
  { key: 'hr_organizational_culture', label: 'HR / organizational culture', archiveCode: 'R12' },
  { key: 'compliance_risk_insurance', label: 'Compliance / risk / insurance', archiveCode: 'R13' },
  { key: 'program_evaluation_outcomes', label: 'Program evaluation / outcomes', archiveCode: 'R14' },
  { key: 'water_safety_aquatics', label: 'Water safety and aquatics', archiveCode: 'R15' },
  { key: 'adaptive_inclusive_practice', label: 'Adaptive and inclusive practice', archiveCode: 'R16' },
  { key: 'multidiscipline_wrestling_grappling', label: 'Multidiscipline wrestling and grappling', archiveCode: 'R17' },
  { key: 'learning_science_skill_acquisition', label: 'Learning science and skill acquisition', archiveCode: 'R18' },
  { key: 'measurement_assessment_instruments', label: 'Measurement and assessment instruments', archiveCode: 'R19' },
] as const;

export type ResearchClassificationDomain = (typeof RESEARCH_CLASSIFICATION_DOMAINS)[number]['key'];
export type ResearchArchiveDomainCode = (typeof RESEARCH_CLASSIFICATION_DOMAINS)[number]['archiveCode'];

export function isResearchClassificationDomain(value: unknown): value is ResearchClassificationDomain {
  return typeof value === 'string'
    && RESEARCH_CLASSIFICATION_DOMAINS.some((domain) => domain.key === value);
}

export function researchClassificationLabel(key: string): string {
  return RESEARCH_CLASSIFICATION_DOMAINS.find((domain) => domain.key === key)?.label ?? key;
}

export function researchClassificationArchiveCode(key: string): ResearchArchiveDomainCode | null {
  return RESEARCH_CLASSIFICATION_DOMAINS.find((domain) => domain.key === key)?.archiveCode ?? null;
}
