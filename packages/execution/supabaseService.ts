// packages/execution/supabaseService.ts
// Minimal client-side stubs. In prod use @supabase/supabase-js + RLS

import { ParticipantProfile, SessionLog } from './models';

export async function fetchParticipant(id: string): Promise<ParticipantProfile | null> {
  // Placeholder - integrate real Supabase client
  return {
    id,
    fullName: 'Demo Participant',
    participantType: 'Youth Development (Non-Contact Safe)',
    baseline: { age: 14, experience: 'beginner' },
    risk: { medical: false },
    consentStatus: true,
  };
}

export async function logSession(log: Omit<SessionLog, 'id'>): Promise<SessionLog> {
  return {
    id: 'sess-' + Date.now(),
    ...log,
  };
}
