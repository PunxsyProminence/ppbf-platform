// The controlled general-research classification taxonomy.
//
// This list is the code half of the crosswalk table in section 5 of
// docs/SHADOW_RESEARCH_ARCHITECTURE.md. researchClassification.test.ts parses
// that table out of the shipped markdown and asserts it equals this constant,
// so the two cannot drift apart.
//
// `archiveCode` IS THE OWNER-APPROVED TARGET TAXONOMY CROSSWALK, NOT PROOF OF
// PHYSICAL SHAREPOINT CONFORMANCE. The permanent governed archive is the
// nonprofit Microsoft SharePoint workspace, but the exact site, document
// library, root folder, stable IDs, and existing folder structure remain
// pending verification. Do not build routing, filing, or upload behavior on
// `archiveCode` until that technical target is verified.
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
