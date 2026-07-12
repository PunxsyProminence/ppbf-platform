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
        <div className="border-2 border-[#8b0000] bg-[#1a1a1a]/60 p-4">
          <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-[#c85a17]">Readiness model</p>
          <p className="mt-2 text-sm leading-6 text-[#e5e5e5]">Preview how changes affect workload and recovery before committing to the next session.</p>
        </div>
        <div className="border-2 border-[#8b0000] bg-[#1a1a1a]/60 p-4">
          <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-[#c85a17]">Recovery scenario</p>
          <p className="mt-2 text-sm leading-6 text-[#e5e5e5]">Test whether a deload, rest day, or constraint shift keeps the athlete moving safely.</p>
        </div>
        <div className="border-2 border-[#8b0000] bg-[#1a1a1a]/60 p-4">
          <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-[#c85a17]">Promotion gate</p>
          <p className="mt-2 text-sm leading-6 text-[#e5e5e5]">Promote only the scenario that meets the governance bar and training objective.</p>
        </div>
      </div>
    </FeatureSurface>
  );
}