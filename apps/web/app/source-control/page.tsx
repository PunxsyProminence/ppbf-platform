import Link from 'next/link';
import DevelopmentPipelineBanner from '@/components/DevelopmentPipelineBanner';
import ShadowChatButton from '@/components/ShadowChatButton';

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

const quickLinks = [
  { label: 'Audit trace', href: '/audit' },
  { label: 'Research intake', href: '/research' },
  { label: 'Publication workflow surface', href: '/source-control/publication-workflow' },
  { label: 'Operations Hub', href: '/operations' },
  { label: 'Member Access', href: '/login' },
];

const stats = [
  { label: 'Current Stage', value: 'Source Control' },
  { label: 'Next Stage', value: 'Publish to Ecosystem' },
  { label: 'Promotion Queue', value: 'BACKEND REQUIRED' },
  { label: 'Canonical Source', value: 'BACKEND REQUIRED' },
];

export default function SourceControlPage() {
  return (
    /* Ink ground (Law 6): source-control is a staff governance table, so it
       stands on the same leather chassis as /operations rather than the
       FeatureSurface cream scaffold it launched on. The room is .room--office,
       the room buildingMap.ts already files this door under -- ink alone is a
       ground, not a room, and a screen with no room is the one thing Room DNA
       does not allow. */
    <main className="room room--office min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-[var(--s6)] px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
        <header className="space-y-[var(--s4)] border-b-2 border-[color:var(--brass-700)] pb-[var(--s6)]">
          <p className="t-eyebrow tracking-[0.35em]">Source Control</p>
          <h1 className="t-command" style={{ fontSize: 'var(--t-2xl)' }}>
            Promotion pipeline and publication lane
          </h1>
          {/* Law 7: "not built yet" is a declaration, so it is stamped in
              brass rather than painted in the safety ladder's colours. */}
          <span className="stamp stamp--brass">{capabilityStatus}</span>
          <p className="t-body max-w-[80ch]">
            Shows how cards would move through Draft, Review, Approved, Published, and Archived states before ecosystem release. Every card, version, and count on this page is a sample, not live promotion state.
          </p>
          <ShadowChatButton context="Source Control Promotion pipeline and publication lane" />
        </header>

        <DevelopmentPipelineBanner currentStage="source-control" />

        <section className="grid gap-[var(--s4)] sm:grid-cols-2 xl:grid-cols-4">
          {stats.map((item) => (
            <article key={item.label} className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
              <p className="t-eyebrow">{item.label}</p>
              <p className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-md)' }}>{item.value}</p>
            </article>
          ))}
        </section>

        <section className="space-y-[var(--s4)] mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
          <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Promotion State Lanes</h2>
          <p className="t-label">{capabilityStatus}</p>
          <div className="grid gap-[var(--s4)] xl:grid-cols-5">
            {sampleStateLanes.map((lane) => (
              <article key={lane.state} className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                <p className="t-eyebrow">{lane.state}</p>
                <div className="mt-[var(--s3)] space-y-[var(--s3)]">
                  {lane.items.map((item) => (
                    <div key={item.title} className="mat-leather rounded-[var(--r-sm)] p-[var(--s3)]">
                      <p className="t-body font-semibold text-[color:var(--bone-100)]">{item.title}</p>
                      {/* Versions and canonical state are auditable records —
                          the mono data voice (Law 4). */}
                      <p className="t-data mt-[var(--s2)]">{item.version}</p>
                      <p className="t-data">Canonical: {item.canonical}</p>
                    </div>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="grid gap-[var(--s4)] lg:grid-cols-2">
          <article className="space-y-[var(--s4)] mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
            <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Version History</h2>
            <p className="t-label">{capabilityStatus}</p>
            <div className="space-y-[var(--s3)]">
              {sampleVersionHistory.map((entry) => (
                <div key={entry.version} className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                  <p className="t-data text-[color:var(--bone-100)]">{entry.version}</p>
                  <p className="t-body mt-[var(--s2)]">{entry.note}</p>
                  <p className="t-data mt-[var(--s2)]">{entry.date}</p>
                </div>
              ))}
            </div>
          </article>

          <article className="space-y-[var(--s4)] mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
            <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Current Approved Version</h2>
            <p className="t-label">{capabilityStatus}</p>
            <div className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
              <p className="t-command" style={{ fontSize: 'var(--t-md)' }}>v2.1 Readiness warmup protocol</p>
              <p className="t-data mt-[var(--s3)]">Canonical Source: PPBF Development Library / v2.1</p>
            </div>
          </article>
        </section>

        <section className="space-y-[var(--s4)] mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
          <div className="flex flex-wrap items-center justify-between gap-[var(--s4)]">
            <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Automated Publication Workflow - Planned</h2>
            <Link href="/source-control/publication-workflow" className="btn">
              Open Workflow Surface
            </Link>
          </div>
          <div className="grid gap-[var(--s4)] md:grid-cols-2 xl:grid-cols-3">
            {automationWorkflowPanels.map((panel) => (
              <article key={panel} className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                <p className="t-body font-semibold text-[color:var(--bone-100)]">{panel}</p>
                <p className="t-label mt-[var(--s2)]">{capabilityStatus}</p>
              </article>
            ))}
          </div>
        </section>

        <section id="publish" className="space-y-[var(--s4)] mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
          <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Publish to Ecosystem</h2>
          <p className="t-body max-w-[80ch]">Mock destination routing only. No live publication logic in this front-end stage.</p>
          <div className="grid gap-[var(--s4)] md:grid-cols-2 xl:grid-cols-3">
            {publishDestinations.map((destination) => (
              <article key={destination.label} className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                <p className="t-body font-semibold text-[color:var(--bone-100)]">{destination.label}</p>
                <p className="t-label mt-[var(--s2)]">Status: {destination.status}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="space-y-[var(--s4)] mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
          <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Quick links</h2>
          <div className="flex flex-wrap gap-[var(--s4)]">
            {quickLinks.map((item) => (
              <Link key={item.href} href={item.href} className="btn btn--ghost">
                {item.label}
              </Link>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
