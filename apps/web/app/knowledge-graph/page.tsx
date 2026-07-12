import FeatureSurface from '@/components/FeatureSurface';

const nodeTypes = ['Drill', 'Goal', 'Capability', 'Assessment', 'Track', 'Evidence', 'Research', 'Safety', 'Policy'];

const relationshipChains = [
  ['Research', 'Evidence', 'Drill', 'Goal', 'Track'],
  ['Policy', 'Safety', 'Assessment', 'Capability'],
  ['Research', 'Evidence', 'Capability', 'Track'],
];

export default function KnowledgeGraphPage() {
  return (
    <FeatureSurface
      eyebrow="Knowledge Graph"
      title="Concept relationship map"
      description="Visualize how research, evidence, drills, goals, assessments, and policies connect before validation and governance stages."
      status="ready"
      currentStage="knowledge"
      primaryLinks={[
        { label: 'Research intake', href: '/research' },
        { label: 'Evidence review', href: '/evidence' },
        { label: 'Scenario simulator', href: '/simulator' },
      ]}
      stats={[
        { label: 'Current Stage', value: 'Knowledge Graph' },
        { label: 'Next Stage', value: 'Scenario Simulator' },
        { label: 'Node Types', value: '9' },
        { label: 'Mode', value: 'Relationship View' },
      ]}
    >
      <div className="space-y-4">
        <section className="border-2 border-[#8b4444] bg-[#1a1a1a]/60 p-4">
          <p className="text-[12px] font-mono uppercase tracking-[0.16em] text-[#d4a574]">Node Types</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {nodeTypes.map((type) => (
              <div key={type} className="border border-[#5a4a3a] bg-[#101010] px-3 py-2 text-[14px] text-[#e8d7c6]">
                {type}
              </div>
            ))}
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-3">
          {relationshipChains.map((chain, index) => (
            <article key={index} className="border-2 border-[#8b4444] bg-[#1a1a1a]/60 p-4">
              <p className="text-[12px] font-mono uppercase tracking-[0.16em] text-[#d4a574]">Relationship Chain {index + 1}</p>
              <div className="mt-3 space-y-2">
                {chain.map((node, nodeIndex) => (
                  <div key={`${node}-${nodeIndex}`}>
                    <div className="border border-[#5a4a3a] bg-[#101010] px-3 py-2 text-[14px] text-[#e8d7c6]">{node}</div>
                    {nodeIndex < chain.length - 1 && <p className="py-1 text-center font-mono text-[#d4a574]">↓</p>}
                  </div>
                ))}
              </div>
            </article>
          ))}
        </section>

        <div className="border-2 border-[#8b4444] bg-[#121212] p-4">
          <p className="font-mono text-[12px] uppercase tracking-[0.15em] text-[#d4a574]">Flow Direction</p>
          <p className="mt-2 text-[16px] leading-7 text-[#e8d7c6]">Mapped concepts move to Scenario Simulator where outcomes and risk are tested before governance.</p>
        </div>
      </div>
    </FeatureSurface>
  );
}