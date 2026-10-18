'use client';

import { useEffect, useState } from 'react';
import { apiBase } from '@/lib/apiBase';
import {
  type AttendanceWindowView,
  attendanceRateWords,
  attendanceWindowWords,
  daysSinceWords,
  isAttendanceWindow,
} from '@/src/lib/attendanceWords';

// The picked athlete's attendance over the last 28 days and the last day they
// were marked present, from the class register (OD-2026-10-17-026 (c),
// coaches only). Shown in the coach's wellness view; the route refuses
// everyone but staff of the gym. A failed read is never shown as "no
// register". Keyed by athlete where it is mounted, and each read is dropped
// if the athlete changes before it lands.

// Each answer carries the athlete it is for; one for another athlete reads
// as still loading (derived, so the effect sets no state before its fetch).
type Reading =
  | { state: 'loading' }
  | { state: 'unavailable'; athleteId: string }
  | { state: 'loaded'; athleteId: string; attendance: AttendanceWindowView };

export default function AthleteAttendancePanel({ athleteId }: { athleteId: string }) {
  const [answer, setAnswer] = useState<Reading>({ state: 'loading' });
  const reading: Reading = answer.state !== 'loading' && answer.athleteId === athleteId ? answer : { state: 'loading' };

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const response = await fetch(
          `${apiBase()}/api/pilot/coach/athlete-attendance?athlete_id=${encodeURIComponent(athleteId)}`,
          { method: 'GET', credentials: 'include' },
        );
        const payload = response.ok ? ((await response.json().catch(() => null)) as { attendance?: unknown } | null) : null;
        if (!current) return;
        setAnswer(payload && isAttendanceWindow(payload.attendance)
          ? { state: 'loaded', athleteId, attendance: payload.attendance }
          : { state: 'unavailable', athleteId });
      } catch {
        if (current) setAnswer({ state: 'unavailable', athleteId });
      }
    })();
    return () => {
      current = false;
    };
  }, [athleteId]);

  return (
    <div className="space-y-[var(--s1)]" data-testid="coach-athlete-attendance">
      <p className="t-label">Attendance (coaches only)</p>
      {reading.state === 'loading' && <p className="t-muted">Reading the register…</p>}
      {reading.state === 'unavailable' && (
        <p className="t-muted">Attendance could not be read just now. That is not the same as no register.</p>
      )}
      {reading.state === 'loaded' && (
        <>
          <p className="t-body">Last 28 days: {attendanceRateWords(reading.attendance)}</p>
          <p className="t-muted">{attendanceWindowWords(reading.attendance)}</p>
          <p className="t-body">{daysSinceWords(reading.attendance)}</p>
        </>
      )}
    </div>
  );
}
