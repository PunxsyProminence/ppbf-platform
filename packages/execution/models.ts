// packages/execution/models.ts
// Core domain models aligned to Supabase schema + 25-capabilities

export interface ParticipantProfile {
  id: string;
  fullName: string;
  participantType: string; // youth | adaptive | deconditioned | competitive | AF_SPECOPS | ...
  baseline: Record<string, any>;
  risk: Record<string, any>;
  consentStatus: boolean;
}

export interface SessionLog {
  id: string;
  participantId: string;
  sessionDate: string;
  intensityRpe: number;
  skillFocus: string[]; // from taskDimensions
  safetyFlags: string[];
  reflections?: string;
  coachReviewStatus: 'Pending' | 'Approved' | 'Adjustments' | 'Paused';
}

export interface DevelopmentRoute {
  id: string;
  participantId: string;
  goalIntake: Record<string, any>;
  assignedRoute: string;
  taskDimensions: string[];
  lifecycleTags: string[];
}

export interface Assignment {
  id: string;
  participantId: string;
  title: string;
  taskDimension: string;
  lifecycleTag: string;
  status: 'Assigned' | 'In Progress' | 'Completed' | 'Paused';
  dueDate?: string;
}

// Safety gate helpers (Cap #11, #20)
export function isSafetyCleared(session: SessionLog): boolean {
  return (session.safetyFlags || []).length === 0 && session.intensityRpe <= 8;
}

export function applySafetyRefusal(session: Partial<SessionLog>): string[] {
  const flags: string[] = [];
  if ((session.intensityRpe || 0) > 9) flags.push('RPE_TOO_HIGH');
  if (!session.skillFocus || session.skillFocus.length === 0) flags.push('NO_SKILL_FOCUS');
  return flags;
}
