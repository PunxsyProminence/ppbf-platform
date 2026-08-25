import Link from 'next/link';
import DevelopmentPipelineBanner from '@/components/DevelopmentPipelineBanner';
import ShadowChatButton from '@/components/ShadowChatButton';

/* This page used to print seven hard-coded physiological predictions --
   "Short-term adaptation spike with increased fatigue checkpoints.", "Higher
   cardio gains with temporary technical plateau risk." -- as statements of
   fact, with no athlete, no source, and no computation behind any of them.
   Each carried an invented risk grade on the SAFETY ladder: badge--cleared,
   badge--restricted, and badge--locked (#A81E22), the same red the clinic
   uses for a real medical hold. It performs no fetch, no read, and no
   calculation; nothing on it was ever measured.

   What survives is the only thing here that was ever true: the list of
   question types this pipeline stage is intended to answer. Nothing states a
   current state, a proposed change, an expected outcome, or a risk grade,
   because the platform holds none of those and inventing them on a page a
   coach might read is the defect, not the styling.

   The scope list is deliberately titles only. Prose about a "readiness trend"
   or a "non-contact progression lane" is a claim about a real athlete however
   softly it is worded, and this page cannot support one. */
const scenarioScope = [
  'Athlete Readiness',
  'Training Load',
  'Recovery Changes',
  'Track Changes',
  'Capability Changes',
  'Workflow Changes',
  'Program Changes',
];

/* Every plaque states something this file can actually support: its place in
   the banner's stage order, and the fact that it reads and stores nothing.
   'Safe Validation' and 'Front-end Only' were a mode and an engine that do
   not exist. */
const stats = [
  { label: 'Current Stage', value: 'Scenario Simulator' },
  { label: 'Next Stage', value: 'Audit Trace' },
  { label: 'Data Read', value: 'None' },
  { label: 'Scenarios Stored', value: 'None' },
];

export default function ScenarioSimulatorPage() {
  return (
    <main className="room room--file min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
      <header className="mat-leather--raised border-b border-[color:rgb(var(--brass-400-rgb)_/_.22)] px-[var(--s5)] py-[var(--s5)]">
        <div className="mx-auto flex w-full max-w-[1200px] flex-wrap items-end justify-between gap-[var(--s4)]">
          <div>
            <p className="t-eyebrow">Scenario Simulator</p>
            <h1 className="t-command mt-[var(--s2)]" style={{ fontSize: 'var(--t-xl)' }}>
              Validation Sandbox
            </h1>
            <p className="t-body mt-[var(--s3)] max-w-[64ch]">
              Stage four of the knowledge pipeline. No scenario engine has been built, so this page evaluates nothing
              and holds no result.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-[var(--s3)]">
            <ShadowChatButton context="Scenario Simulator" />
            <Link href="/audit" className="btn btn--ghost">
              Audit Trace
            </Link>
            <Link href="/knowledge-graph" className="btn btn--ghost">
              Knowledge Graph
            </Link>
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-[1200px] space-y-[var(--s5)] p-[var(--s5)]">
        <DevelopmentPipelineBanner currentStage="simulator" />

        <section aria-label="Simulator status" className="flex flex-wrap gap-[var(--s3)]">
          {stats.map((item) => (
            <span key={item.label} className="plaque">
              {item.label.toUpperCase()}: {item.value.toUpperCase()}
            </span>
          ))}
        </section>

        {/* The room's own empty-archive pattern, the same one /audit uses for
            a ledger with nothing in it: a torn note on paper, stating the
            absence rather than filling the space with something invented. */}
        <section className="mat-paper note-torn rounded-[var(--r-sm)] p-[var(--s5)]">
          <p className="font-mono text-[length:var(--t-xs)] font-bold uppercase tracking-[0.13em] text-[color:var(--hide-600)]">
            Empty State
          </p>
          <p className="t-typed mt-[var(--s2)] text-[length:var(--t-sm)] leading-relaxed">
            No scenario has been run or recorded for your organization, and none can be: this page reads no record,
            runs no model, and writes nothing. Any figure or outcome shown here would have been written by hand into
            the page itself.
          </p>
        </section>

        <section className="mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s5)]">
          <div className="flex flex-wrap items-center justify-between gap-[var(--s3)]">
            <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>
              Intended Scope
            </h2>
            {/* Law 7: what this stage cannot do is pressed in ink once, not
                narrated card by card. */}
            <span className="stamp stamp--flat">Not Built</span>
          </div>
          <p className="t-body mt-[var(--s3)] max-w-[64ch]">
            The question types this stage is meant to answer once something evaluates them. Each is a heading with
            nothing behind it — no input, no method, and no result.
          </p>
          <ul className="mt-[var(--s4)] grid gap-[var(--s3)] sm:grid-cols-2 lg:grid-cols-3">
            {scenarioScope.map((title) => (
              <li key={title} className="relative mat-paper rounded-[var(--r-sm)] px-[var(--s4)] py-[var(--s5)]">
                <span className="pin pin--brass" aria-hidden="true" />
                <p className="t-typed text-[length:var(--t-sm)] font-bold">{title}</p>
                {/* badge--filed is the sheet's administrative rung. The four
                    saturated rungs above it are reserved for a safety state or
                    a queue outcome, and this is neither. */}
                <span className="badge badge--filed mt-[var(--s3)]">
                  <i aria-hidden="true">◌</i>
                  Not Evaluated
                </span>
              </li>
            ))}
          </ul>
        </section>

        <div className="mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s5)]">
          <p className="t-eyebrow">Flow Direction</p>
          <p className="t-body mt-[var(--s3)]">
            In the pipeline order, Audit Trace follows this stage. Nothing is validated here and nothing is handed on:
            the two pages are neighbours in the banner above, not a flow.
          </p>
        </div>
      </div>
    </main>
  );
}
