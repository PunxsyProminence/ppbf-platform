import FeatureSurface from '@/components/FeatureSurface';

export default function EvidenceReviewPage() {
  return (
    <FeatureSurface
      eyebrow="Evidence Review"
      title="Verification lane for clips, notes, and progress artifacts"
      description="A review surface for confirming that training evidence matches the athlete progression story."
      status="ready"
      primaryLinks={[
        { label: 'Research intake', href: '/research' },
        { label: 'Knowledge graph', href: '/knowledge-graph' },
      ]}
      stats={[
        { label: 'Checks', value: 'Match' },
        { label: 'Risk', value: 'Drift' },
        { label: 'Focus', value: 'Review' },
        { label: 'Mode', value: 'Controlled' },
      ]}
    >
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
          <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-amber-300">Clip checks</p>
          <p className="mt-2 text-sm leading-6 text-slate-300">Compare recorded material against the current training objective and progression level.</p>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
          <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-amber-300">Drift detection</p>
          <p className="mt-2 text-sm leading-6 text-slate-300">Keep the evidence lane strict so duplicates or mismatched claims are easy to flag.</p>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
          <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-amber-300">Approval path</p>
          <p className="mt-2 text-sm leading-6 text-slate-300">Provide a clean handoff into the governed source-of-truth flow when review is complete.</p>
        </div>
      </div>
    </FeatureSurface>
  );
}