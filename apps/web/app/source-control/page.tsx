import FeatureSurface from '@/components/FeatureSurface';

const stateLanes: Array<{
  state: 'Draft' | 'Review' | 'Approved' | 'Published' | 'Archived';
  items: Array<{ title: string; version: string; canonical: string }>;
}> = [
  {
    state: 'Draft',
    items: [
      { title: 'Counter timing drill update', version: 'v0.3', canonical: 'Pending' },
      { title: 'Recovery checkpoint guidance', version: 'v0.2', canonical: 'Pending' },
    ],
  },
  {
    state: 'Review',
    items: [{ title: 'Load variance recommendation', version: 'v0.7', canonical: 'Pending' }],
  },
  {
    state: 'Approved',
    items: [{ title: 'Coach evidence intake checklist', version: 'v1.0', canonical: 'Candidate' }],
  },
  {
    state: 'Published',
    items: [{ title: 'Readiness warmup protocol', version: 'v2.1', canonical: 'Yes' }],
  },
  {
    state: 'Archived',
    items: [{ title: 'Legacy hand-wrap baseline', version: 'v1.4', canonical: 'No' }],
  },
];

const publishDestinations = [
  { label: 'Athlete Workspace', status: 'Ready' },
  { label: 'Coach Workspace', status: 'Pending' },
  { label: 'Parent Hub', status: 'Pending' },
  { label: 'Admin Hub', status: 'Ready' },
  { label: 'Board Hub', status: 'Pending' },
  { label: 'Capability Registry', status: 'Ready' },
  { label: 'Development Library', status: 'Published' },
];

const versionHistory = [
  { version: 'v2.1', note: 'Current approved version', date: '2026-07-12' },
  { version: 'v2.0', note: 'Promotion queue release', date: '2026-07-05' },
  { version: 'v1.9', note: 'Pre-validation snapshot', date: '2026-06-28' },
];

export default function SourceControlPage() {
  return (
    <FeatureSurface
      eyebrow="Source Control"
      title="Promotion pipeline and publication lane"
      description="Visualize cards moving through Draft, Review, Approved, Published, and Archived states before ecosystem release."
      status="ready"
      currentStage="source-control"
      primaryLinks={[
        { label: 'Audit trace', href: '/audit' },
        { label: 'Research intake', href: '/research' },
      ]}
      stats={[
        { label: 'Current Stage', value: 'Source Control' },
        { label: 'Next Stage', value: 'Publish to Ecosystem' },
        { label: 'Promotion Queue', value: '7 items' },
        { label: 'Canonical Source', value: 'v2.1' },
      ]}
    >
      <div className="space-y-4">
        <section className="border-2 border-[#8b4444] bg-[#151515] p-4">
          <p className="text-[12px] font-mono uppercase tracking-[0.16em] text-[#d4a574]">Promotion State Lanes</p>
          <div className="mt-3 grid gap-3 xl:grid-cols-5">
            {stateLanes.map((lane) => (
              <article key={lane.state} className="border border-[#5a4a3a] bg-[#101010] p-3">
                <p className="font-mono text-[12px] uppercase tracking-[0.12em] text-[#d4a574]">{lane.state}</p>
                <div className="mt-2 space-y-2">
                  {lane.items.map((item) => (
                    <div key={item.title} className="border border-[#8b4444]/60 bg-[#161616] p-2">
                      <p className="text-[14px] font-semibold text-[#e8d7c6]">{item.title}</p>
                      <p className="text-[12px] text-[#cfbfae]">{item.version}</p>
                      <p className="text-[12px] text-[#cfbfae]">Canonical: {item.canonical}</p>
                    </div>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <article className="border-2 border-[#8b4444] bg-[#1a1a1a]/60 p-4">
            <p className="text-[12px] font-mono uppercase tracking-[0.16em] text-[#d4a574]">Version History</p>
            <div className="mt-3 space-y-2">
              {versionHistory.map((entry) => (
                <div key={entry.version} className="border border-[#5a4a3a] bg-[#101010] p-3 text-[14px] text-[#cfbfae]">
                  <p className="font-semibold text-[#e8d7c6]">{entry.version}</p>
                  <p>{entry.note}</p>
                  <p>{entry.date}</p>
                </div>
              ))}
            </div>
          </article>

          <article className="border-2 border-[#8b4444] bg-[#1a1a1a]/60 p-4">
            <p className="text-[12px] font-mono uppercase tracking-[0.16em] text-[#d4a574]">Current Approved Version</p>
            <div className="mt-3 border border-[#5a4a3a] bg-[#101010] p-3">
              <p className="text-[16px] font-bold text-[#e8d7c6]">v2.1 Readiness warmup protocol</p>
              <p className="mt-1 text-[14px] text-[#cfbfae]">Canonical Source: PPBF Development Library / v2.1</p>
            </div>
          </article>
        </section>

        <section id="publish" className="border-2 border-[#8b4444] bg-[#151515] p-4">
          <p className="text-[12px] font-mono uppercase tracking-[0.16em] text-[#d4a574]">PUBLISH TO ECOSYSTEM</p>
          <p className="mt-2 text-[16px] leading-7 text-[#e8d7c6]">Mock destination routing only. No live publication logic in this front-end stage.</p>
          <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {publishDestinations.map((destination) => (
              <article key={destination.label} className="border border-[#5a4a3a] bg-[#101010] p-3">
                <p className="text-[14px] font-semibold text-[#e8d7c6]">{destination.label}</p>
                <p className="mt-1 font-mono text-[12px] uppercase tracking-[0.1em] text-[#d4a574]">Status: {destination.status}</p>
              </article>
            ))}
          </div>
        </section>
      </div>
    </FeatureSurface>
  );
}