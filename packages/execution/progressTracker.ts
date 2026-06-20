export interface ProgressEntry {
  participantId: string;
  date: string;
  skillArea: string;
  score: number;
  notes: string;
}

export function calculateProgressTrend(entries: ProgressEntry[]) {
  if (entries.length < 2) return { trend: 'insufficient_data', change: 0 };

  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date));
  const first = sorted[0].score;
  const last = sorted[sorted.length - 1].score;
  const change = last - first;

  return {
    trend: change > 0 ? 'improving' : change < 0 ? 'declining' : 'stable',
    change: change,
  };
}
