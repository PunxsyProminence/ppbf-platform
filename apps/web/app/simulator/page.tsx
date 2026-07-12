import FeatureSurface from '@/components/FeatureSurface';

export default function ScenarioSimulatorPage() {
  return (
    <FeatureSurface
      eyebrow="Scenario Simulator"
      title="What-if planning for readiness, recovery, and progression"
      description="A local sandbox for testing training changes before they are promoted into governed workflows."
      status="ready"
      primaryLinks={[
        { label: 'Audit trace', href: '/audit' },
        { label: 'Athlete dashboard', href: '/athlete/dashboard' },
      ]}
      stats={[
        { label: 'Mode', value: 'Sandbox' },
        { label: 'Inputs', value: 'Editable' },
        { label: 'Risk', value: 'Low' },
        { label: 'Output', value: 'Projection' },
      ]}
    >
      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
          <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-fuchsia-300">Readiness model</p>
          <p className="mt-2 text-sm leading-6 text-slate-300">Preview how changes affect workload and recovery before committing to the next session.</p>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
          <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-fuchsia-300">Recovery scenario</p>
          <p className="mt-2 text-sm leading-6 text-slate-300">Test whether a deload, rest day, or constraint shift keeps the athlete moving safely.</p>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
          <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-fuchsia-300">Promotion gate</p>
          <p className="mt-2 text-sm leading-6 text-slate-300">Promote only the scenario that meets the governance bar and training objective.</p>
        </div>
      </div>
    </FeatureSurface>
  );
}