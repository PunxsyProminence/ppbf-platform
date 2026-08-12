'use client';

import { useMemo, useState } from 'react';

type ScenarioOption =
  | 'Delta RPE Lock Triggered'
  | 'Guardian Safety Gate Triggered'
  | 'Facility Capacity Lockdown'
  | 'Competition Readiness Freeze';

type QaEvent = {
  type: string;
  payload: string;
  timestamp: string;
};

const SCENARIOS: ScenarioOption[] = [
  'Delta RPE Lock Triggered',
  'Guardian Safety Gate Triggered',
  'Facility Capacity Lockdown',
  'Competition Readiness Freeze',
];

const QA_EVENTS: QaEvent[] = [
  {
    type: 'CONTROL_CHANGE',
    payload: 'Scenario player changed seed state',
    timestamp: '2026-08-11T16:00:00Z',
  },
  {
    type: 'GATE_TRIGGERED',
    payload: 'Global alert gate escalated to amber',
    timestamp: '2026-08-11T16:05:00Z',
  },
  {
    type: 'AUTOMATION_FLIP',
    payload: 'Automation mode toggled by QA operator',
    timestamp: '2026-08-11T16:09:00Z',
  },
  {
    type: 'READ_ONLY_TOGGLE',
    payload: 'Read-only panel state changed',
    timestamp: '2026-08-11T16:10:00Z',
  },
];

export default function DevToolsQAConsole() {
  const [isCollapsed, setIsCollapsed] = useState(true);
  const [scenario, setScenario] = useState<ScenarioOption>('Delta RPE Lock Triggered');
  const [seedVersion, setSeedVersion] = useState(1);
  const [historyIndex, setHistoryIndex] = useState(3);
  const [isReadOnlyView, setIsReadOnlyView] = useState(true);
  const [isClampGuardsEnabled, setIsClampGuardsEnabled] = useState(true);
  const [logFilter, setLogFilter] = useState('all');
  const [maxHistory, setMaxHistory] = useState(25);
  const [crossPanelAlert, setCrossPanelAlert] = useState('idle');
  const [automationMode, setAutomationMode] = useState(false);
  const [telemetryAction, setTelemetryAction] = useState<'idle' | 'exported' | 'imported' | 'clipboard-unsupported'>('idle');

  const telemetryJson = useMemo(
    () => JSON.stringify(
      {
        scenario,
        seedVersion,
        historyIndex,
        readOnlyView: isReadOnlyView,
        clampGuardrails: isClampGuardsEnabled,
        maxHistory,
        automationMode,
      },
      null,
      2,
    ),
    [automationMode, historyIndex, isClampGuardsEnabled, isReadOnlyView, maxHistory, scenario, seedVersion],
  );

  const beforeStateJson = useMemo(
    () => JSON.stringify({ scenario: 'Delta RPE Lock Triggered', automationMode: false, historyIndex: 2 }, null, 2),
    [],
  );

  const afterStateJson = useMemo(
    () => JSON.stringify({ scenario, automationMode, historyIndex }, null, 2),
    [automationMode, historyIndex, scenario],
  );

  const ruleTrace = useMemo(() => {
    const traceValue = Math.max(0, 100 - historyIndex * 7 + (automationMode ? 8 : 0) - (isClampGuardsEnabled ? 0 : 12));
    return `trace_score = max(0, 100 - (history_index*7) + automation_bonus - clamp_penalty) = ${traceValue}`;
  }, [automationMode, historyIndex, isClampGuardsEnabled]);

  const filteredEvents = useMemo(() => {
    if (logFilter === 'all') {
      return QA_EVENTS;
    }
    return QA_EVENTS.filter((event) => event.type === logFilter);
  }, [logFilter]);

  async function copyTelemetry() {
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      setTelemetryAction('clipboard-unsupported');
      return;
    }
    await navigator.clipboard.writeText(telemetryJson);
    setTelemetryAction('exported');
  }

  function importTelemetrySnapshot() {
    setHistoryIndex((prev) => Math.min(prev + 1, 99));
    setTelemetryAction('imported');
  }

  function regenerateSeededDataset() {
    setSeedVersion((prev) => prev + 1);
    setHistoryIndex(0);
  }

  function runUndo() {
    setHistoryIndex((prev) => Math.max(0, prev - 1));
  }

  function runRedo() {
    setHistoryIndex((prev) => Math.min(99, prev + 1));
  }

  function simulateCrossPanelAlert() {
    setCrossPanelAlert((prev) => (prev === 'active' ? 'idle' : 'active'));
  }

  return (
    <aside className="pointer-events-none fixed inset-x-0 bottom-0 z-50">
      <section className="pointer-events-auto w-full bg-black border-t border-zinc-800 rounded-none p-4 font-mono text-slate-300">
        <header className="mx-auto flex w-full max-w-7xl items-center justify-between border-b border-zinc-800 pb-3">
          <div>
            <p className="text-xs uppercase tracking-[0.25em] text-zinc-400">Layers 38 / 39 / 40</p>
            <h2 className="text-sm text-slate-200">QA Sandbox Console</h2>
          </div>
          <button
            type="button"
            onClick={() => setIsCollapsed((prev) => !prev)}
            className="border border-zinc-700 bg-black px-3 py-1 text-xs uppercase tracking-[0.2em] text-slate-200 hover:bg-zinc-900"
          >
            {isCollapsed ? 'Expand Console' : 'Collapse Console'}
          </button>
        </header>

        {!isCollapsed ? (
          <div className="mx-auto mt-3 grid w-full max-w-7xl gap-3 md:grid-cols-2 xl:grid-cols-4">
            <article className="border border-zinc-800 bg-black rounded-none p-3">
              <h3 className="text-xs uppercase tracking-[0.2em] text-zinc-400">Scenario Player</h3>
              <select
                value={scenario}
                onChange={(event) => setScenario(event.target.value as ScenarioOption)}
                className="mt-2 w-full border border-zinc-700 bg-black px-2 py-1 text-xs text-slate-200"
              >
                {SCENARIOS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </article>

            <article className="border border-zinc-800 bg-black rounded-none p-3">
              <h3 className="text-xs uppercase tracking-[0.2em] text-zinc-400">Telemetry Export/Import</h3>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={copyTelemetry}
                  className="border border-zinc-700 px-2 py-1 text-xs text-slate-200 hover:bg-zinc-900"
                >
                  Export
                </button>
                <button
                  type="button"
                  onClick={importTelemetrySnapshot}
                  className="border border-zinc-700 px-2 py-1 text-xs text-slate-200 hover:bg-zinc-900"
                >
                  Import
                </button>
              </div>
              <p className="mt-2 text-[11px] text-zinc-500">
                {telemetryAction === 'exported'
                  ? 'Telemetry exported to clipboard.'
                  : telemetryAction === 'imported'
                    ? 'Telemetry import simulated locally.'
                    : telemetryAction === 'clipboard-unsupported'
                    ? 'Clipboard API unavailable in this browser context.'
                    : 'Idle'}
              </p>
            </article>

            <article className="border border-zinc-800 bg-black rounded-none p-3">
              <h3 className="text-xs uppercase tracking-[0.2em] text-zinc-400">Seeded Random Data Generator</h3>
              <button
                type="button"
                onClick={regenerateSeededDataset}
                className="mt-2 w-full border border-zinc-700 px-2 py-1 text-xs text-slate-200 hover:bg-zinc-900"
              >
                [Regenerate Seeded Dataset]
              </button>
              <p className="mt-2 text-[11px] text-zinc-500">Current seed version: {seedVersion}</p>
            </article>

            <article className="border border-zinc-800 bg-black rounded-none p-3">
              <h3 className="text-xs uppercase tracking-[0.2em] text-zinc-400">State Diff Viewer</h3>
              <pre className="mt-2 h-28 overflow-auto border border-zinc-700 bg-black p-2 text-[11px] text-zinc-300">
{`before:\n${beforeStateJson}\n\nafter:\n${afterStateJson}`}
              </pre>
            </article>

            <article className="border border-zinc-800 bg-black rounded-none p-3">
              <h3 className="text-xs uppercase tracking-[0.2em] text-zinc-400">Rule Trace Engine</h3>
              <p className="mt-2 border border-zinc-700 bg-black p-2 text-[11px] text-zinc-300">
                {ruleTrace}
              </p>
            </article>

            <article className="border border-zinc-800 bg-black rounded-none p-3">
              <h3 className="text-xs uppercase tracking-[0.2em] text-zinc-400">Local Undo/Redo</h3>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={runUndo}
                  className="w-10 border border-zinc-700 px-2 py-1 text-xs text-slate-200 hover:bg-zinc-900"
                >
                  {'<'}
                </button>
                <button
                  type="button"
                  onClick={runRedo}
                  className="w-10 border border-zinc-700 px-2 py-1 text-xs text-slate-200 hover:bg-zinc-900"
                >
                  {'>'}
                </button>
              </div>
              <p className="mt-2 text-[11px] text-zinc-500">History index: {historyIndex}</p>
            </article>

            <article className="border border-zinc-800 bg-black rounded-none p-3">
              <h3 className="text-xs uppercase tracking-[0.2em] text-zinc-400">Read-Only View Toggle</h3>
              <label className="mt-2 flex items-center justify-between border border-zinc-700 px-2 py-1 text-xs">
                <span>Read-only mode</span>
                <input
                  type="checkbox"
                  checked={isReadOnlyView}
                  onChange={(event) => setIsReadOnlyView(event.target.checked)}
                  className="h-4 w-4 accent-zinc-500"
                />
              </label>
            </article>

            <article className="border border-zinc-800 bg-black rounded-none p-3">
              <h3 className="text-xs uppercase tracking-[0.2em] text-zinc-400">Data Entry Clamping Guardrails</h3>
              <label className="mt-2 flex items-center justify-between border border-zinc-700 px-2 py-1 text-xs">
                <span>Clamp out-of-range inputs</span>
                <input
                  type="checkbox"
                  checked={isClampGuardsEnabled}
                  onChange={(event) => setIsClampGuardsEnabled(event.target.checked)}
                  className="h-4 w-4 accent-zinc-500"
                />
              </label>
            </article>

            <article className="border border-zinc-800 bg-black rounded-none p-3">
              <h3 className="text-xs uppercase tracking-[0.2em] text-zinc-400">Audit Event Typing</h3>
              <select
                value={logFilter}
                onChange={(event) => setLogFilter(event.target.value)}
                className="mt-2 w-full border border-zinc-700 bg-black px-2 py-1 text-xs text-slate-200"
              >
                <option value="all">all</option>
                <option value="CONTROL_CHANGE">CONTROL_CHANGE</option>
                <option value="GATE_TRIGGERED">GATE_TRIGGERED</option>
                <option value="AUTOMATION_FLIP">AUTOMATION_FLIP</option>
                <option value="READ_ONLY_TOGGLE">READ_ONLY_TOGGLE</option>
              </select>
              <p className="mt-2 text-[11px] text-zinc-500">Visible logs: {filteredEvents.length}</p>
            </article>

            <article className="border border-zinc-800 bg-black rounded-none p-3">
              <h3 className="text-xs uppercase tracking-[0.2em] text-zinc-400">Drawer Performance Controls</h3>
              <label htmlFor="max-history" className="mt-2 block text-[11px] text-zinc-500">Max History</label>
              <select
                id="max-history"
                value={maxHistory}
                onChange={(event) => setMaxHistory(Number(event.target.value))}
                className="mt-1 w-full border border-zinc-700 bg-black px-2 py-1 text-xs text-slate-200"
              >
                <option value={10}>10</option>
                <option value={25}>25</option>
                <option value={50}>50</option>
              </select>
            </article>

            <article className="border border-zinc-800 bg-black rounded-none p-3">
              <h3 className="text-xs uppercase tracking-[0.2em] text-zinc-400">Cross-Panel Gate Reflection</h3>
              <button
                type="button"
                onClick={simulateCrossPanelAlert}
                className="mt-2 w-full border border-zinc-700 px-2 py-1 text-xs text-slate-200 hover:bg-zinc-900"
              >
                [Simulate Global Alert]
              </button>
              <p className={`mt-2 text-[11px] ${crossPanelAlert === 'active' ? 'text-[#b91c1c] animate-pulse' : 'text-zinc-500'}`}>
                Alert state: {crossPanelAlert}
              </p>
            </article>

            <article className="border border-zinc-800 bg-black rounded-none p-3">
              <h3 className="text-xs uppercase tracking-[0.2em] text-zinc-400">Automation Mode</h3>
              <label className="mt-2 flex items-center justify-between border border-zinc-700 px-2 py-1 text-xs">
                <span>Auto-advance QA cycles</span>
                <input
                  type="checkbox"
                  data-testid="qa-automation-toggle"
                  checked={automationMode}
                  onChange={(event) => setAutomationMode(event.target.checked)}
                  className="h-4 w-4 accent-zinc-500"
                />
              </label>
            </article>
          </div>
        ) : null}
      </section>
    </aside>
  );
}
