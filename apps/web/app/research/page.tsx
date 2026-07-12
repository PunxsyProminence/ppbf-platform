import Link from 'next/link';
import FeatureSurface from '@/components/FeatureSurface';

export default function ResearchIntakePage() {
  return (
    <FeatureSurface
      eyebrow="Research Intake"
      title="Evidence capture and learning notes"
      description="A disciplined front end for research ideas, field notes, and evidence review inputs."
      status="ready"
      primaryLinks={[
        { label: 'Q&A Research Chat', href: '/research/chat' },
        { label: 'Evidence review', href: '/evidence' },
        { label: 'Audit surface', href: '/audit' },
      ]}
      stats={[
        { label: 'Mode', value: 'Write' },
        { label: 'Scope', value: 'Evidence' },
        { label: 'Review', value: 'Coach-led' },
        { label: 'Status', value: 'Live' },
      ]}
    >
      <div className="grid gap-4 md:grid-cols-2">
        <div className="border-2 border-[#8b4444] bg-[#1a1a1a]/60 p-4">
          <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-[#d4a574]">Intake fields</p>
          <p className="mt-2 text-sm leading-6 text-[#e8d7c6]">Use this page for note capture, citations, and project context before anything becomes governed content.</p>
        </div>
        <div className="border-2 border-[#8b4444] bg-[#1a1a1a]/60 p-4">
          <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-[#d4a574]">Q&A Chat</p>
          <p className="mt-2 text-sm leading-6 text-[#e8d7c6]">Ask questions about training science, platform capabilities, SHADOW specs, and research methodology.</p>
        </div>
      </div>
    </FeatureSurface>
  );
}