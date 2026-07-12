import FeatureSurface from '@/components/FeatureSurface';

export default function AuditTracePage() {
  return (
    <FeatureSurface
      eyebrow="Audit & Change Trace"
      title="Versioned changes, overrides, and approval history"
      description="A governance lane for reviewing what changed, who changed it, and why the platform accepted the change."
      status="ready"
      primaryLinks={[
        { label: 'Source control', href: '/source-control' },
        { label: 'Simulator', href: '/simulator' },
      ]}
      stats={[
        { label: 'Events', value: 'Tracked' },
        { label: 'Trace', value: 'Immutable' },
        { label: 'Mode', value: 'Review' },
        { label: 'Status', value: 'Logged' },
      ]}
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="border-2 border-[#8b0000] bg-[#1a1a1a]/60 p-4">
          <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-[#c85a17]">Change log</p>
          <p className="mt-2 text-sm leading-6 text-[#e5e5e5]">Surface for reviewing configuration diffs, manual overrides, and state transitions.</p>
        </div>
        <div className="border-2 border-[#8b0000] bg-[#1a1a1a]/60 p-4">
          <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-[#c85a17]">Reason registry</p>
          <p className="mt-2 text-sm leading-6 text-[#e5e5e5]">Pairs each override with a reason field so governance can audit decisions later.</p>
        </div>
      </div>
    </FeatureSurface>
  );
}