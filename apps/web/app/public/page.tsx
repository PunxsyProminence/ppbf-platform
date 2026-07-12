import FeatureSurface from '@/components/FeatureSurface';

export default function PublicPortalPage() {
  return (
    <FeatureSurface
      eyebrow="Public Portal"
      title="PPBF public entry and interest intake"
      description="A lightweight public-facing landing surface for visitors, partners, and first-time participants."
      status="ready"
      primaryLinks={[
        { label: 'Launch Portal', href: '/launch' },
        { label: 'Operations Hub', href: '/operations' },
      ]}
      stats={[
        { label: 'Audience', value: 'Visitors' },
        { label: 'Purpose', value: 'Awareness' },
        { label: 'Mode', value: 'Read-only' },
        { label: 'Access', value: 'Open' },
      ]}
    >
      <div className="grid gap-4 md:grid-cols-3">
        <div className="border-2 border-[#8b0000] bg-[#1a1a1a]/60 p-4">
          <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-[#c85a17]">What it does</p>
          <p className="mt-2 text-sm leading-6 text-[#e5e5e5]">Presents the organization, core programs, and a simple route into the platform.</p>
        </div>
        <div className="border-2 border-[#8b0000] bg-[#1a1a1a]/60 p-4">
          <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-[#c85a17]">Front door</p>
          <p className="mt-2 text-sm leading-6 text-[#e5e5e5]">Designed as a non-transactional public surface with no private data exposure.</p>
        </div>
        <div className="border-2 border-[#8b0000] bg-[#1a1a1a]/60 p-4">
          <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-[#c85a17]">Next step</p>
          <p className="mt-2 text-sm leading-6 text-[#e5e5e5]">Add contact intake, partner cards, or a public FAQ when you want to expand the story.</p>
        </div>
      </div>
    </FeatureSurface>
  );
}