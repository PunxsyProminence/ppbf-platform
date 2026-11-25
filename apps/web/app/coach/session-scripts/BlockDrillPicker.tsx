'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import type { DrillLibraryRow } from '@/src/server/pilot/drillLibraryV3';

// Choosing a drill from the gym's library to add to a session plan (SP-2a).
//
// Reads GET /api/pilot/drill-library: pilot.drill_library, the table a plan
// block's drill_id names and the server's lockDrills resolves. For a coach or an
// organization admin it answers the gym's CURRENT versions (active, not
// superseded) as `drills`. NOT /api/pilot/drills: that is pilot.drills, the
// operational drills, whose ids are their own (promotion makes a new one), so a
// pick from it was refused as not this gym's drill (Codex P1 on #2199). A search
// box over the names is the whole filter. Three states are said in words and
// never shown as a list that looks complete: loading, could not be loaded, and
// loaded.
//
// Opened, it takes keyboard focus on its heading, as the plan page's own detail
// heading does, because the button that opened it is gone (Codex on #2199). The
// search never saves the plan around it, and while the plan saves no drill can be
// picked, because a pick made then would be lost (Codex on #2199).

export type PickableDrill = Pick<DrillLibraryRow, 'drill_id' | 'name'>;

type Load = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; drills: PickableDrill[] };

export default function BlockDrillPicker({
  onPick,
  onClose,
  disabled,
}: {
  readonly onPick: (drill: PickableDrill) => void;
  readonly onClose: () => void;
  /** True while the plan is being saved. */
  readonly disabled: boolean;
}) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [search, setSearch] = useState('');
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/drill-library`, { credentials: 'include' });
        const body = (await response.json().catch(() => null)) as { drills?: PickableDrill[] } | null;
        if (!current) return;
        if (!response.ok || !body || !Array.isArray(body.drills)) {
          setLoad({ state: 'failed' });
          return;
        }
        setLoad({ state: 'ready', drills: body.drills.map(({ drill_id, name }) => ({ drill_id, name })) });
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

  const button = 'btn min-h-[var(--tap)] text-[length:var(--t-md)] disabled:cursor-not-allowed disabled:opacity-60';

  return (
    <section
      aria-labelledby="block-drill-picker-heading"
      className="flex flex-col gap-[var(--s3)] rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] bg-[rgba(0,0,0,.28)] p-[var(--s4)]"
    >
      <h3 id="block-drill-picker-heading" ref={headingRef} tabIndex={-1} className="t-command text-[length:var(--t-md)]">
        Add a drill from the library
      </h3>
      {load.state === 'loading' && <p role="status" className="text-[length:var(--t-md)]">Loading the drill library…</p>}
      {load.state === 'failed' && (
        <div className="flex flex-wrap items-center gap-[var(--s3)]">
          <p role="alert" className="text-[length:var(--t-md)] font-semibold">
            The drill library could not be loaded, so no drills are shown. Try again.
          </p>
          <button type="button" className={button} onClick={() => {
              // This button leaves the page with the failure; the heading keeps the focus.
              headingRef.current?.focus();
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
              // Enter in a field of the plan's form would save the plan; here it only searches.
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.preventDefault();
              }}
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
                    disabled={disabled}
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
