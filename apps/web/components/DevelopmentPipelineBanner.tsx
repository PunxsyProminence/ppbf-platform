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

/* This banner is a map of the pipeline and a marker for where you are standing
   in it. It used to be more than that, and everything extra was invented:
   'Completed' was derived purely from the route rendering the banner, so
   opening /audit asserted that RESEARCH INTAKE, EVIDENCE REVIEW and KNOWLEDGE
   GRAPH were finished without anything checking whether a single source had
   been approved, and the last stage fell back to 'Ecosystem Release Complete'.
   Position in a list is not progress, so the banner no longer claims any.

   The earlier/later styling went with it for the same reason: a stage behind
   you drawn as done is the same false claim made in colour. Every stage but
   the current one is now drawn identically, because that is all this component
   can honestly distinguish.

   The two dead classes are also gone. `text-[var(--bone-200)]` and
   `text-[var(--locked-ink)]` emit nothing at all -- Tailwind v4 cannot
   disambiguate `text-[var(--x)]` between a length and a colour, which
   RoleStandaloneView.tsx:45-47 documents -- so the current-stage label fell
   back to inherited ink at roughly 1.3:1 and was invisible on every file-room
   page. `text-[color:...]` is the form that lands. */
export default function DevelopmentPipelineBanner({ currentStage }: DevelopmentPipelineBannerProps) {
  const currentIndex = pipelineStages.findIndex((stage) => stage.key === currentStage);
  const nextStage = currentIndex >= 0 && currentIndex < pipelineStages.length - 1 ? pipelineStages[currentIndex + 1] : null;
  const current = currentIndex >= 0 ? pipelineStages[currentIndex] : null;

  return (
    <section
      aria-label="Knowledge development pipeline"
      className="mat-leather rounded-[var(--r-md)] border-2 border-[color:var(--brass-700)] p-[var(--s5)]"
    >
      <p className="t-eyebrow">PPBF Knowledge Development Pipeline</p>

      <ol className="mt-[var(--s4)] flex flex-wrap items-center gap-[var(--s2)]">
        {pipelineStages.map((stage, index) => {
          const isCurrent = stage.key === currentStage;

          return (
            <li key={stage.key} className="flex items-center gap-[var(--s2)]">
              <Link
                href={stage.href}
                aria-current={isCurrent ? 'page' : undefined}
                className={`inline-flex min-h-[var(--tap)] items-center rounded-[var(--r-sm)] border px-[var(--s4)] py-[var(--s3)] font-mono text-[length:var(--t-xs)] uppercase tracking-[0.09em] transition ${
                  isCurrent
                    ? 'mat-leather--raised border-[color:var(--brass-300)] text-[color:var(--bone-100)]'
                    : 'border-[color:rgb(var(--brass-400-rgb)_/_.28)] text-[color:var(--bone-300)] hover:border-[color:var(--brass-400)]'
                }`}
              >
                {stage.label}
              </Link>
              {/* The file room's motion is a queue read left to right, so the
                  separator points the way the row actually runs. */}
              {index < pipelineStages.length - 1 && (
                <span aria-hidden="true" className="font-mono text-[color:var(--brass-300)]">→</span>
              )}
            </li>
          );
        })}
      </ol>

      <div className="mt-[var(--s4)] grid gap-[var(--s2)] font-mono text-[length:var(--t-xs)] text-[color:var(--bone-300)] md:grid-cols-2">
        <p>
          Stage {currentIndex >= 0 ? currentIndex + 1 : '--'} of {pipelineStages.length}: {current?.label ?? 'Not a pipeline stage'}
        </p>
        <p>Next: {nextStage?.label ?? 'Publish is the last stage'}</p>
      </div>

      <p className="t-muted mt-[var(--s3)] max-w-[64ch]">
        This is the order of the stages, not their progress. Nothing here reads whether a source was approved, so no
        stage is marked complete.
      </p>
    </section>
  );
}
