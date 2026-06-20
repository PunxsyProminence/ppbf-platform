export function calculateGoalProgress(goal: any, sessions: any[]) {
  if (!goal || !sessions.length) return { progress: 0, status: 'not_started' };

  const completedSessions = sessions.filter(s => 
    s.skillFocus?.some((skill: string) => goal.relatedSkills?.includes(skill))
  ).length;

  const progress = Math.min(Math.round((completedSessions / (goal.targetSessions || 10)) * 100), 100);

  return {
    progress,
    status: progress >= 100 ? 'completed' : progress > 0 ? 'in_progress' : 'not_started',
    completedSessions,
    targetSessions: goal.targetSessions || 10,
  };
}
