import FeatureSurface from '@/components/FeatureSurface';

export default function ResearchIntakePage() {
  return (
    <FeatureSurface
      eyebrow="Research Intake"
      title="Evidence capture and learning notes"
      description="A disciplined front end for research ideas, field notes, and evidence review inputs."
      status="ready"
      primaryLinks={[
        { label: 'Evidence review', href: '/evidence' },
        { label: 'Audit surface', href: '/audit' },
      ]}
      stats={[
        { label: 'Mode', value: 'Write' },
        { label: 'Scope', value: 'Evidence' },
        { label: 'Review', value: 'Coach-led' },
        { label: 'Status', value: 'Draft' },
      ]}
    >
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
          <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-violet-300">Intake fields</p>
          <p className="mt-2 text-sm leading-6 text-slate-300">Use this page for note capture, citations, and project context before anything becomes governed content.</p>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
          <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-violet-300">Evidence flow</p>
          <p className="mt-2 text-sm leading-6 text-slate-300">Pairs with the evidence review lane so the platform can separate ideas from approved instruction.</p>
        </div>
      </div>
    </FeatureSurface>
  );
}