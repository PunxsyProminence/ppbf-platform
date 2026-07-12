import FeatureSurface from '@/components/FeatureSurface';

export default function SourceControlPage() {
  return (
    <FeatureSurface
      eyebrow="Source Control"
      title="Draft-to-approved promotion lane"
      description="A simple governance surface for tracking drafts, promotions, and the canonical source of truth."
      status="ready"
      primaryLinks={[
        { label: 'Audit trace', href: '/audit' },
        { label: 'Operations Hub', href: '/operations' },
      ]}
      stats={[
        { label: 'Drafts', value: 'Queued' },
        { label: 'Promotions', value: 'Controlled' },
        { label: 'Mode', value: 'Governed' },
        { label: 'Truth', value: 'Canonical' },
      ]}
    >
      <div className="grid gap-4 md:grid-cols-3">
        <div className="border-2 border-[#8b4444] bg-[#1a1a1a]/60 p-4">
          <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-[#d4a574]">Promotion queue</p>
          <p className="mt-2 text-sm leading-6 text-[#e8d7c6]">Shows which items are waiting to be promoted from draft into governed production surfaces.</p>
        </div>
        <div className="border-2 border-[#8b4444] bg-[#1a1a1a]/60 p-4">
          <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-[#d4a574]">Versioning</p>
          <p className="mt-2 text-sm leading-6 text-[#e8d7c6]">Keeps version tags visible so operators can see what changed and when.</p>
        </div>
        <div className="border-2 border-[#8b4444] bg-[#1a1a1a]/60 p-4">
          <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-[#d4a574]">Canonical state</p>
          <p className="mt-2 text-sm leading-6 text-[#e8d7c6]">Marks the approved source-of-truth layer for the rest of the app to follow.</p>
        </div>
      </div>
    </FeatureSurface>
  );
}