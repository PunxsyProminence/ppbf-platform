import Link from 'next/link';
import FeatureSurface from '@/components/FeatureSurface';

const capabilityStatus = 'PLANNED | FRONT-END PLACEHOLDER | NOT YET AUTOMATED | BACKEND REQUIRED';

const sampleStateLanes: Array<{
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

const sampleVersionHistory = [
  { version: 'v2.1', note: 'Current approved version', date: '2026-07-12' },
  { version: 'v2.0', note: 'Promotion queue release', date: '2026-07-05' },
  { version: 'v1.9', note: 'Pre-validation snapshot', date: '2026-06-28' },
];

const automationWorkflowPanels = [
  'Publication Workflow Overview',
  'Source Review',
  'Approval Queue',
  'Publication Queue',
  'Publication History',
  'Destination Registry',
  'Source Status',
  'Version Status',
  'Approved Build Input Placeholder',
  'Publish to Ecosystem Placeholder',
  'Human Approval Gate',
  'Jason Approval',
];

export default function SourceControlPage() {
  return (
    <FeatureSurface
      eyebrow="Source Control"
      title="Promotion pipeline and publication lane"
      description="Shows how cards would move through Draft, Review, Approved, Published, and Archived states before ecosystem release. Every card, version, and count on this page is a sample, not live promotion state."
      status={capabilityStatus}
      currentStage="source-control"
      primaryLinks={[
        { label: 'Audit trace', href: '/audit' },
        { label: 'Research intake', href: '/research' },
        { label: 'Publication workflow surface', href: '/source-control/publication-workflow' },
      ]}
      stats={[
        { label: 'Current Stage', value: 'Source Control' },
        { label: 'Next Stage', value: 'Publish to Ecosystem' },
        { label: 'Promotion Queue', value: 'BACKEND REQUIRED' },
        { label: 'Canonical Source', value: 'BACKEND REQUIRED' },
      ]}
    >
      <div className="space-y-4">
        <section className="border-2 border-[#8b4444] bg-[#151515] p-4">
          <p className="text-[12px] font-mono uppercase tracking-[0.16em] text-[#d4a574]">Promotion State Lanes</p>
          <p className="mt-1 text-[11px] font-mono uppercase tracking-[0.09em] text-[#d4a574]">{capabilityStatus}</p>
          <div className="mt-3 grid gap-3 xl:grid-cols-5">
            {sampleStateLanes.map((lane) => (
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
            <p className="mt-1 text-[11px] font-mono uppercase tracking-[0.09em] text-[#d4a574]">{capabilityStatus}</p>
            <div className="mt-3 space-y-2">
              {sampleVersionHistory.map((entry) => (
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
            <p className="mt-1 text-[11px] font-mono uppercase tracking-[0.09em] text-[#d4a574]">{capabilityStatus}</p>
            <div className="mt-3 border border-[#5a4a3a] bg-[#101010] p-3">
              <p className="text-[16px] font-bold text-[#e8d7c6]">v2.1 Readiness warmup protocol</p>
              <p className="mt-1 text-[14px] text-[#cfbfae]">Canonical Source: PPBF Development Library / v2.1</p>
            </div>
          </article>
        </section>

        <section className="border-2 border-[#8b4444] bg-[#151515] p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-[12px] font-mono uppercase tracking-[0.16em] text-[#d4a574]">AUTOMATED PUBLICATION WORKFLOW - PLANNED</p>
            <Link
              href="/source-control/publication-workflow"
              className="inline-flex min-h-[40px] items-center border border-[#8b4444] bg-[#2a1414] px-3 text-[11px] font-mono font-bold uppercase tracking-[0.1em] text-[#e8d7c6]"
            >
              Open Workflow Surface
            </Link>
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {automationWorkflowPanels.map((panel) => (
              <article key={panel} className="border border-[#5a4a3a] bg-[#101010] p-3">
                <p className="text-[14px] font-semibold text-[#e8d7c6]">{panel}</p>
                <p className="mt-1 text-[11px] font-mono uppercase tracking-[0.09em] text-[#d4a574]">{capabilityStatus}</p>
              </article>
            ))}
          </div>
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