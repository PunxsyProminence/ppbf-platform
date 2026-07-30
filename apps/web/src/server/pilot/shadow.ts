export type ShadowClassification =
  | 'Session Note'
  | 'Athlete Profile Update Candidate'
  | 'Coach Review Candidate'
  | 'Unclassified';

export type ShadowQueue =
  | 'Session Queue'
  | 'Athlete Review Queue'
  | 'Coach Review Queue'
  | 'Admin SHADOW Queue';

export type ShadowSourceStatus = 'observed' | 'approved' | 'rejected' | 'promoted';

export type ShadowSourceVerificationState = 'verified' | 'partially_verified' | 'unverified' | 'unknown';

export function classifyShadowDocument(fileName: string, hint?: string): ShadowClassification {
  const candidate = `${fileName} ${hint || ''}`.toLowerCase();

  if (candidate.includes('session') || candidate.includes('training note')) {
    return 'Session Note';
  }

  if (candidate.includes('profile') || candidate.includes('athlete update')) {
    return 'Athlete Profile Update Candidate';
  }

  if (candidate.includes('coach review') || candidate.includes('review')) {
    return 'Coach Review Candidate';
  }

  return 'Unclassified';
}

export function routeShadowClassification(classification: ShadowClassification): ShadowQueue {
  if (classification === 'Session Note') {
    return 'Session Queue';
  }

  if (classification === 'Athlete Profile Update Candidate') {
    return 'Athlete Review Queue';
  }

  if (classification === 'Coach Review Candidate') {
    return 'Coach Review Queue';
  }

  return 'Admin SHADOW Queue';
}

function inferKnowledgeGap(classification: ShadowClassification): string {
  if (classification === 'Session Note') {
    return 'Session insight not yet validated into athlete progression guidance.';
  }

  if (classification === 'Athlete Profile Update Candidate') {
    return 'Athlete profile change requires human verification and domain promotion decision.';
  }

  if (classification === 'Coach Review Candidate') {
    return 'Coach review recommendation requires explicit approval before operational adoption.';
  }

  return 'Source intent is unclassified and requires manual triage.';
}

export function buildUploadResearchFields(params: {
  fileName: string;
  documentType: string;
  classification: ShadowClassification;
  routedQueue: ShadowQueue;
}): {
  researchRequirement: string;
  knowledgeGap: string;
  sourceStatus: ShadowSourceStatus;
  sourceVerificationState: ShadowSourceVerificationState;
} {
  return {
    researchRequirement: `Review ${params.documentType} (${params.fileName}) and validate routing to ${params.routedQueue}.`,
    knowledgeGap: inferKnowledgeGap(params.classification),
    sourceStatus: 'observed',
    sourceVerificationState: 'unverified',
  };
}

export function buildReviewResearchFields(params: {
  action: 'approve' | 'reject' | 'promote';
  intakeCaseId: string;
}): {
  researchRequirement: string;
  knowledgeGap: string;
  sourceStatus: ShadowSourceStatus;
  sourceVerificationState: ShadowSourceVerificationState;
} {
  if (params.action === 'approve') {
    return {
      researchRequirement: `Approved intake case ${params.intakeCaseId} must be validated for promotion readiness.`,
      knowledgeGap: 'Approval granted, but lineage and downstream consistency still require confirmation.',
      sourceStatus: 'approved',
      sourceVerificationState: 'partially_verified',
    };
  }

  if (params.action === 'reject') {
    return {
      researchRequirement: `Rejected intake case ${params.intakeCaseId} should document remediation requirements before resubmission.`,
      knowledgeGap: 'Rejection reason resolved status is unknown until new evidence is submitted.',
      sourceStatus: 'rejected',
      sourceVerificationState: 'unverified',
    };
  }

  return {
    researchRequirement: `Promoted intake case ${params.intakeCaseId} requires post-promotion verification of operational records.`,
    knowledgeGap: 'Promotion complete, but ongoing quality verification and correction readiness are still required.',
    sourceStatus: 'promoted',
    sourceVerificationState: 'verified',
  };
}
