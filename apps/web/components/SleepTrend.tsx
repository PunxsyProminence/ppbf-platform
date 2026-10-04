import { SLEEP_HOURS_TYPICAL_MAX } from '@/src/shared/wellnessScales';

// Map item 20: the sleep hours an athlete reported on their recent check-ins,
// newest first. Shown to the athlete (their own) and to staff (one athlete at
// a time).
//
// READ ONLY AND NOTHING DERIVED. Each row is the day and the hours as stored;
// a skipped question says so rather than drawing as zero. No average, no
// target line, no colour that grades the night, and no advice: there is no
// sourced guidance in the app for it, and a self-report is not a measurement.
// The bar is only a visual length -- full width at SLEEP_HOURS_TYPICAL_MAX,
// the top of the typical range the check-in form already uses -- not a score.

export interface SleepTrendItem {
  checked_in_on: string;
  sleep_hours: number | null;
}

export function sleepBarPercent(hours: number): number {
  return Math.max(0, Math.min(100, (hours / SLEEP_HOURS_TYPICAL_MAX) * 100));
}

export default function SleepTrend({ items, heading }: { items: readonly SleepTrendItem[]; heading: string }) {
  return (
    <section aria-label={heading} className="space-y-[var(--s2)]">
      <h4 className="t-label">{heading}</h4>
      {items.length === 0 ? (
        <p className="t-muted">No check-ins recorded yet.</p>
      ) : (
        <ul className="space-y-[var(--s1)]">
          {items.map((item) => (
            <li
              key={item.checked_in_on}
              className="grid grid-cols-[7rem_1fr_6.5rem] items-center gap-[var(--s2)]"
              style={{ fontSize: 'var(--t-sm)' }}
            >
              <span className="t-data">{item.checked_in_on}</span>
              <span aria-hidden="true" className="block h-[0.5rem] rounded-[var(--r-sm)] bg-[rgba(0,0,0,.28)]">
                {item.sleep_hours !== null && (
                  <span
                    className="block h-full rounded-[var(--r-sm)] bg-[color:var(--bone-400)]"
                    style={{ width: `${sleepBarPercent(item.sleep_hours)}%` }}
                  />
                )}
              </span>
              <span className={item.sleep_hours === null ? 't-data text-[color:var(--bone-400)]' : 't-data'}>
                {item.sleep_hours === null ? 'not answered' : `${item.sleep_hours} hours`}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="t-muted">Self-reported at check-in.</p>
    </section>
  );
}
