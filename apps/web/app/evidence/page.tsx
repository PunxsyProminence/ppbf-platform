import FeatureSurface from '@/components/FeatureSurface';

const reviewGroups: Array<{
  title: 'Needs Review' | 'Accepted' | 'Rejected' | 'Needs More Evidence' | 'Coach Validation Required';
  items: Array<{
    title: string;
    submittedDate: string;
    origin: string;
    reviewStatus: string;
    notes: string;
  }>;
}> = [
  {
    title: 'Needs Review',
    items: [
      {
        title: 'Footwork cadence checkpoint clip set',
        submittedDate: '2026-07-11',
        origin: 'Research Intake',
        reviewStatus: 'Pending evidence alignment',
        notes: 'Awaiting reviewer notes for movement consistency.',
      },
    ],
  },
  {
    title: 'Accepted',
    items: [
      {
        title: 'Shoulder load progression summary',
        submittedDate: '2026-07-10',
        origin: 'Coach Upload',
        reviewStatus: 'Accepted for Knowledge Graph',
        notes: 'Validated against training week objective.',
      },
    ],
  },
  {
    title: 'Rejected',
    items: [
      {
        title: 'Unscoped external sparring notes',
        submittedDate: '2026-07-09',
        origin: 'Manual Intake',
        reviewStatus: 'Rejected',
        notes: 'No source attribution and no baseline context.',
      },
    ],
  },
  {
    title: 'Needs More Evidence',
    items: [
      {
        title: 'Recovery variance trend hypothesis',
        submittedDate: '2026-07-08',
        origin: 'Research Intake',
        reviewStatus: 'Evidence gap',
        notes: 'Need two more cycles of validated data points.',
      },
    ],
  },
  {
    title: 'Coach Validation Required',
    items: [
      {
        title: 'Counter timing capability recommendation',
        submittedDate: '2026-07-07',
        origin: 'Program Concept',
        reviewStatus: 'Coach validation required',
        notes: 'Requires floor-level feasibility sign-off.',
      },
    ],
  },
];

export default function EvidenceReviewPage() {
  return (
    <FeatureSurface
      eyebrow="Evidence Review"
      title="Verification lane for submitted intake items"
      description="Review and validate submissions, then route accepted evidence into the Knowledge Graph stage."
      status="ready"
      currentStage="evidence"
      primaryLinks={[
        { label: 'Research intake', href: '/research' },
        { label: 'Knowledge graph', href: '/knowledge-graph' },
      ]}
      stats={[
        { label: 'Current Stage', value: 'Evidence Review' },
        { label: 'Next Stage', value: 'Knowledge Graph' },
        { label: 'Review Mode', value: 'Front-end Queue' },
        { label: 'State', value: 'Governed' },
      ]}
    >
      <div className="space-y-4">
        {reviewGroups.map((group) => (
          <section key={group.title} className="border-2 border-[#8b4444] bg-[#1a1a1a]/60 p-4">
            <p className="text-[12px] font-mono uppercase tracking-[0.16em] text-[#d4a574]">{group.title}</p>
            <div className="mt-3 space-y-3">
              {group.items.map((item) => (
                <article key={item.title} className="border border-[#5a4a3a] bg-[#101010] p-3">
                  <p className="text-[16px] font-bold text-[#e8d7c6]">{item.title}</p>
                  <div className="mt-2 grid gap-1 text-[14px] text-[#cfbfae] md:grid-cols-2">
                    <p>Submitted Date: {item.submittedDate}</p>
                    <p>Origin: {item.origin}</p>
                    <p>Review Status: {item.reviewStatus}</p>
                    <p>Notes: {item.notes}</p>
                  </div>
                  <p className="mt-2 font-mono text-[12px] uppercase tracking-[0.1em] text-[#d4a574]">-&gt; Points to Knowledge Graph</p>
                </article>
              ))}
            </div>
          </section>
        ))}

        <div className="border-2 border-[#8b4444] bg-[#121212] p-4">
          <p className="font-mono text-[12px] uppercase tracking-[0.15em] text-[#d4a574]">Flow Direction</p>
          <p className="mt-2 text-[16px] leading-7 text-[#e8d7c6]">Accepted and validated items advance to Knowledge Graph for relationship mapping.</p>
        </div>
      </div>
    </FeatureSurface>
  );
}