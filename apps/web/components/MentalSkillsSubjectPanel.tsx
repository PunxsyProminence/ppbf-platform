'use client';

import { useEffect, useRef, useState } from 'react';

import MentalSkillsView, {
  type LoadState,
  type MentalGoal,
  type MentalSkillsData,
} from '@/components/MentalSkillsView';
import { apiBase } from '@/lib/apiBase';

/*
 * Pick one athlete, then read their mental skills: the guardian page (linked
 * children) and the coach page (the coach's own and covered athletes) differ
 * only in where the list and the reads come from, so the picking and the
 * stale-answer guard live here once.
 *
 * READ ONLY. Nothing here writes; an athlete's entries are theirs alone.
 *
 * A slow read for the athlete just navigated away from must never land under
 * the one navigated to: the view carries no name, so nothing on screen would
 * disagree. subjectRef is checked before every state write.
 */

interface Person {
  athlete_id: string;
  full_name?: string;
}

export interface SubjectLoaders {
  /** Name and id of each athlete this viewer may pick. */
  rosterPath: string;
  entries: (athleteId: string) => Promise<MentalSkillsData>;
  goals: (athleteId: string) => Promise<MentalGoal[]>;
}

export async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBase()}${path}`, { method: 'GET', credentials: 'include' });
  if (!response.ok) throw new Error(path);
  return (await response.json()) as T;
}

export function entriesFrom(payload: Partial<MentalSkillsData>): MentalSkillsData {
  if (!Array.isArray(payload.imagery_sessions)) throw new Error('shape');
  return { current_cue: payload.current_cue ?? null, imagery_sessions: payload.imagery_sessions };
}

export default function MentalSkillsSubjectPanel({
  loaders,
  pickerLabel,
  noneText,
  rosterErrorText,
}: {
  readonly loaders: SubjectLoaders;
  readonly pickerLabel: string;
  readonly noneText: string;
  readonly rosterErrorText: string;
}) {
  const [people, setPeople] = useState<Person[]>([]);
  const [rosterState, setRosterState] = useState<LoadState>('loading');
  const [activeId, setActiveId] = useState('');
  const [data, setData] = useState<MentalSkillsData | null>(null);
  const [state, setState] = useState<LoadState>('loading');
  const [goals, setGoals] = useState<MentalGoal[]>([]);
  const [goalsState, setGoalsState] = useState<LoadState>('loading');
  const subjectRef = useRef('');

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const payload = await getJson<{ items?: Person[] }>(loaders.rosterPath);
        if (!live) return;
        setPeople(payload.items ?? []);
        setRosterState('loaded');
      } catch {
        if (!live) return;
        setPeople([]);
        setRosterState('unavailable');
      }
    })();
    return () => { live = false; };
  }, [loaders.rosterPath]);

  function select(nextId: string) {
    subjectRef.current = nextId;
    setActiveId(nextId);
    if (!nextId) return;
    setState('loading');
    setGoalsState('loading');
    void loaders.entries(nextId).then(
      (fresh) => { if (subjectRef.current === nextId) { setData(fresh); setState('loaded'); } },
      () => { if (subjectRef.current === nextId) { setData(null); setState('unavailable'); } },
    );
    void loaders.goals(nextId).then(
      (fresh) => { if (subjectRef.current === nextId) { setGoals(fresh); setGoalsState('loaded'); } },
      () => { if (subjectRef.current === nextId) { setGoals([]); setGoalsState('unavailable'); } },
    );
  }

  // Two athletes can share a name (siblings do); an id tail tells them apart.
  const nameCounts = new Map<string, number>();
  for (const person of people) {
    if (person.full_name) nameCounts.set(person.full_name, (nameCounts.get(person.full_name) ?? 0) + 1);
  }
  const labelFor = (person: Person) => {
    if (!person.full_name) return person.athlete_id;
    return (nameCounts.get(person.full_name) ?? 0) > 1
      ? `${person.full_name} (${person.athlete_id.slice(-4)})`
      : person.full_name;
  };
  const activePerson = people.find((person) => person.athlete_id === activeId);
  const activeName = activePerson ? labelFor(activePerson) : undefined;

  return (
    <div className="space-y-[var(--s5)]">
      <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)]">
        <div className="field">
          <label htmlFor="mentalSkillsSubject" className="t-label">{pickerLabel}</label>
          <select
            id="mentalSkillsSubject"
            value={activeId}
            onChange={(event) => select(event.target.value)}
            disabled={rosterState !== 'loaded' || people.length === 0}
            className="select"
          >
            <option value="">{rosterState === 'loading' ? 'Loading...' : 'Choose'}</option>
            {people.map((person) => (
              <option key={person.athlete_id} value={person.athlete_id}>
                {labelFor(person)}
              </option>
            ))}
          </select>
        </div>
        {rosterState === 'unavailable' && <p className="t-body" role="alert">{rosterErrorText}</p>}
        {rosterState === 'loaded' && people.length === 0 && <p className="t-body">{noneText}</p>}
      </section>

      {activeId && (
        <section
          className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]"
          aria-label={activeName ? `Mental skills for ${activeName}` : 'Mental skills'}
        >
          <MentalSkillsView
            state={state}
            data={data}
            goals={goals}
            goalsState={goalsState}
            subjectLabel={activeName ? `${activeName}'s` : 'their'}
          />
        </section>
      )}
    </div>
  );
}
