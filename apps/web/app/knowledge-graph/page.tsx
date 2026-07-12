import FeatureSurface from '@/components/FeatureSurface';

export default function KnowledgeGraphPage() {
  return (
    <FeatureSurface
      eyebrow="Knowledge Graph"
      title="Drill, goal, and evidence relationship map"
      description="A structural view that links training concepts, risk factors, and historical notes into one navigable front end."
      status="ready"
      primaryLinks={[
        { label: 'Research intake', href: '/research' },
        { label: 'Evidence review', href: '/evidence' },
      ]}
      stats={[
        { label: 'Nodes', value: 'Mapped' },
        { label: 'Links', value: 'Tracked' },
        { label: 'Mode', value: 'Explore' },
        { label: 'Layer', value: '36' },
      ]}
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="border-2 border-[#8b4444] bg-[#1a1a1a]/60 p-4">
          <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-[#d4a574]">Drill links</p>
          <p className="mt-2 text-sm leading-6 text-[#e8d7c6]">Connect drills to goals, progression levels, and evidence artifacts in one navigable structure.</p>
        </div>
        <div className="border-2 border-[#8b4444] bg-[#1a1a1a]/60 p-4">
          <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-[#d4a574]">Risk context</p>
          <p className="mt-2 text-sm leading-6 text-[#e8d7c6]">Surface relationships to fatigue, injury risk, and blocked progress so the map is useful to coaches.</p>
        </div>
      </div>
    </FeatureSurface>
  );
}