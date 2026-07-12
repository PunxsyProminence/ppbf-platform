import Link from 'next/link';
import FeatureSurface from '@/components/FeatureSurface';

const pipelineOverview = [
  { label: 'Research Items', value: '18' },
  { label: 'Evidence Reviews', value: '11' },
  { label: 'Knowledge Nodes', value: '42' },
  { label: 'Active Simulations', value: '9' },
  { label: 'Audit Events', value: '57' },
  { label: 'Promotion Queue', value: '7' },
  { label: 'Published Items', value: '14' },
];

const intakeCards = [
  {
    title: 'Southpaw Footwork Progression Concept',
    category: 'Training Concept',
    author: 'Coach Ramos',
    date: '2026-07-11',
    status: 'Review',
    promotionStage: 'Research Intake -> Evidence Review',
  },
  {
    title: 'Reaction Latency and Recovery Correlation',
    category: 'Research Topic',
    author: 'Program Analyst',
    date: '2026-07-10',
    status: 'Needs Evidence',
    promotionStage: 'Research Intake -> Evidence Review',
  },
  {
    title: 'Parent Observation on Session Readiness',
    category: 'Observation',
    author: 'Parent / Guardian',
    date: '2026-07-09',
    status: 'Ready For Review',
    promotionStage: 'Research Intake -> Evidence Review',
  },
  {
    title: 'Citation Stack for Shoulder Load Protocol',
    category: 'Citation',
    author: 'Research Desk',
    date: '2026-07-08',
    status: 'Draft',
    promotionStage: 'Research Intake -> Evidence Review',
  },
];

export default function ResearchIntakePage() {
  return (
    <FeatureSurface
      eyebrow="Research Intake"
      title="Research Inbox and intake lane"
      description="Capture ideas, questions, observations, citations, notes, and training/program concepts before Evidence Review."
      status="ready"
      currentStage="research"
      primaryLinks={[
        { label: 'Q&A Research Chat', href: '/research/chat' },
        { label: 'Evidence review', href: '/evidence' },
        { label: 'Pipeline publish stage', href: '/source-control#publish' },
      ]}
      stats={[
        { label: 'Mode', value: 'Research Inbox' },
        { label: 'Current Stage', value: 'Research Intake' },
        { label: 'Next Stage', value: 'Evidence Review' },
        { label: 'Status', value: 'In Flow' },
      ]}
    >
      <div className="space-y-4">
        <section className="border-2 border-[#8b4444] bg-[#151515] p-4">
          <p className="text-[12px] font-mono uppercase tracking-[0.18em] text-[#d4a574]">Pipeline Overview</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {pipelineOverview.map((item) => (
              <article key={item.label} className="border border-[#5a4a3a] bg-[#0f0f0f] p-3">
                <p className="text-[11px] font-mono uppercase tracking-[0.14em] text-[#b0a095]">{item.label}</p>
                <p className="mt-2 text-2xl font-black text-[#e8d7c6]">{item.value}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="space-y-3 border-2 border-[#8b4444] bg-[#151515] p-4">
          <p className="text-[12px] font-mono uppercase tracking-[0.18em] text-[#d4a574]">Research Intake Cards</p>
          {intakeCards.map((item) => (
            <article key={item.title} className="border border-[#8b4444] bg-[#1a1a1a]/70 p-4">
              <div className="grid gap-2 md:grid-cols-2">
                <p className="text-[16px] font-bold text-[#e8d7c6]">{item.title}</p>
                <p className="text-[13px] font-mono uppercase tracking-[0.1em] text-[#d4a574]">Status: {item.status}</p>
                <p className="text-[14px] text-[#cfbfae]">Category: {item.category}</p>
                <p className="text-[14px] text-[#cfbfae]">Author: {item.author}</p>
                <p className="text-[14px] text-[#cfbfae]">Date: {item.date}</p>
                <p className="text-[14px] text-[#cfbfae]">Promotion Stage: {item.promotionStage}</p>
              </div>
              <div className="mt-3 flex items-center justify-between border-t border-[#5a4a3a] pt-3">
                <p className="font-mono text-[12px] uppercase tracking-[0.12em] text-[#d4a574]">Next: Evidence Review</p>
                <Link
                  href="/evidence"
                  className="inline-flex min-h-[44px] items-center border border-[#8b4444] bg-[#2a1414] px-3 text-[12px] font-bold text-[#e8d7c6] transition hover:border-[#d4a574]"
                >
                  Move to Evidence -&gt;
                </Link>
              </div>
            </article>
          ))}
        </section>

        <section className="grid gap-3 md:grid-cols-2">
          <div className="border-2 border-[#8b4444] bg-[#1a1a1a]/60 p-4">
            <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-[#d4a574]">Research Inbox Purpose</p>
            <p className="mt-2 text-[16px] leading-7 text-[#e8d7c6]">Capture questions, ideas, citations, observations, and concept notes before validation lanes begin.</p>
          </div>
          <div className="border-2 border-[#8b4444] bg-[#1a1a1a]/60 p-4">
            <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-[#d4a574]">Q&A Support Surface</p>
            <p className="mt-2 text-[16px] leading-7 text-[#e8d7c6]">Use the Q&A route for exploratory prompts, then normalize findings into structured intake cards here.</p>
          </div>
        </section>
      </div>
    </FeatureSurface>
  );
}