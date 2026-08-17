'use client';

import { useState } from 'react';

type FilmTimestamp = {
  id: string;
  stamp: string;
  focus: string;
};

const filmTimestamps: FilmTimestamp[] = [
  { id: 'ts-001', stamp: '00:42', focus: 'Defensive slip timing during rope pressure' },
  { id: 'ts-002', stamp: '01:58', focus: 'Counter window appears after jab feint' },
  { id: 'ts-003', stamp: '03:16', focus: 'Breathing reset missed before exchange restart' },
];

export default function MediaAndCommsHub() {
  const [publicFirstName, setPublicFirstName] = useState('');
  const [publicEmail, setPublicEmail] = useState('');
  const [publicInterest, setPublicInterest] = useState('After-school boxing and mentoring track');

  const [parentHandoutDraft, setParentHandoutDraft] = useState('## Parent Handout Draft\n- Weekly cadence\n- Safety protocol checkpoints\n- Contact pathways');
  const [flyerTemplateDraft, setFlyerTemplateDraft] = useState('## Flyer Template\nProgram launch date\nCall to action\nSponsor footer');
  const [grantNarrativeDraft, setGrantNarrativeDraft] = useState('## Grant Narrative Copy\nDescribe measurable community outcomes and retention targets.');

  const [annotationPanel, setAnnotationPanel] = useState('00:42 - Defensive slip timing breaks when lead foot drifts wide.');
  const [tacticalNotes, setTacticalNotes] = useState('Pressure rounds require tighter shoulder roll recovery after right-hand counters.');
  const [athleteReflection, setAthleteReflection] = useState('I felt stable in the first two rounds, but rushed exchanges after fatigue onset.');

  const [vaMilitaryRecords, setVaMilitaryRecords] = useState('');
  const [workoutsNewProgram, setWorkoutsNewProgram] = useState('');
  const [utilsDump, setUtilsDump] = useState('');

  return (
    <section className="mx-auto w-full max-w-7xl bg-black border border-zinc-800 rounded-none p-4">
      <header className="border-b border-zinc-800 pb-3">
        <h1 className="text-sm uppercase tracking-[0.2em] text-slate-200">Media, Film, and Communications Hub</h1>
        <p className="mt-2 text-xs text-zinc-500">Layers 16, 24, 30 and Directory Ingestors</p>
        <p className="mt-3"><span className="stamp stamp--brass stamp--flat">Planned — Not Yet Implemented</span></p>
        <p className="mt-2 text-xs text-zinc-400">
          Every contact, media item, and release status below is fabricated sample data. Nothing on
          this page reads or writes real records — do not act on anything it shows, and never treat
          an entry here as consent to publish a minor&apos;s image.
        </p>
      </header>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <section className="bg-black border border-zinc-800 rounded-none p-3">
          <h2 className="text-xs uppercase tracking-[0.2em] text-slate-200">[L16] Public Portal Mockup [V-BOARD-PUBLIC]</h2>
          <p className="mt-2 text-xs text-zinc-500">External non-sensitive marketing intake shell</p>
          <div className="mt-3 grid gap-2 text-xs">
            <label className="text-zinc-400" htmlFor="public-first-name">First Name</label>
            <input
              id="public-first-name"
              value={publicFirstName}
              onChange={(event) => setPublicFirstName(event.target.value)}
              className="border border-zinc-800 bg-black p-2 text-slate-200"
            />
            <label className="text-zinc-400" htmlFor="public-email">Email</label>
            <input
              id="public-email"
              value={publicEmail}
              onChange={(event) => setPublicEmail(event.target.value)}
              className="border border-zinc-800 bg-black p-2 text-slate-200"
            />
            <label className="text-zinc-400" htmlFor="public-interest">Program Interest</label>
            <textarea
              id="public-interest"
              value={publicInterest}
              onChange={(event) => setPublicInterest(event.target.value)}
              className="min-h-[92px] border border-zinc-800 bg-black p-2 text-slate-200"
            />
          </div>
        </section>

        <section className="bg-black border border-zinc-800 rounded-none p-3">
          <h2 className="text-xs uppercase tracking-[0.2em] text-slate-200">[L24] Creative / Communications [V-STAFF]</h2>
          <div className="mt-3 grid gap-3 text-xs">
            <div>
              <label className="text-zinc-400" htmlFor="parent-handout">Parent Handouts (Markdown Draft)</label>
              <textarea
                id="parent-handout"
                value={parentHandoutDraft}
                onChange={(event) => setParentHandoutDraft(event.target.value)}
                className="mt-1 min-h-[96px] w-full border border-zinc-800 bg-black p-2 text-slate-200"
              />
            </div>
            <div>
              <label className="text-zinc-400" htmlFor="flyer-template">Flyer Templates (Markdown Draft)</label>
              <textarea
                id="flyer-template"
                value={flyerTemplateDraft}
                onChange={(event) => setFlyerTemplateDraft(event.target.value)}
                className="mt-1 min-h-[96px] w-full border border-zinc-800 bg-black p-2 text-slate-200"
              />
            </div>
            <div>
              <label className="text-zinc-400" htmlFor="grant-narrative">Grant Narrative Copy (Markdown Draft)</label>
              <textarea
                id="grant-narrative"
                value={grantNarrativeDraft}
                onChange={(event) => setGrantNarrativeDraft(event.target.value)}
                className="mt-1 min-h-[96px] w-full border border-zinc-800 bg-black p-2 text-slate-200"
              />
            </div>
          </div>
        </section>

        <section className="bg-black border border-zinc-800 rounded-none p-3 xl:col-span-2">
          <h2 className="text-xs uppercase tracking-[0.2em] text-slate-200">[L30] Film Study System [V-STAFF]</h2>
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <div className="border border-zinc-800 bg-black p-3">
              <p className="text-xs text-zinc-500">Mock Video Player</p>
              <div className="mt-2 h-48 border border-zinc-800 bg-black" />
            </div>

            <div className="border border-zinc-800 bg-black p-3">
              <p className="text-xs text-zinc-400">Timestamp Annotation Panel</p>
              <ul className="mt-2 space-y-2 text-xs">
                {filmTimestamps.map((entry) => (
                  <li key={entry.id} className="border border-zinc-800 bg-black p-2">
                    <p className="text-slate-200">{entry.stamp}</p>
                    <p className="text-zinc-500">{entry.focus}</p>
                  </li>
                ))}
              </ul>
              <textarea
                value={annotationPanel}
                onChange={(event) => setAnnotationPanel(event.target.value)}
                className="mt-2 min-h-[84px] w-full border border-zinc-800 bg-black p-2 text-xs text-slate-200"
              />
            </div>

            <div className="border border-zinc-800 bg-black p-3">
              <p className="text-xs text-zinc-400">Tactical Observation Notes</p>
              <textarea
                value={tacticalNotes}
                onChange={(event) => setTacticalNotes(event.target.value)}
                className="mt-2 min-h-[120px] w-full border border-zinc-800 bg-black p-2 text-xs text-slate-200"
              />
            </div>

            <div className="border border-zinc-800 bg-black p-3">
              <p className="text-xs text-zinc-400">Athlete Reflection Block</p>
              <textarea
                value={athleteReflection}
                onChange={(event) => setAthleteReflection(event.target.value)}
                className="mt-2 min-h-[120px] w-full border border-zinc-800 bg-black p-2 text-xs text-slate-200"
              />
            </div>
          </div>
        </section>

        <section className="bg-black border border-zinc-800 rounded-none p-3 xl:col-span-2">
          <h2 className="text-xs uppercase tracking-[0.2em] text-slate-200">Directory Ingestors [V-STAFF]</h2>
          <div className="mt-3 grid gap-3 lg:grid-cols-3 text-xs">
            <div className="border border-zinc-800 bg-black p-2">
              <label htmlFor="va-military-records" className="text-zinc-400">📂 Va90to100 / VAMilitary Records</label>
              <p className="mt-1 text-[11px] text-zinc-500">Activates adaptive kinetic limiters</p>
              <textarea
                id="va-military-records"
                value={vaMilitaryRecords}
                onChange={(event) => setVaMilitaryRecords(event.target.value)}
                className="mt-2 min-h-[120px] w-full border border-zinc-800 bg-black p-2 text-slate-200"
              />
            </div>

            <div className="border border-zinc-800 bg-black p-2">
              <label htmlFor="workouts-new-program" className="text-zinc-400">📂 Wokouts new program</label>
              <p className="mt-1 text-[11px] text-zinc-500">Raw programming block pasting</p>
              <textarea
                id="workouts-new-program"
                value={workoutsNewProgram}
                onChange={(event) => setWorkoutsNewProgram(event.target.value)}
                className="mt-2 min-h-[120px] w-full border border-zinc-800 bg-black p-2 text-slate-200"
              />
            </div>

            <div className="border border-zinc-800 bg-black p-2">
              <label htmlFor="utils-dump" className="text-zinc-400">📂 utils</label>
              <p className="mt-1 text-[11px] text-zinc-500">System utility diagnostics dump</p>
              <textarea
                id="utils-dump"
                value={utilsDump}
                onChange={(event) => setUtilsDump(event.target.value)}
                className="mt-2 min-h-[120px] w-full border border-zinc-800 bg-black p-2 text-slate-200"
              />
            </div>
          </div>
        </section>
      </div>
    </section>
  );
}
