import Link from 'next/link';

export default function HomePage() {
  return (
    <div className="min-h-screen bg-slate-950 text-white font-sans flex flex-col">
      {/* Global Application Header */}
      <header className="bg-slate-900 border-b border-slate-800 px-6 py-4 flex justify-between items-center">
        <div className="flex items-center space-x-3">
          <div className="bg-emerald-500 text-slate-950 p-2 rounded-lg font-black text-xl">PP</div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-slate-100">PPBF Platform</h1>
            <p className="text-xs text-emerald-400 font-mono font-semibold">Active Layer 0 Governance</p>
          </div>
        </div>
        <div className="flex items-center space-x-2 bg-slate-800 px-3 py-1 rounded-full border border-slate-700 text-xs font-mono text-slate-300">
          <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse"></span>
          <span>v2.0.0-ACTIVE</span>
        </div>
      </header>

      {/* Primary Control Hub Grid */}
      <main className="flex-1 max-w-5xl w-full mx-auto p-6 md:p-10 space-y-8">
        <div className="space-y-2">
          <h2 className="text-3xl font-extrabold text-slate-100">Unified Management Portal</h2>
          <p className="text-slate-400 max-w-2xl">
            Welcome back. Select an authorized operational context from the system index below to route into active feature frameworks.
          </p>
        </div>

        {/* Section: Core Operational Portals */}
        <div className="space-y-4">
          <h3 className="text-sm font-bold uppercase tracking-wider text-slate-400">Environment View Management</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            
            {/* Athlete Portal Card */}
            <div className="bg-slate-900 border border-slate-800 p-6 rounded-xl hover:border-slate-700 transition flex flex-col justify-between">
              <div className="space-y-2">
                <div className="text-2xl">💪</div>
                <h4 className="text-lg font-bold text-slate-100">Participant Environment</h4>
                <p className="text-sm text-slate-400">Access your active metrics tracking, schedule profiles, and target execution logs.</p>
              </div>
              <div className="mt-6 pt-4 border-t border-slate-800 flex space-x-3">
                <Link href="/athlete/dashboard" className="text-xs bg-emerald-600 hover:bg-emerald-500 text-white font-bold px-4 py-2 rounded transition">
                  Dashboard
                </Link>
                <Link href="/athlete/dashboard/sparring" className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium px-4 py-2 rounded transition border border-slate-700">
                  Sparring Ledger
                </Link>
              </div>
            </div>

            {/* Coach Review Card */}
            <div className="bg-slate-900 border border-slate-800 p-6 rounded-xl hover:border-slate-700 transition flex flex-col justify-between">
              <div className="space-y-2">
                <div className="text-2xl">📋</div>
                <h4 className="text-lg font-bold text-slate-100">Staff & Coach Environment</h4>
                <p className="text-sm text-slate-400">Manage incoming athlete profiles, analyze evaluation data, and clear security matrices.</p>
              </div>
              <div className="mt-6 pt-4 border-t border-slate-800 flex space-x-3">
                <Link href="/coach/review-queue" className="text-xs bg-indigo-600 hover:bg-indigo-500 text-white font-bold px-4 py-2 rounded transition">
                  Review Queue
                </Link>
                <Link href="/coach/environment/intake-router" className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium px-4 py-2 rounded transition border border-slate-700">
                  Intake Router
                </Link>
              </div>
            </div>

          </div>
        </div>

        {/* Section: System Operations */}
        <div className="space-y-4 pt-4">
          <h3 className="text-sm font-bold uppercase tracking-wider text-slate-400">Platform Core</h3>
          <div className="bg-slate-900 border border-slate-800 p-4 rounded-xl flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <div className="text-xl">⚙️</div>
              <div>
                <h4 className="text-sm font-bold text-slate-200">System Administration Configuration</h4>
                <p className="text-xs text-slate-400">Configure global layer variables, audit continuity ledgers, and manage security parameters.</p>
              </div>
            </div>
            <Link href="/admin" className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 font-bold px-4 py-2 rounded transition whitespace-nowrap">
              Open Admin Pane
            </Link>
          </div>
        </div>
      </main>

      {/* Global System Footer */}
      <footer className="bg-slate-950 border-t border-slate-900 px-6 py-4 text-center text-xs text-slate-500">
        Secure Bounded Context Enforced • Punxsy Prominence Organization © 2026
      </footer>
    </div>
  );
}
