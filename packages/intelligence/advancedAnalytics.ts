export function generateAdvancedAnalytics(sessions: any[], participants: any[]) {
  const totalSessions = sessions.length;
  const avgRPE = sessions.length > 0
    ? sessions.reduce((sum, s) => sum + (s.intensityRpe ?? 0), 0) / sessions.length
    : 0;

  const safetyRate = totalSessions > 0
    ? (sessions.filter(s => s.safetyFlags?.length === 0).length / totalSessions) * 100
    : 0;

  return {
    totalSessions,
    averageRPE: Number(avgRPE.toFixed(1)),
    safetyRate: safetyRate.toFixed(1) + '%',
    participantCount: participants.length,
    topSkillFocus: ['Emotional Regulation', 'Tactical Decision Making'],
  };
}
