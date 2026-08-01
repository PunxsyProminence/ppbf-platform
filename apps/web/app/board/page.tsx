import BoardSeatDirectory from './BoardSeatDirectory';
import { BOARD_AGGREGATE_BOUNDARY_STATEMENT } from './boardWorkspaceConfig';
import BoardSummaryPanel from './BoardSummaryPanel';

export default function BoardHubPage() {
  return (
    <main className="min-h-screen bg-[#0a0a0a] text-[#e8d7c6]">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-6 py-10 lg:px-10">
        <header className="flex flex-col gap-4 border-b-4 border-[#8b4444] pb-6 md:flex-row md:items-end md:justify-between">
          <div className="space-y-3">
            <p className="text-xs font-mono uppercase tracking-[0.35em] text-[#d4a574]/80">Board Hub</p>
            <h1 className="text-4xl font-black tracking-tight md:text-5xl">One board governance framework</h1>
            <p className="max-w-4xl text-base leading-7 text-[#cbb8a8] md:text-lg">
              Board Hub is the board seat directory, governance control surface, and mission oversight launcher. Every seat opens the same board workspace shell with role-aware visibility for nonprofit governance.
            </p>
          </div>
        </header>

        <section className="mt-8 border-2 border-[#8b4444] bg-[#121212] p-5">
          <h2 className="text-lg font-black text-[#e8d7c6]">Aggregate boundary</h2>
          <p className="mt-3 max-w-4xl text-sm leading-6 text-[#cbb8a8]">
            {BOARD_AGGREGATE_BOUNDARY_STATEMENT}
          </p>
        </section>

        <div className="mt-8">
          <BoardSummaryPanel variant="hub" heading="Board Hub Aggregate" />
        </div>

        <BoardSeatDirectory />
      </div>
    </main>
  );
}
