export interface MasterTutorialCard {
  id: string;
  title: string;
  purpose: string;
  whoUsesIt: string;
  currentStatus: string;
  href: string;
}

export interface GuideSection {
  id: string;
  title: string;
  whatThisAreaIsFor: string;
  whoShouldUseIt: string;
  activeNow: string;
  placeholderOrPlanned: string;
  doNotTestYet: string;
  usefulFeedback: string;
  whereToGoNext: string;
}

export interface PlannedCapabilityGuide {
  id: string;
  title: string;
  currentStatus: string;
  whereItAppears: string;
  whatIsPlanned: string;
  whatIsNotAutomated: string;
  backendDependency: string;
  humanReviewRequirement: string;
}

export const masterTutorialCards: MasterTutorialCard[] = [
  {
    id: 'start-here',
    title: 'Start Here',
    purpose: 'Orientation for first-time users to safely navigate PPBF.',
    whoUsesIt: 'All roles, pilot users, and partner gyms.',
    currentStatus: 'ACTIVE GUIDE | FRONT-END SAFE',
    href: '/help#start-here',
  },
  {
    id: 'mission-control-overview',
    title: 'Mission Control Overview',
    purpose: 'Explains The Ring, role selector, and capability map.',
    whoUsesIt: 'Gym administrators and the platform owner. Restricted to those two roles by owner decision on 2026-08-26; every other role works from its own surfaces.',
    currentStatus: 'ACTIVE GUIDE | FRONT-END SAFE',
    href: '/help#mission-control-overview',
  },
  {
    id: 'athlete-guide',
    title: 'Athlete Workspace Guide',
    purpose: 'Covers dashboard, goals, tasks, readiness, and progress tracking.',
    whoUsesIt: 'Athletes and coaches supporting athlete onboarding.',
    currentStatus: 'ACTIVE GUIDE | MIXED LIVE + PLACEHOLDER',
    href: '/help#athlete-guide',
  },
  {
    id: 'coach-guide',
    title: 'Coach Workspace Guide',
    purpose: 'Explains review queue, floor actions, and coach workflows.',
    whoUsesIt: 'Coaches and admin reviewers.',
    currentStatus: 'ACTIVE GUIDE | MIXED LIVE + PLACEHOLDER',
    href: '/help#coach-guide',
  },
  {
    id: 'parent-guide',
    title: 'Parent Hub Guide',
    purpose: 'Explains family support, observations, goals, and visibility lanes.',
    whoUsesIt: 'Parents/guardians and support staff.',
    currentStatus: 'ACTIVE GUIDE | MIXED LIVE + PLACEHOLDER',
    href: '/help#parent-guide',
  },
  {
    id: 'board-guide',
    title: 'Board Workspace Guide',
    purpose: 'Explains governance tabs, policies, resolutions, committees, and compliance lanes.',
    whoUsesIt: 'Board roles and governance stakeholders.',
    currentStatus: 'ACTIVE GUIDE | MIXED LIVE + PLACEHOLDER',
    href: '/help#board-guide',
  },
  {
    id: 'admin-guide',
    title: 'Admin Hub Guide',
    purpose: 'Explains capability controls, compliance center, and platform governance.',
    whoUsesIt: 'Admin operators and platform maintainers.',
    currentStatus: 'ACTIVE GUIDE | MIXED LIVE + PLACEHOLDER',
    href: '/help#admin-guide',
  },
  {
    id: 'revenue-guide',
    title: 'Revenue & Funding Guide',
    purpose: 'Explains memberships, donations, sponsors, grants, and treasurer review lanes.',
    whoUsesIt: 'Admin, finance operators, and board treasurer workflows.',
    currentStatus: 'ACTIVE GUIDE | FRONT-END FLOW | BACKEND REQUIRED',
    href: '/help#revenue-guide',
  },
  {
    id: 'development-lab-guide',
    title: 'Development Lab Guide',
    purpose: 'Explains intake through publication surfaces and governance gates.',
    whoUsesIt: 'Research and development contributors.',
    currentStatus: 'ACTIVE GUIDE | MIXED LIVE + PLACEHOLDER',
    href: '/help#development-lab-guide',
  },
  {
    id: 'shadow-guide',
    title: 'SHADOW Guide',
    purpose: 'Explains SHADOW role views, boundaries, and supported questions.',
    whoUsesIt: 'All authenticated roles with SHADOW access.',
    currentStatus: 'ACTIVE GUIDE | LIVE AI CHAT | EDUCATIONAL SUPPORT ONLY',
    href: '/help#shadow-guide',
  },
  {
    id: 'public-portal-guide',
    title: 'Public Portal Guide',
    purpose: 'Explains intake paths, public boundaries, and what public users cannot access.',
    whoUsesIt: 'Public visitors, volunteers, sponsors, and partners.',
    currentStatus: 'ACTIVE GUIDE | FRONT-END SAFE',
    href: '/help#public-portal-guide',
  },
  {
    id: 'tester-guide',
    title: 'Tester Guide',
    purpose: 'Pilot and partner-gym test playbook for what to test and what is not live.',
    whoUsesIt: 'Pilot users, partner gyms, QA reviewers.',
    currentStatus: 'ACTIVE GUIDE | FRONT-END VALIDATION',
    href: '/help#tester-guide',
  },
  {
    id: 'planned-capabilities-guide',
    title: 'Planned Capabilities Guide',
    purpose: 'Defines roadmap-only capability surfaces and non-automated boundaries.',
    whoUsesIt: 'All roles to avoid misinterpreting placeholder features.',
    currentStatus: 'ACTIVE GUIDE | ROADMAP CLARITY',
    href: '/help#planned-capabilities-guide',
  },
];

export const guideSections: GuideSection[] = [
  {
    id: 'start-here',
    title: 'Start Here',
    whatThisAreaIsFor: 'Quick orientation before using any PPBF workspace.',
    whoShouldUseIt: 'All roles, pilot users, and partner gyms.',
    activeNow: 'Role-based workspaces, the corridor and card catalog, and placeholder labels are visible.',
    placeholderOrPlanned: 'AI/ML automation, compliance automation, and publication automation are roadmap items.',
    doNotTestYet: 'Do not treat placeholders as completed production workflows.',
    usefulFeedback: 'Report navigation confusion, unclear labels, and missing expected links.',
    whereToGoNext: 'Open the guide for your own role -- each workspace links its own.',
  },
  {
    id: 'mission-control-overview',
    title: 'Mission Control Overview',
    whatThisAreaIsFor: 'The administration launcher (The Ring): role workspaces, development lanes, and the capability register.',
    whoShouldUseIt: 'Gym administrators and the platform owner only.',
    activeNow: 'Role selector, workspace links, development lab links, and capability visibility map.',
    placeholderOrPlanned: 'Some capabilities map to placeholder pages that are labeled as planned.',
    doNotTestYet: 'Do not treat placeholder capability cards as backend-integrated systems.',
    usefulFeedback: 'Call out incorrect route targets, missing links, or misleading status wording.',
    whereToGoNext: 'Open a role workspace and use HOW THIS WORKS for role-specific instructions.',
  },
  {
    id: 'athlete-guide',
    title: 'Athlete Guide',
    whatThisAreaIsFor: 'Athlete workspace for readiness, goals, tasks, and visible progress.',
    whoShouldUseIt: 'Athletes and coaches guiding athlete workflow.',
    activeNow: 'Athlete dashboard and training support surfaces.',
    placeholderOrPlanned: 'Progression intelligence and video analysis are placeholders with roadmap labels.',
    doNotTestYet: 'No AI scoring, no automated recommendations, no production video inference.',
    usefulFeedback: 'Report readability, missing fields, and timeline clarity needs.',
    whereToGoNext: 'Coach workspace for review flow, or Parent guide for family visibility.',
  },
  {
    id: 'coach-guide',
    title: 'Coach Guide',
    whatThisAreaIsFor: 'Coach review queue and floor decision support surfaces.',
    whoShouldUseIt: 'Coaches and admin reviewers.',
    activeNow: 'Review queue, coach workflow lanes, and operational navigation.',
    placeholderOrPlanned: 'Film/video analysis and progression intelligence are front-end placeholders.',
    doNotTestYet: 'No ML film scoring, no autonomous recommendations, no backend queues on placeholder pages.',
    usefulFeedback: 'Capture gaps in review workflow order, decision labeling, and handoff clarity.',
    whereToGoNext: 'The card catalog for adjacent workspaces, or the Planned Capabilities Guide for roadmap context.',
  },
  {
    id: 'parent-guide',
    title: 'Parent Guide',
    whatThisAreaIsFor: 'Family support visibility for tasks, observations, and progress context.',
    whoShouldUseIt: 'Parents/guardians and family support operators.',
    activeNow: 'Parent hub workflow and family-support visibility surfaces.',
    placeholderOrPlanned: 'Progression visibility lane is planned/placeholder and not automated.',
    doNotTestYet: 'No backend sync for progression placeholders and no automated family recommendations.',
    usefulFeedback: 'Share whether task visibility and family updates are easy to follow.',
    whereToGoNext: 'Athlete/Coach guides for connected context and feedback routing.',
  },
  {
    id: 'board-guide',
    title: 'Board Guide',
    whatThisAreaIsFor: 'Governance workspace for policy, strategy, resolutions, committees, and oversight.',
    whoShouldUseIt: 'Board roles and governance reviewers.',
    activeNow: 'Board seat workspaces, governance tabs, and board SHADOW boundary views.',
    placeholderOrPlanned: 'Compliance monitoring automation remains placeholder/planned.',
    doNotTestYet: 'No automated legal/compliance filing actions and no backend compliance engines.',
    usefulFeedback: 'Report governance tab clarity, role visibility issues, or compliance wording drift.',
    whereToGoNext: 'Admin guide for platform controls and Planned Capabilities Guide for compliance roadmap.',
  },
  {
    id: 'admin-guide',
    title: 'Admin Guide',
    whatThisAreaIsFor: 'Platform control for capability management, compliance center access, and governance posture.',
    whoShouldUseIt: 'Admin operators and platform maintainers.',
    activeNow: 'Capability management, assignment matrix, and Revenue & Funding center tabs.',
    placeholderOrPlanned: 'Compliance center and some critical systems are placeholder/planned.',
    doNotTestYet: 'Avoid assuming backend automation, payment processing, or AI/ML execution.',
    usefulFeedback: 'Flag unclear control labels, missing checks, and workflow friction points.',
    whereToGoNext: 'Revenue guide, Development Lab guide, and Tester guide for execution scope.',
  },
  {
    id: 'revenue-guide',
    title: 'Revenue Guide',
    whatThisAreaIsFor: 'Funding workflow visibility for memberships, donations, sponsors, grants, scholarships, B2B, wholesale, and treasurer review.',
    whoShouldUseIt: 'Admin finance operators and board treasurer workflows.',
    activeNow: 'Front-end records, status lanes, and treasurer review queue placeholders.',
    placeholderOrPlanned: 'Payment providers and accounting integrations are not connected.',
    doNotTestYet: 'No real payment processing, no real accounting sync, no backend settlement.',
    usefulFeedback: 'Report missing status clarity and unclear queue actions for financial review.',
    whereToGoNext: 'Admin guide and Planned Capabilities Guide for integration roadmap.',
  },
  {
    id: 'development-lab-guide',
    title: 'Development Lab Guide',
    whatThisAreaIsFor: 'Research-to-publication lifecycle visibility for intake, review, graph, simulation, audit, and source control.',
    whoShouldUseIt: 'Research/development users and governance reviewers.',
    activeNow: 'Research intake, evidence review, knowledge graph, simulator, audit, and source-control surfaces.',
    placeholderOrPlanned: 'Publication workflow automation remains placeholder with human gates.',
    doNotTestYet: 'No automatic publication execution and no backend promotion engine.',
    usefulFeedback: 'Identify unclear stage transitions and missing governance checkpoint messaging.',
    whereToGoNext: 'Source Control surface and Planned Capabilities Guide.',
  },
  {
    id: 'shadow-guide',
    title: 'SHADOW Guide',
    whatThisAreaIsFor: 'Role-aware SHADOW interaction and governance-aware signal visibility.',
    whoShouldUseIt: 'Authenticated users by role. SHADOW chat is not available to the board role.',
    activeNow: 'SHADOW chat is live and sends your messages to a real AI language model. Conversations are stored against your account so SHADOW can refer back to them, and you can rename, export, or request deletion of them. Backend telemetry, authority checks, and metrics are implemented and recording.',
    placeholderOrPlanned: 'Background modes (scout reports and board summaries) are not active yet and will tell you so. The parent SHADOW view and any public SHADOW surface are still incomplete.',
    doNotTestYet: 'SHADOW is educational decision support only. It is never diagnostic and never replaces a coach, a medical professional, or any other human decision-maker. Do not use it to make medical, clearance, or return-to-play decisions.',
    usefulFeedback: 'Report response clarity, role language mismatches, and boundary concerns.',
    whereToGoNext: 'Role guide matching your workspace and Tester guide for pilot validation scope.',
  },
  {
    id: 'public-portal-guide',
    title: 'Public Portal Guide',
    whatThisAreaIsFor: 'Public-facing awareness and intake for interest, volunteer, sponsor, and partner pathways.',
    whoShouldUseIt: 'Public visitors and outreach teams.',
    activeNow: 'Public pathway cards, intake form, FAQ, and quick links.',
    placeholderOrPlanned: 'Submission handling is front-end only and requires human follow-up.',
    doNotTestYet: 'No account creation, no private workspace access, and no internal data exposure.',
    usefulFeedback: 'Report confusing language, missing pathway clarity, and boundary wording concerns.',
    whereToGoNext: 'Tester guide, for internal reviewers.',
  },
  {
    id: 'tester-guide',
    title: 'Tester Guide',
    whatThisAreaIsFor: 'Pilot test plan for partner gyms and trial users.',
    whoShouldUseIt: 'Pilot users, partner gyms, QA reviewers.',
    activeNow: 'Role routes, workspace navigation, and placeholder status labels can be validated.',
    placeholderOrPlanned: 'AI/ML, payments, compliance automation, and publication automation are planned.',
    doNotTestYet: 'Do not certify placeholders as production-ready or integrated.',
    usefulFeedback: 'Provide route, labeling, UX, and expectation-mismatch feedback with reproduction steps.',
    whereToGoNext: 'Planned Capabilities Guide and role-specific guides for focused checks.',
  },
];

export const plannedCapabilityGuides: PlannedCapabilityGuide[] = [
  {
    id: 'planned-ai-video',
    title: 'AI/ML Video Analysis',
    currentStatus: 'PLANNED | FRONT-END PLACEHOLDER',
    whereItAppears: '/coach/video-analysis and /athlete/video-analysis',
    whatIsPlanned: 'Coach and athlete film feedback with analysis and comparison support.',
    whatIsNotAutomated: 'No inference pipeline, no skill recognition automation, no scoring engine.',
    backendDependency: 'Requires backend media processing and model orchestration.',
    humanReviewRequirement: 'HUMAN REVIEW REQUIRED for interpretations and progression decisions.',
  },
  {
    id: 'planned-compliance',
    title: 'Automated Compliance Monitoring',
    currentStatus: 'PLANNED | FRONT-END PLACEHOLDER',
    whereItAppears: '/board/compliance-monitoring and /admin/compliance-center',
    whatIsPlanned: 'Compliance watchlists, filing support, and governance alerts.',
    whatIsNotAutomated: 'No live compliance engine, no filing automations, no legal automation.',
    backendDependency: 'Requires backend policy/compliance services and reminders.',
    humanReviewRequirement: 'HUMAN REVIEW REQUIRED for legal/compliance approvals.',
  },
  {
    id: 'planned-progression',
    title: 'Closed-Loop Progression Intelligence',
    currentStatus: 'PLANNED | FRONT-END PLACEHOLDER',
    whereItAppears: '/athlete/progression-intelligence, /coach/progression-intelligence, /parent/progression-visibility',
    whatIsPlanned: 'Cross-role progression visibility and recommendation loops.',
    whatIsNotAutomated: 'No closed-loop recommendation engine or predictive progression automation.',
    backendDependency: 'Requires backend scoring, event capture, and recommendation services.',
    humanReviewRequirement: 'HUMAN REVIEW REQUIRED by coach/guardian for progression actions.',
  },
  {
    id: 'planned-publication',
    title: 'Automated Publication Workflow',
    currentStatus: 'PLANNED | FRONT-END PLACEHOLDER',
    whereItAppears: '/source-control/publication-workflow',
    whatIsPlanned: 'Draft-to-approved publication routing with destination controls.',
    whatIsNotAutomated: 'No autonomous publication execution and no backend release engine.',
    backendDependency: 'Requires backend workflow orchestration and publish infrastructure.',
    humanReviewRequirement: 'HUMAN REVIEW REQUIRED with approval gates before publication.',
  },
];

export function getHelpAnchorForContext(context: string): string {
  const normalized = context.toLowerCase();

  if (normalized.includes('athlete')) return 'athlete-guide';
  if (normalized.includes('coach')) return 'coach-guide';
  if (normalized.includes('parent')) return 'parent-guide';
  if (normalized.includes('board')) return 'board-guide';
  if (normalized.includes('admin')) return 'admin-guide';
  if (normalized.includes('revenue')) return 'revenue-guide';
  if (normalized.includes('development') || normalized.includes('research') || normalized.includes('evidence') || normalized.includes('source')) {
    return 'development-lab-guide';
  }
  if (normalized.includes('shadow')) return 'shadow-guide';
  if (normalized.includes('public')) return 'public-portal-guide';
  if (normalized.includes('progression') || normalized.includes('video') || normalized.includes('compliance') || normalized.includes('publication')) {
    return 'planned-capabilities-guide';
  }

  return 'start-here';
}
