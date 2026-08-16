// The general-research classification taxonomy, verbatim from issue #345's
// workflow 3. Shared between the intake UI (picker) and the sources route
// (validation) so the two can never drift.
//
// Classification is a HUMAN-PICKED, human-correctable label stored in the
// source's metadata. It is organizational filing, not evidence doctrine: it
// carries no authority-tier meaning, changes no gate, and promotes nothing.

export const RESEARCH_CLASSIFICATION_DOMAINS = [
  { key: 'boxing_athlete_development', label: 'Boxing and athlete development' },
  { key: 'ai_ml_data_science', label: 'AI / ML / data science' },
  { key: 'strength_conditioning_nutrition_recovery', label: 'Strength, conditioning, nutrition, recovery' },
  { key: 'coaching_coach_development', label: 'Coaching / coach development' },
  { key: 'staff_volunteer_development', label: 'Staff / volunteer development' },
  { key: 'parent_guardian_engagement', label: 'Parent / guardian engagement' },
  { key: 'youth_development_safeguarding', label: 'Youth development / safeguarding' },
  { key: 'nonprofit_management_governance', label: 'Nonprofit management / governance / boards' },
  { key: 'fundraising_donor_development', label: 'Fundraising / donor development' },
  { key: 'finance_sustainability', label: 'Finance / sustainability' },
  { key: 'community_engagement_partnerships', label: 'Community engagement / partnerships' },
  { key: 'hr_organizational_culture', label: 'HR / organizational culture' },
  { key: 'compliance_risk_insurance', label: 'Compliance / risk / insurance' },
  { key: 'program_evaluation_outcomes', label: 'Program evaluation / outcomes' },
] as const;

export type ResearchClassificationDomain = (typeof RESEARCH_CLASSIFICATION_DOMAINS)[number]['key'];

export function isResearchClassificationDomain(value: unknown): value is ResearchClassificationDomain {
  return typeof value === 'string'
    && RESEARCH_CLASSIFICATION_DOMAINS.some((domain) => domain.key === value);
}

export function researchClassificationLabel(key: string): string {
  return RESEARCH_CLASSIFICATION_DOMAINS.find((domain) => domain.key === key)?.label ?? key;
}
