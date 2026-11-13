'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';

import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';
import {
  readinessLine,
  type ClassPlanDay,
  type ClassPlanTrackDetail,
  type ClassPlanTrackSummary,
} from '@/src/server/pilot/classPlanShapes';

// Class plans: the gym's training tracks, read-only (OD-2026-11-12-005). A
// track opens as its weeks, each week as its days, each day naming its workout
// template and opening it on the Workout Templates page, where templates are
// issued. This page assigns, issues and changes nothing, and it never hides a
// day whose template is missing or withdrawn, or whose drills are not ready:
// it says so, and the template page names what is missing.

function label(key: string): string {
  const spaced = key.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** A stored detail value as text: a string, a list, or a key/value map. */
function DetailValue({ value }: { readonly value: unknown }) {
  if (Array.isArray(value)) {
    return (
      <ul className="mt-[var(--s2)] list-disc pl-[var(--s5)]">
        {value.map((entry, index) => (
          <li key={index} className="t-body text-[color:var(--bone-300)]">{asText(entry)}</li>
        ))}
      </ul>
    );
  }
  if (value !== null && typeof value === 'object') {
    return (
      <dl className="mt-[var(--s2)]">
        {Object.entries(value as Record<string, unknown>).map(([key, entry]) => (
          <div key={key} className="t-body text-[color:var(--bone-300)]">
            <dt className="inline font-semibold">{key}: </dt>
            <dd className="inline">{asText(entry)}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">{String(value)}</p>;
}

function Day({ day }: { readonly day: ClassPlanDay }) {
  const { template } = day;
  const line = readinessLine(template);
  return (
    <li className="rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] bg-[rgba(0,0,0,.28)] p-[var(--s3)]">
      <p className="t-label">{day.day}</p>
      <p className="t-body mt-[var(--s2)] font-semibold text-[color:var(--bone-100)]">
        {template.state === 'missing' ? 'Template missing' : template.name}
      </p>
      {template.state === 'withdrawn' && (
        <p className="t-body mt-[var(--s1)] text-[color:var(--bone-300)]">Withdrawn</p>
      )}
      {template.state === 'missing' && (
        <p className="t-body mt-[var(--s1)] text-[color:var(--bone-300)]">
          This gym has no current workout template for this day.
        </p>
      )}
      {line !== null && (
        <p className="t-body mt-[var(--s1)] text-[color:var(--bone-300)]">{line}</p>
      )}
      {template.template_id !== null && (
        <Link
          href={`/coach/workout-templates?template=${encodeURIComponent(template.template_id)}`}
          className="btn btn--ghost mt-[var(--s2)]"
        >
          Open template
        </Link>
      )}
    </li>
  );
}

function ClassPlans() {
  const [tracks, setTracks] = useState<ClassPlanTrackSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [openTrackId, setOpenTrackId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ClassPlanTrackDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  // Only the latest open may change what is shown (two taps on slow wifi).
  const detailRead = useRef(0);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/training-tracks`, { method: 'GET', credentials: 'include' });
      if (!response.ok) throw new Error('The class plans could not be loaded.');
      const payload = (await response.json()) as { tracks?: ClassPlanTrackSummary[] };
      setTracks(payload.tracks ?? []);
      setLoadError('');
    } catch (error) {
      setTracks([]);
      setLoadError(error instanceof Error ? error.message : 'The class plans could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const openTrack = useCallback(async (trackId: string) => {
    detailRead.current += 1;
    const thisRead = detailRead.current;
    setOpenTrackId(trackId);
    setDetail(null);
    setDetailError('');
    setDetailLoading(true);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/training-tracks?track=${encodeURIComponent(trackId)}`, {
        method: 'GET',
        credentials: 'include',
      });
      if (!response.ok) throw new Error('This class plan could not be loaded.');
      const payload = (await response.json()) as { track?: ClassPlanTrackDetail };
      if (detailRead.current !== thisRead) return;
      if (!payload.track) throw new Error('This class plan could not be loaded.');
      setDetail(payload.track);
    } catch (error) {
      if (detailRead.current !== thisRead) return;
      setDetailError(error instanceof Error ? error.message : 'This class plan could not be loaded.');
    } finally {
      if (detailRead.current === thisRead) setDetailLoading(false);
    }
  }, []);

  return (
    <main className="room room--floor min-h-screen bg-[var(--hide-950)] px-[var(--s5)] py-[var(--s6)] text-[color:var(--bone-200)]" data-surface="kiosk">
      <div className="mx-auto max-w-5xl">
      <header className="border-b-[3px] border-[color:var(--brass-700)] pb-[var(--s5)]">
        <p className="t-eyebrow">Coach Workspace</p>
        <h1 className="t-command mt-[var(--s3)] text-[length:var(--t-2xl)]">Class plans</h1>
        <p className="t-body mt-[var(--s3)] max-w-3xl text-[color:var(--bone-300)]">
          What the gym runs, class by class: each plan is a run of weeks, each week a set of days, each day
          one workout template. Open a day to see its template and issue it from there. This page only reads.
        </p>
        <div className="mt-[var(--s4)] flex flex-wrap gap-[var(--s3)]">
          <Link href="/coach/workout-templates" className="btn btn--ghost">Workout Templates</Link>
        </div>
      </header>

      <section className="mt-[var(--s6)]">
        <h2 className="t-command text-[length:var(--t-lg)]">Plans</h2>
        {loading && <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">Loading...</p>}
        {!loading && loadError && (
          <div className="mt-[var(--s3)] rounded-[var(--r-md)] border-2 border-[color:var(--brass-300)] bg-[rgba(0,0,0,.28)] p-[var(--s4)]">
            <p className="text-[length:var(--t-sm)] font-semibold text-[color:var(--bone-100)]">{loadError}</p>
            <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">
              This is a failure to load, not an empty list of class plans.
            </p>
          </div>
        )}
        {!loading && !loadError && tracks.length === 0 && (
          <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">No class plans are loaded in this environment yet.</p>
        )}
        <div className="mt-[var(--s4)] grid gap-[var(--s4)] md:grid-cols-2">
          {tracks.map((track) => (
            <article key={track.track_id} className="mat-leather--raised rounded-[var(--r-lg)] p-[var(--s4)]">
              <h3 className="t-command text-[length:var(--t-md)]">{track.name}</h3>
              <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">
                {track.duration_weeks !== null ? `${track.duration_weeks} weeks` : `${track.block_count} blocks`}
                {` · ${track.day_count} days · ${track.age_band}`}
              </p>
              <button
                type="button"
                className="btn btn--ghost mt-[var(--s3)]"
                onClick={() => void openTrack(track.track_id)}
                disabled={openTrackId === track.track_id && detail !== null}
              >
                {openTrackId === track.track_id ? 'Showing plan' : 'Open plan'}
              </button>
            </article>
          ))}
        </div>
      </section>

      {openTrackId !== null && (
        <section className="mat-leather mt-[var(--s6)] rounded-[var(--r-lg)] p-[var(--s5)]">
          <h2 className="t-command text-[length:var(--t-lg)]">{detail ? detail.name : 'Class plan'}</h2>
          {detailLoading && <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">Loading the plan...</p>}
          {!detailLoading && detailError && (
            <p role="alert" className="mt-[var(--s3)] rounded-[var(--r-md)] border-2 border-[color:var(--brass-300)] bg-[rgba(0,0,0,.28)] px-[var(--s3)] py-[var(--s3)] text-[length:var(--t-sm)] font-semibold text-[color:var(--bone-100)]">
              {detailError}
            </p>
          )}
          {!detailLoading && !detailError && detail && (
            <>
              {detail.weeks.length === 0 && (
                <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">This plan has no weeks yet.</p>
              )}
              <div className="mt-[var(--s4)] flex flex-col gap-[var(--s5)]">
                {detail.weeks.map((week) => (
                  <div key={`${week.block_order}-${week.week}`}>
                    <h3 className="t-command text-[length:var(--t-md)]">
                      {week.title ?? `Week ${week.week}`}
                    </h3>
                    {week.days.length === 0 && (
                      <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">No days listed.</p>
                    )}
                    <ol className="mt-[var(--s3)] grid gap-[var(--s3)] md:grid-cols-2 lg:grid-cols-5">
                      {week.days.map((day) => <Day key={day.block_session_id} day={day} />)}
                    </ol>
                  </div>
                ))}
              </div>

              {Object.keys(detail.details).length > 0 && (
                <div className="mt-[var(--s6)]">
                  <h3 className="t-command text-[length:var(--t-md)]">About this plan</h3>
                  <div className="mt-[var(--s3)] flex flex-col gap-[var(--s4)]">
                    {Object.entries(detail.details).map(([key, value]) => (
                      <div key={key}>
                        <p className="t-label">{label(key)}</p>
                        <DetailValue value={value} />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      )}
      </div>
    </main>
  );
}

export default function ClassPlansPage() {
  return (
    <RoleSessionGate allowedRoles={['coach', 'admin']}>
      <ClassPlans />
    </RoleSessionGate>
  );
}
