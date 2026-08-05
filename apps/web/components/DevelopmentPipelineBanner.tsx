import Link from 'next/link';

export type PipelineStageKey = 'research' | 'evidence' | 'knowledge' | 'simulator' | 'audit' | 'source-control' | 'publish';

interface PipelineStage {
  key: PipelineStageKey;
  label: string;
  href: string;
}

const pipelineStages: PipelineStage[] = [
  { key: 'research', label: 'RESEARCH INTAKE', href: '/research' },
  { key: 'evidence', label: 'EVIDENCE REVIEW', href: '/evidence' },
  { key: 'knowledge', label: 'KNOWLEDGE GRAPH', href: '/knowledge-graph' },
  { key: 'simulator', label: 'SCENARIO SIMULATOR', href: '/simulator' },
  { key: 'audit', label: 'AUDIT TRACE', href: '/audit' },
  { key: 'source-control', label: 'SOURCE CONTROL', href: '/source-control' },
  { key: 'publish', label: 'PUBLISH', href: '/source-control#publish' },
];

interface DevelopmentPipelineBannerProps {
  currentStage: PipelineStageKey;
}

export default function DevelopmentPipelineBanner({ currentStage }: DevelopmentPipelineBannerProps) {
  const currentIndex = pipelineStages.findIndex((stage) => stage.key === currentStage);
  const nextStage = currentIndex >= 0 && currentIndex < pipelineStages.length - 1 ? pipelineStages[currentIndex + 1] : null;

  return (
    <section className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-4">
      <p className="text-[11px] font-mono uppercase tracking-[0.22em] text-[var(--red-primary)]">PPBF Knowledge Development Pipeline</p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {pipelineStages.map((stage, index) => {
          const isCurrent = stage.key === currentStage;
          const isComplete = index < currentIndex;
          const isUpcoming = index > currentIndex;

          return (
            <div key={stage.key} className="flex items-center gap-2">
              <Link
                href={stage.href}
                className={`inline-flex min-h-[44px] items-center border px-3 py-2 text-[11px] font-mono uppercase tracking-[0.09em] transition ${
                  isCurrent
                    ? 'border-[var(--red-primary)] bg-[var(--red-primary)] text-[var(--white)]'
                    : isComplete
                      ? 'border-[var(--black)] bg-[var(--canvas-tan-dark)] text-[var(--black)]'
                      : isUpcoming
                        ? 'border-[var(--black)] bg-[var(--canvas-tan-light)] text-[var(--gray-dark)]'
                        : 'border-[var(--black)] bg-[var(--canvas-tan-light)] text-[var(--gray-dark)]'
                }`}
              >
                {stage.label}
              </Link>
              {index < pipelineStages.length - 1 && <span className="font-mono text-[var(--red-primary)]">↓</span>}
            </div>
          );
        })}
      </div>

      <div className="mt-3 grid gap-2 text-[12px] font-mono text-[var(--gray-dark)] md:grid-cols-3">
        <p>Completed: {currentIndex > 0 ? pipelineStages.slice(0, currentIndex).map((stage) => stage.label).join(' / ') : 'None yet'}</p>
        <p>Current: {pipelineStages[currentIndex]?.label ?? 'Unknown'}</p>
        <p>Next: {nextStage?.label ?? 'Ecosystem Release Complete'}</p>
      </div>
    </section>
  );
}
