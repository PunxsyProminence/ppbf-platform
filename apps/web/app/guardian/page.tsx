import FeatureSurface from '@/components/FeatureSurface';

export default function GuardianPortalPage() {
  return (
    <FeatureSurface
      eyebrow="Guardian Portal"
      title="View-only family progress surface"
      description="A secure, easy-to-read snapshot for parents or guardians to monitor attendance, progress, and safety notes."
      status="ready"
      primaryLinks={[
        { label: 'Athlete dashboard', href: '/athlete/dashboard' },
        { label: 'Launch Portal', href: '/launch' },
      ]}
      stats={[
        { label: 'Audience', value: 'Guardians' },
        { label: 'Access', value: 'View-only' },
        { label: 'Focus', value: 'Safety' },
        { label: 'Mode', value: 'Family' },
      ]}
    >
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="border-2 border-[#8b0000] bg-[#1a1a1a]/60 p-4">
          <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-[#c85a17]">Attendance</p>
          <p className="mt-2 text-sm leading-6 text-[#e5e5e5]">Shows check-ins, streaks, and whether the participant has met minimum participation expectations.</p>
        </div>
        <div className="border-2 border-[#8b0000] bg-[#1a1a1a]/60 p-4">
          <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-[#c85a17]">Safety notes</p>
          <p className="mt-2 text-sm leading-6 text-[#e5e5e5]">Surface for injury flags, recovery holds, and any restricted training guidance.</p>
        </div>
        <div className="border-2 border-[#8b0000] bg-[#1a1a1a]/60 p-4">
          <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-[#c85a17]">Home follow-up</p>
          <p className="mt-2 text-sm leading-6 text-[#e5e5e5]">A place for at-home practice prompts, family reminders, and message acknowledgements.</p>
        </div>
      </div>
    </FeatureSurface>
  );
}