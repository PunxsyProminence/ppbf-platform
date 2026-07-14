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
