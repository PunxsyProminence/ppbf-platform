import FeatureSurface from '@/components/FeatureSurface';

const scenarios = [
  {
    title: 'Athlete Readiness',
    currentState: 'Readiness trend stable at baseline tolerance.',
    proposedChange: 'Increase high-output drill frequency by 1 additional block.',
    expectedOutcome: 'Short-term adaptation spike with increased fatigue checkpoints.',
    riskRating: 'Moderate',
  },
  {
    title: 'Training Load',
    currentState: 'Load spread balanced across weekly cycle.',
    proposedChange: 'Shift one recovery session to additional technical sparring prep.',
    expectedOutcome: 'Potential higher output but tighter recovery margins.',
    riskRating: 'High',
  },
  {
    title: 'Recovery Changes',
    currentState: 'Recovery interventions occur post-session only.',
    proposedChange: 'Add pre-session mobility and hydration gate.',
    expectedOutcome: 'Reduced soreness carryover and better session quality.',
    riskRating: 'Low',
  },
  {
    title: 'Track Changes',
    currentState: 'Athlete is in current non-contact progression lane.',
    proposedChange: 'Promote to competition-prep track pending evidence window.',
    expectedOutcome: 'Faster progression with elevated oversight requirements.',
    riskRating: 'Moderate',
  },
  {
    title: 'Capability Changes',
    currentState: 'Current capability set locked to baseline assignment.',
    proposedChange: 'Enable additional analytics capability for coach review lane.',
    expectedOutcome: 'Improved review context with governance trail expansion.',
    riskRating: 'Low',
  },
  {
    title: 'Workflow Changes',
    currentState: 'Manual review handoff across stages.',
    proposedChange: 'Add pre-validation checklist card before audit trace.',
    expectedOutcome: 'Fewer governance rejections in late pipeline stage.',
    riskRating: 'Moderate',
  },
  {
    title: 'Program Changes',
    currentState: 'Program objective fixed to current cycle focus.',
    proposedChange: 'Shift objective to conditioning-heavy cycle for two weeks.',
    expectedOutcome: 'Higher cardio gains with temporary technical plateau risk.',
    riskRating: 'High',
  },
];

function riskClasses(risk: 'Low' | 'Moderate' | 'High') {
  if (risk === 'Low') return 'border-[#3f8b5b] bg-[#162a1d] text-[#c9f0d7]';
  if (risk === 'Moderate') return 'border-[#b38a3c] bg-[#2f2817] text-[#f5e3b5]';
  return 'border-[#a13f3f] bg-[#2c1414] text-[#f2c3c3]';
}

export default function ScenarioSimulatorPage() {
  return (
    <FeatureSurface
      eyebrow="Scenario Simulator"
      title="Validation sandbox for proposed changes"
      description="Run front-end what-if scenarios to evaluate expected outcomes and risk before audit and promotion stages."
      status="ready"
      currentStage="simulator"
      primaryLinks={[
        { label: 'Audit trace', href: '/audit' },
        { label: 'Knowledge graph', href: '/knowledge-graph' },
      ]}
      stats={[
        { label: 'Current Stage', value: 'Scenario Simulator' },
        { label: 'Next Stage', value: 'Audit Trace' },
        { label: 'Mode', value: 'Safe Validation' },
        { label: 'Engine', value: 'Front-end Only' },
      ]}
    >
      <div className="grid gap-4 lg:grid-cols-2">
        {scenarios.map((scenario) => (
          <article key={scenario.title} className="border-2 border-[#8b4444] bg-[#1a1a1a]/60 p-4">
            <p className="text-[16px] font-bold text-[#e8d7c6]">{scenario.title}</p>
            <div className="mt-2 space-y-2 text-[14px] text-[#cfbfae]">
              <p><span className="font-semibold text-[#d4a574]">Current State:</span> {scenario.currentState}</p>
              <p><span className="font-semibold text-[#d4a574]">Proposed Change:</span> {scenario.proposedChange}</p>
              <p><span className="font-semibold text-[#d4a574]">Expected Outcome:</span> {scenario.expectedOutcome}</p>
              <p>
                <span className="font-semibold text-[#d4a574]">Risk Rating:</span>{' '}
                <span className={`inline-flex border px-2 py-0.5 font-mono text-[12px] ${riskClasses(scenario.riskRating as 'Low' | 'Moderate' | 'High')}`}>
                  {scenario.riskRating}
                </span>
              </p>
            </div>
          </article>
        ))}

        <div className="border-2 border-[#8b4444] bg-[#121212] p-4 lg:col-span-2">
          <p className="font-mono text-[12px] uppercase tracking-[0.15em] text-[#d4a574]">Flow Direction</p>
          <p className="mt-2 text-[16px] leading-7 text-[#e8d7c6]">Validated scenarios feed into Audit Trace for governance visibility before Source Control promotion.</p>
        </div>
      </div>
    </FeatureSurface>
  );
}