export function exportParticipantsToCSV(participants: any[]) {
  if (!participants.length) return 'No data to export';

  const headers = Object.keys(participants[0]).join(',');
  const rows = participants.map(p => Object.values(p).join(',')).join('\n');
  
  return headers + '\n' + rows;
}

export function exportSessionsToJSON(sessions: any[]) {
  return JSON.stringify(sessions, null, 2);
}
