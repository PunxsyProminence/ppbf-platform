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
  { label: 'Publication workflow', href: '/source-control/publication-workflow' },
  { label: 'Operations Hub', href: '/operations' },
  { label: 'Member Access', href: '/login' },
];

const stats = [
  { label: 'Current Stage', value: 'Source Control' },
  { label: 'Next Stage', value: 'Publish to Ecosystem' },
  { label: 'Promotion Queue', value: 'Not wired yet' },
  { label: 'Canonical Source', value: 'Not wired yet' },
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
        <header className="relative space-y-[var(--s4)] border-b-2 border-[color:var(--brass-700)] pb-[var(--s6)]">
          {/* The office's own fixture. This page had no lamp, no rivets, no
              paper and no table -- five grids of leather tiles, which is a
              board room with the wall swapped. */}
          <span className="lamp" aria-hidden="true" style={{ left: '50%', translate: '-50% 0' }} />
          <p className="t-eyebrow tracking-[0.35em]">Source Control</p>
          <h1 className="t-command" style={{ fontSize: 'var(--t-2xl)' }}>
            How A Card Gets Published
          </h1>
          {/* Law 7: "not built yet" is a declaration, so it is stamped in
              brass rather than painted in the safety ladder's colours. */}
          <span className="stamp stamp--brass">{capabilityStatus}</span>
          <p className="t-body max-w-[80ch]">
            The route a card takes — Draft, Review, Approved, Published, Archived — before it goes out to
            the rest of the platform. Every card, version, and count below is a sample written into this
            page. Nothing here is a real record, and nothing here moves anything.
          </p>
          <ShadowChatButton context="Source Control How A Card Gets Published" />
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

        <section className="space-y-[var(--s4)] mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s5)]">
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
          <article className="space-y-[var(--s4)] mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s5)]">
            <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Version History</h2>
            <p className="t-label">{capabilityStatus}</p>
            {/* A version history is a record, and the office writes records on
                ruled paper. .ledger carries the mono voice Law 4 gives anything
                auditable, so the per-row t-data classes go with it. */}
            <div className="mat-paper overflow-x-auto rounded-[var(--r-md)] p-[var(--s4)]">
              <table className="ledger">
                <caption className="text-left">Sample version history</caption>
                <thead>
                  <tr>
                    <th scope="col">Version</th>
                    <th scope="col">Note</th>
                    <th scope="col">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {sampleVersionHistory.map((entry) => (
                    <tr key={entry.version}>
                      <td className="font-bold">{entry.version}</td>
                      <td>{entry.note}</td>
                      <td className="ledger-id whitespace-nowrap">{entry.date}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>

          <article className="space-y-[var(--s4)] mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s5)]">
            <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Current Approved Version</h2>
            <p className="t-label">{capabilityStatus}</p>
            <div className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
              <p className="t-command" style={{ fontSize: 'var(--t-md)' }}>v2.1 Readiness warmup protocol</p>
              <p className="t-data mt-[var(--s3)]">Canonical Source: PPBF Development Library / v2.1</p>
            </div>
          </article>
        </section>

        <section className="space-y-[var(--s4)] mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s5)]">
          <div className="flex flex-wrap items-center justify-between gap-[var(--s4)]">
            <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>The Automatic Version — Planned</h2>
            <Link href="/source-control/publication-workflow" className="btn">
              Open The Workflow Page
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

        <section id="publish" className="space-y-[var(--s4)] mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s5)]">
          <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Publish to Ecosystem</h2>
          <p className="t-body max-w-[80ch]">
            The list of places a published card would go. Nothing on this page sends anything anywhere yet.
          </p>
          <div className="frame">
            <span className="rivet rivet--tl" />
            <span className="rivet rivet--tr" />
            <span className="rivet rivet--bl" />
            <span className="rivet rivet--br" />
            <div className="frame-in mat-paper p-[var(--s5)]">
              {/* The scroller is a child: .frame > .frame-in sets
                  overflow:hidden unlayered, which beats a layered overflow-x
                  utility on the same element. */}
              <div className="overflow-x-auto">
              <table className="ledger">
                <caption className="text-left">Destinations</caption>
                <thead>
                  <tr>
                    <th scope="col">Destination</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {publishDestinations.map((destination) => (
                    <tr key={destination.label}>
                      <td className="font-bold">{destination.label}</td>
                      <td>{destination.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </div>
          </div>
        </section>

        <section className="space-y-[var(--s4)] mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s5)]">
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
