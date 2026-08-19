import Link from 'next/link';
import DevelopmentPipelineBanner from '@/components/DevelopmentPipelineBanner';
import ShadowChatButton from '@/components/ShadowChatButton';

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

/* Law 2/3: a risk rating is a genuine graded status, so it rides the status
   ladder -- and every rung carries a glyph plus an uppercase label so the
   scale survives greyscale board packets. */
function riskBadge(risk: 'Low' | 'Moderate' | 'High') {
  if (risk === 'Low') return { className: 'badge badge--cleared', glyph: '✓', label: 'Low Risk' };
  if (risk === 'Moderate') return { className: 'badge badge--restricted', glyph: '▲', label: 'Moderate Risk' };
  return { className: 'badge badge--locked', glyph: '✕', label: 'High Risk' };
}

const stats = [
  { label: 'Current Stage', value: 'Scenario Simulator' },
  { label: 'Next Stage', value: 'Audit Trace' },
  { label: 'Mode', value: 'Safe Validation' },
  { label: 'Engine', value: 'Front-end Only' },
];

export default function ScenarioSimulatorPage() {
  return (
    <main className="room room--file min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
      <header className="mat-leather--raised border-b border-[color:rgba(212,175,74,.22)] px-[var(--s5)] py-[var(--s5)]">
        <div className="mx-auto flex w-full max-w-[1200px] flex-wrap items-end justify-between gap-[var(--s4)]">
          <div>
            <p className="t-eyebrow">Scenario Simulator</p>
            <h1 className="t-command mt-[var(--s2)]" style={{ fontSize: 'var(--t-xl)' }}>
              Validation Sandbox
            </h1>
            <p className="t-body mt-[var(--s3)] max-w-[64ch]">
              Run front-end what-if scenarios to evaluate expected outcomes and risk before audit and promotion stages.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-[var(--s3)]">
            <ShadowChatButton context="Scenario Simulator" />
            <Link href="/audit" className="btn btn--ghost">
              Audit Trace
            </Link>
            <Link href="/knowledge-graph" className="btn btn--ghost">
              Knowledge Graph
            </Link>
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-[1200px] space-y-[var(--s5)] p-[var(--s5)]">
        <DevelopmentPipelineBanner currentStage="simulator" />

        <section aria-label="Simulator status" className="flex flex-wrap gap-[var(--s3)]">
          {stats.map((item) => (
            <span key={item.label} className="plaque">
              {item.label.toUpperCase()}: {item.value.toUpperCase()}
            </span>
          ))}
        </section>

        {/* Before/after scenario cards: each proposal is a typed sheet on the
            desk -- current state on the left, proposed change and its expected
            outcome on the right, the risk grade stamped on the ladder. */}
        <div className="grid gap-[var(--s4)] lg:grid-cols-2">
          {scenarios.map((scenario) => {
            const risk = riskBadge(scenario.riskRating as 'Low' | 'Moderate' | 'High');
            return (
              <article key={scenario.title} className="mat-paper rounded-[var(--r-md)] p-[var(--s5)]">
                <div className="flex flex-wrap items-start justify-between gap-[var(--s3)]">
                  <p className="t-typed text-[length:var(--t-md)] font-bold">{scenario.title}</p>
                  <span className={risk.className}>
                    <i>{risk.glyph}</i>
                    {risk.label}
                  </span>
                </div>
                <div className="mt-[var(--s4)] grid gap-[var(--s4)] sm:grid-cols-2">
                  <div>
                    <p className="font-mono text-[length:var(--t-xs)] font-bold uppercase tracking-[0.13em] text-[color:var(--hide-600)]">Current State</p>
                    <p className="t-typed mt-[var(--s2)] text-[length:var(--t-sm)] leading-relaxed">
                      {scenario.currentState}
                    </p>
                  </div>
                  <div className="border-l border-[color:rgba(51,41,27,.26)] pl-[var(--s4)]">
                    <p className="font-mono text-[length:var(--t-xs)] font-bold uppercase tracking-[0.13em] text-[color:var(--hide-600)]">Proposed Change</p>
                    <p className="t-typed mt-[var(--s2)] text-[length:var(--t-sm)] leading-relaxed">
                      {scenario.proposedChange}
                    </p>
                  </div>
                </div>
                <div className="mt-[var(--s4)] border-t border-[color:rgba(51,41,27,.26)] pt-[var(--s3)]">
                  <p className="font-mono text-[length:var(--t-xs)] font-bold uppercase tracking-[0.13em] text-[color:var(--hide-600)]">Expected Outcome</p>
                  <p className="t-typed mt-[var(--s2)] text-[length:var(--t-sm)] leading-relaxed">
                    {scenario.expectedOutcome}
                  </p>
                </div>
              </article>
            );
          })}

          <div className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)] lg:col-span-2">
            <p className="t-eyebrow">Flow Direction</p>
            <p className="t-body mt-[var(--s3)]">
              Validated scenarios feed into Audit Trace for governance visibility before Source Control promotion.
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
