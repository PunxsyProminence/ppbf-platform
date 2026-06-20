import type { ParticipantProfile, SessionLog, Assignment } from './models';
import { logToContinuityLedger, logSafetyEvent } from './loggingService';

export class PPBFService {
  async getParticipant(id: string): Promise<ParticipantProfile | null> {
    // Connect to Supabase here
    return null;
  }

  async logSession(log: Omit<SessionLog, 'id'>) {
    // Save to Supabase + Continuity Ledger
    logToContinuityLedger('SESSION_LOG', log, 'Participant');
    return { success: true, id: crypto.randomUUID() };
  }

  async getAssignments(participantId: string): Promise<Assignment[]> {
    return [];
  }

  async submitReflection(participantId: string, reflection: string) {
    // Route to Coach Review Queue + Safety Gate
    logToContinuityLedger('REFLECTION_SUBMITTED', { participantId, reflection }, 'Participant');
    return { success: true, loggedToLedger: true };
  }
}

export const ppbfService = new PPBFService();
