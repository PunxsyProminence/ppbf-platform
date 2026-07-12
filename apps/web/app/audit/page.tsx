import FeatureSurface from '@/components/FeatureSurface';

const auditTimeline = [
  {
    timestamp: '2026-07-12T09:14:23Z',
    user: 'Research Desk',
    action: 'Research Submitted',
    object: 'Southpaw Footwork Progression Concept',
    reason: 'New training concept intake',
    status: 'Recorded',
  },
  {
    timestamp: '2026-07-12T10:22:09Z',
    user: 'Coach Ramos',
    action: 'Review Approved',
    object: 'Shoulder load progression summary',
    reason: 'Evidence aligned with objective',
    status: 'Approved',
  },
  {
    timestamp: '2026-07-12T11:01:47Z',
    user: 'Admin',
    action: 'Capability Modified',
    object: 'CAP-014 load-monitor lane',
    reason: 'Validation findings from simulator',
    status: 'Logged',
  },
  {
    timestamp: '2026-07-12T11:46:11Z',
    user: 'Program Analyst',
    action: 'Scenario Created',
    object: 'Training Load what-if',
    reason: 'Assess risk of intensity shift',
    status: 'Tracked',
  },
  {
    timestamp: '2026-07-12T12:05:58Z',
    user: 'Governance Review',
    action: 'Promotion Requested',
    object: 'Draft guidance package v0.9',
    reason: 'Ready for source-control promotion queue',
    status: 'Pending',
  },
];

export default function AuditTracePage() {
  return (
    <FeatureSurface
      eyebrow="Audit & Change Trace"
      title="Timeline visibility for governance and traceability"
      description="Track who changed what and why, then hand approved trace flows to Source Control for promotion."
      status="ready"
      currentStage="audit"
      primaryLinks={[
        { label: 'Source control', href: '/source-control' },
        { label: 'Simulator', href: '/simulator' },
      ]}
      stats={[
        { label: 'Current Stage', value: 'Audit Trace' },
        { label: 'Next Stage', value: 'Source Control' },
        { label: 'Mode', value: 'Timeline Review' },
        { label: 'Visibility', value: 'Governance' },
      ]}
    >
      <div className="space-y-3">
        {auditTimeline.map((event) => (
          <article key={`${event.timestamp}-${event.action}`} className="border-2 border-[#8b4444] bg-[#1a1a1a]/60 p-4">
            <div className="grid gap-2 text-[14px] text-[#cfbfae] md:grid-cols-2">
              <p><span className="font-semibold text-[#d4a574]">Timestamp:</span> {event.timestamp}</p>
              <p><span className="font-semibold text-[#d4a574]">User:</span> {event.user}</p>
              <p><span className="font-semibold text-[#d4a574]">Action:</span> {event.action}</p>
              <p><span className="font-semibold text-[#d4a574]">Object:</span> {event.object}</p>
              <p><span className="font-semibold text-[#d4a574]">Reason:</span> {event.reason}</p>
              <p><span className="font-semibold text-[#d4a574]">Status:</span> {event.status}</p>
            </div>
          </article>
        ))}

        <div className="border-2 border-[#8b4444] bg-[#121212] p-4">
          <p className="font-mono text-[12px] uppercase tracking-[0.15em] text-[#d4a574]">Flow Direction</p>
          <p className="mt-2 text-[16px] leading-7 text-[#e8d7c6]">Audited items move into Source Control promotion states for controlled publication.</p>
        </div>
      </div>
    </FeatureSurface>
  );
}