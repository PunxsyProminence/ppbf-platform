import BoardSeatDirectory from './BoardSeatDirectory';
import { BOARD_AGGREGATE_BOUNDARY_STATEMENT } from './boardWorkspaceConfig';
import BoardSummaryPanel from './BoardSummaryPanel';

export default function BoardHubPage() {
  return (
    <main className="room--board min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
        {/* The header sits on the board room's plaster upper wall, so it is
            written in dark ink rather than the bone type the leather panels
            below carry. The .t-* voices pin their own light colours, which is
            why the header composes the same ladder by hand. */}
        <header className="on-plaster flex flex-col gap-[var(--s4)] border-b-4 border-[color:var(--brass-700)] pb-[var(--s5)] md:flex-row md:items-end md:justify-between">
          <div className="space-y-[var(--s3)]">
            <p className="t-eyebrow tracking-[0.35em]">Board Hub</p>
            <h1 className="t-command text-[length:var(--t-2xl)] md:text-[length:var(--t-3xl)]">One board governance framework</h1>
            <p className="t-body max-w-[80ch]">
              Board Hub is the board seat directory, governance control surface, and mission oversight launcher. Every seat opens the same board workspace shell with role-aware visibility for nonprofit governance.
            </p>
          </div>
        </header>

        <section className="mat-leather mt-[var(--s5)] rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
          <h2 className="t-command text-[length:var(--t-md)]">Aggregate boundary</h2>
          <p className="t-body mt-[var(--s3)] max-w-[80ch]">
            {BOARD_AGGREGATE_BOUNDARY_STATEMENT}
          </p>
        </section>

        <div className="mt-[var(--s5)]">
          <BoardSummaryPanel variant="hub" heading="Board Hub Aggregate" />
        </div>

        <BoardSeatDirectory />
      </div>
    </main>
  );
}
