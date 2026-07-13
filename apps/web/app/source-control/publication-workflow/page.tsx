import FeatureSurface from '@/components/FeatureSurface';

const publicationStages = [
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

export default function PublicationWorkflowPage() {
  return (
    <FeatureSurface
      eyebrow="Publication Workflow"
      title="Automated Publication Workflow"
      description="Source-control publication surface for the PPBF ecosystem. This pass is front-end visibility only."
      status="PLANNED | FRONT-END PLACEHOLDER"
      currentStage="publish"
      primaryLinks={[
        { label: 'Source control', href: '/source-control' },
        { label: 'Audit trace', href: '/audit' },
        { label: 'Admin compliance center', href: '/admin/compliance-center' },
      ]}
      stats={[
        { label: 'Automation State', value: 'NOT YET AUTOMATED' },
        { label: 'Execution Engine', value: 'BACKEND REQUIRED' },
        { label: 'Approval Model', value: 'Human Approval Gate' },
        { label: 'Release Control', value: 'Jason Approval' },
      ]}
    >
      <div className="space-y-4">
        <section className="border-2 border-[#8b4444] bg-[#151515] p-4">
          <p className="text-[12px] font-mono uppercase tracking-[0.16em] text-[#d4a574]">Workflow Surface Registry</p>
          <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {publicationStages.map((stage) => (
              <article key={stage} className="border border-[#5a4a3a] bg-[#101010] p-3">
                <p className="text-[14px] font-semibold text-[#e8d7c6]">{stage}</p>
                <p className="mt-1 text-[11px] font-mono uppercase tracking-[0.09em] text-[#d4a574]">
                  PLANNED | FRONT-END PLACEHOLDER | NOT YET AUTOMATED | BACKEND REQUIRED
                </p>
              </article>
            ))}
          </div>
        </section>
      </div>
    </FeatureSurface>
  );
}
