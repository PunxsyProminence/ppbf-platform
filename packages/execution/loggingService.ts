export function logToContinuityLedger(action: string, details: any, user: string = 'System') {
  const logEntry = {
    timestamp: new Date().toISOString(),
    action,
    details,
    user,
    source: 'PPBF Platform',
  };

  // In production: save to Supabase + trigger governance review if needed
  console.log('[CONTINUITY LEDGER]', logEntry);
  
  return logEntry;
}

export function logSafetyEvent(event: string, participantId: string, severity: 'low' | 'medium' | 'high') {
  return logToContinuityLedger('SAFETY_EVENT', { event, participantId, severity }, 'Safety System');
}
