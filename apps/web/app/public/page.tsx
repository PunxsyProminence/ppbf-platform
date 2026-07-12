import FeatureSurface from '@/components/FeatureSurface';

export default function PublicPortalPage() {
  return (
    <FeatureSurface
      eyebrow="Public Portal"
      title="PPBF public entry and interest intake"
      description="A lightweight public-facing landing surface for visitors, partners, and first-time participants."
      status="ready"
      primaryLinks={[
        { label: 'The Ring', href: '/operations' },
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
        <div className="border-2 border-[#8b4444] bg-[#1a1a1a]/60 p-4">
          <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-[#d4a574]">What it does</p>
          <p className="mt-2 text-sm leading-6 text-[#e8d7c6]">Presents the organization, core programs, and a simple route into the platform.</p>
        </div>
        <div className="border-2 border-[#8b4444] bg-[#1a1a1a]/60 p-4">
          <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-[#d4a574]">Front door</p>
          <p className="mt-2 text-sm leading-6 text-[#e8d7c6]">Designed as a non-transactional public surface with no private data exposure.</p>
        </div>
        <div className="border-2 border-[#8b4444] bg-[#1a1a1a]/60 p-4">
          <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-[#d4a574]">Next step</p>
          <p className="mt-2 text-sm leading-6 text-[#e8d7c6]">Add contact intake, partner cards, or a public FAQ when you want to expand the story.</p>
        </div>
      </div>
    </FeatureSurface>
  );
}