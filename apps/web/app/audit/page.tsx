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
        <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
          <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-sky-300">Change log</p>
          <p className="mt-2 text-sm leading-6 text-slate-300">Surface for reviewing configuration diffs, manual overrides, and state transitions.</p>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
          <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-sky-300">Reason registry</p>
          <p className="mt-2 text-sm leading-6 text-slate-300">Pairs each override with a reason field so governance can audit decisions later.</p>
        </div>
      </div>
    </FeatureSurface>
  );
}