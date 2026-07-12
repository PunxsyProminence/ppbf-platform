import Link from 'next/link';
import { boardOverviewStrip, boardSeatConfigs } from './boardWorkspaceConfig';

export default function BoardHubPage() {
  return (
    <main className="min-h-screen bg-[#0a0a0a] text-[#e8d7c6]">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-6 py-10 lg:px-10">
        <header className="flex flex-col gap-4 border-b-4 border-[#8b4444] pb-6 md:flex-row md:items-end md:justify-between">
          <div className="space-y-3">
            <p className="text-xs font-mono uppercase tracking-[0.35em] text-[#d4a574]/80">Board Hub</p>
            <h1 className="text-4xl font-black tracking-tight md:text-5xl">One board workspace framework</h1>
            <p className="max-w-4xl text-base leading-7 text-[#cbb8a8] md:text-lg">
              Board Hub is the board seat directory, role-definition surface, workspace launcher, and governance control surface. Every seat opens the same board workspace shell with role-aware visibility.
            </p>
          </div>
          <Link
            href="/operations"
            className="inline-flex min-h-[44px] items-center justify-center border-2 border-[#8b4444] bg-[#5a2a2a]/10 px-4 py-2 text-sm font-mono font-bold text-[#d4a574] transition hover:bg-[#5a2a2a]/20 hover:text-[#d4a574]"
          >
            Operations Hub
          </Link>
        </header>

        <section className="mt-8 border-2 border-[#8b4444] bg-[#121212] p-5">
          <p className="text-xs font-mono uppercase tracking-[0.28em] text-[#d4a574]">Board Overview Strip</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
            {boardOverviewStrip.map((item) => (
              <article key={item.label} className="border border-[#654535] bg-[#0d0d0d] p-3">
                <p className="text-[12px] font-mono uppercase tracking-[0.14em] text-[#aa9484]">{item.label}</p>
                <p className="mt-2 text-[22px] font-black text-[#e8d7c6]">{item.value}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {boardSeatConfigs.map((seat) => (
            <article key={seat.slug} className="border-2 border-[#8b4444] bg-[#0f0f0f]/80 p-5">
              <p className="text-[12px] font-mono uppercase tracking-[0.2em] text-[#8f7f72]">Board Seat</p>
              <h2 className="mt-2 text-2xl font-black text-[#e8d7c6]">{seat.seatLabel}</h2>

              <div className="mt-4 space-y-3">
                <div>
                  <p className="text-[12px] font-mono uppercase tracking-[0.15em] text-[#d4a574]">Role Description</p>
                  <p className="mt-1 text-[15px] leading-6 text-[#cbb8a8]">{seat.roleDescription}</p>
                </div>

                <div>
                  <p className="text-[12px] font-mono uppercase tracking-[0.15em] text-[#d4a574]">Primary Responsibilities</p>
                  <ul className="mt-1 space-y-1 text-[14px] leading-6 text-[#cbb8a8]">
                    {seat.primaryResponsibilities.map((responsibility) => (
                      <li key={responsibility}>- {responsibility}</li>
                    ))}
                  </ul>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="border border-[#654535] bg-[#111111] p-2">
                    <p className="text-[11px] font-mono uppercase tracking-[0.12em] text-[#8f7f72]">Open Tasks</p>
                    <p className="mt-1 text-xl font-black text-[#e8d7c6]">{seat.openTasksCount}</p>
                  </div>
                  <div className="border border-[#654535] bg-[#111111] p-2">
                    <p className="text-[11px] font-mono uppercase tracking-[0.12em] text-[#8f7f72]">Pending Reviews</p>
                    <p className="mt-1 text-xl font-black text-[#e8d7c6]">{seat.pendingReviewsCount}</p>
                  </div>
                  <div className="border border-[#654535] bg-[#111111] p-2">
                    <p className="text-[11px] font-mono uppercase tracking-[0.12em] text-[#8f7f72]">Meeting Items</p>
                    <p className="mt-1 text-xl font-black text-[#e8d7c6]">{seat.meetingItemsCount}</p>
                  </div>
                  <div className="border border-[#654535] bg-[#111111] p-2">
                    <p className="text-[11px] font-mono uppercase tracking-[0.12em] text-[#8f7f72]">Compliance Items</p>
                    <p className="mt-1 text-xl font-black text-[#e8d7c6]">{seat.complianceItemsCount}</p>
                  </div>
                </div>
              </div>

              <Link
                href={`/board/${seat.slug}/`}
                className="mt-4 inline-flex min-h-[44px] items-center justify-center border-2 border-[#8b4444] bg-[#2f1717] px-4 text-sm font-mono font-bold uppercase tracking-[0.14em] text-[#e8d7c6] transition hover:border-[#d4a574] hover:text-[#d4a574]"
              >
                Open Workspace
              </Link>
            </article>
          ))}
        </section>
      </div>
    </main>
  );
}