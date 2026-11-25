'use client';

import { useEffect, useMemo, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import type { DrillLibraryResponse, PilotDrill } from '@/src/server/pilot/drills';

// Choosing a drill from the gym's library to add to a session plan (SP-2a).
//
// Reads GET /api/pilot/drills, which answers the gym's CURRENT drills (retired
// ones only when include_retired is asked for, and it is not). A search box over
// the names is the whole filter. Three states are said in words and never shown
// as a list that looks complete: loading, could not be loaded, and loaded.

export type PickableDrill = Pick<PilotDrill, 'drill_id' | 'name'>;

type Load = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; drills: PickableDrill[] };

export default function BlockDrillPicker({
  onPick,
  onClose,
}: {
  readonly onPick: (drill: PickableDrill) => void;
  readonly onClose: () => void;
}) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [search, setSearch] = useState('');

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/drills`, { credentials: 'include' });
        const body = (await response.json().catch(() => null)) as Partial<DrillLibraryResponse> | null;
        if (!current) return;
        if (!response.ok || !body || !Array.isArray(body.items)) {
          setLoad({ state: 'failed' });
          return;
        }
        setLoad({ state: 'ready', drills: body.items.map(({ drill_id, name }) => ({ drill_id, name })) });
      } catch {
        if (current) setLoad({ state: 'failed' });
      }
    })();
    return () => {
      current = false;
    };
  }, [attempt]);

  const shown = useMemo(() => {
    if (load.state !== 'ready') return [];
    const wanted = search.trim().toLowerCase();
    return wanted ? load.drills.filter((drill) => drill.name.toLowerCase().includes(wanted)) : load.drills;
  }, [load, search]);

  const button = 'btn min-h-[var(--tap)] text-[length:var(--t-md)]';

  return (
    <section
      aria-label="Add a drill from the library"
      className="flex flex-col gap-[var(--s3)] rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] bg-[rgba(0,0,0,.28)] p-[var(--s4)]"
    >
      {load.state === 'loading' && <p role="status" className="text-[length:var(--t-md)]">Loading the drill library…</p>}
      {load.state === 'failed' && (
        <div className="flex flex-wrap items-center gap-[var(--s3)]">
          <p role="alert" className="text-[length:var(--t-md)] font-semibold">
            The drill library could not be loaded, so no drills are shown. Try again.
          </p>
          <button type="button" className={button} onClick={() => {
              setLoad({ state: 'loading' });
              setAttempt((count) => count + 1);
            }}>
            Try again
          </button>
        </div>
      )}
      {load.state === 'ready' && (
        <>
          <label className="field">
            <span className="t-label">Search drills by name</span>
            <input
              type="search"
              className="input input--kiosk min-h-[var(--tap)] text-[length:var(--t-md)]"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          {load.drills.length === 0 ? (
            <p className="text-[length:var(--t-md)]">The gym has no drills in its library yet.</p>
          ) : shown.length === 0 ? (
            <p className="text-[length:var(--t-md)]">No drill name matches that search.</p>
          ) : (
            <ul aria-label="Drills in the library" className="flex max-h-[24rem] flex-col gap-[var(--s2)] overflow-y-auto">
              {shown.map((drill) => (
                <li key={drill.drill_id}>
                  <button
                    type="button"
                    className={`${button} btn--ghost w-full justify-start text-left`}
                    onClick={() => onPick(drill)}
                  >
                    {drill.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <div>
        <button type="button" className={`${button} btn--ghost`} onClick={onClose}>
          Close the drill library
        </button>
      </div>
    </section>
  );
}
