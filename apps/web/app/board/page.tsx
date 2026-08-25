import BoardSeatDirectory from './BoardSeatDirectory';
import { BOARD_AGGREGATE_BOUNDARY_STATEMENT } from './boardWorkspaceConfig';
import BoardSummaryPanel from './BoardSummaryPanel';

export default function BoardHubPage() {
  return (
    /* ge-board: Golden Era Visual 008 scope. This class is the ONLY change on
       this route -- the framed parchment board, the riveted corner plates, the
       engraved plates the panels stand on and the plaqued seat links all live
       in scoped CSS under .ge-board in
       design-system/current/ppbf-golden-era.css. Every control, heading, seat
       card, aggregate state and refusal stamp on this page is untouched, and
       the room's own wall is left to its committed plate. */
    <main className="ge-board room room--board min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
        {/* The header sits on the board room's plaster upper wall, so it is
            written in dark ink rather than the bone type the leather panels
            below carry. The .t-* voices pin their own light colours, which is
            why the header composes the same ladder by hand. */}
        <header className="on-plaster flex flex-col gap-[var(--s4)] border-b-4 border-[color:var(--brass-700)] pb-[var(--s5)] md:flex-row md:items-end md:justify-between">
          <div className="space-y-[var(--s3)]">
            {/* "One board governance framework" and "role-aware visibility"
                described the build to the board rather than telling it what it
                is looking at. The room's own best copy is the register's "Read
                this zero correctly": say what the figure is, and say what it
                is not. */}
            <p className="t-eyebrow tracking-[0.35em]">Board Workspace</p>
            <h1 className="t-command text-[length:var(--t-2xl)] md:text-[length:var(--t-3xl)]">Board Hub</h1>
            <p className="t-body max-w-[80ch]">
              The organization&rsquo;s figures at the level a board is served them, and the way in to each seat. Every
              seat reads the same aggregate; what a seat holds is which pages it may open and the duties recorded
              against it.
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
