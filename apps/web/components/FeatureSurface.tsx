import Link from 'next/link';
import type { ReactNode } from 'react';

interface FeatureSurfaceProps {
  eyebrow: string;
  title: string;
  description: string;
  status: string;
  primaryLinks: Array<{ label: string; href: string }>;
  stats: Array<{ label: string; value: string }>;
  children?: ReactNode;
}

export default function FeatureSurface({
  eyebrow,
  title,
  description,
  status,
  primaryLinks,
  stats,
  children,
}: FeatureSurfaceProps) {
  const quickLinks = [
    ...primaryLinks,
    { label: 'Operations Hub', href: '/operations' },
    { label: 'Launch Portal', href: '/launch' },
  ].filter((link, index, all) => all.findIndex((item) => item.href === link.href) === index);

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.14),_transparent_32%),linear-gradient(180deg,#020617_0%,#0b1120_100%)] text-slate-100">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-6 py-10 lg:px-10">
        <header className="flex flex-col gap-4 border-b border-slate-800 pb-6 md:flex-row md:items-end md:justify-between">
          <div className="space-y-3">
            <p className="text-xs font-mono uppercase tracking-[0.35em] text-emerald-300/80">{eyebrow}</p>
            <h1 className="text-4xl font-black tracking-tight md:text-5xl">{title}</h1>
            <p className="max-w-3xl text-sm leading-6 text-slate-300 md:text-base">{description}</p>
          </div>
          <div className="rounded-2xl border border-emerald-500/20 bg-slate-950/60 px-4 py-3 text-xs font-mono text-emerald-200 shadow-lg shadow-emerald-950/20">
            Status: {status}
          </div>
        </header>

        <section className="mt-8 grid gap-6 lg:grid-cols-[1.35fr_0.85fr]">
          <div className="rounded-3xl border border-slate-800 bg-slate-950/70 p-6 shadow-2xl shadow-black/20">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {stats.map((item) => (
                <div key={item.label} className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
                  <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-slate-500">{item.label}</p>
                  <p className="mt-2 text-xl font-black text-slate-100">{item.value}</p>
                </div>
              ))}
            </div>

            <div className="mt-6 rounded-3xl border border-slate-800 bg-slate-900/60 p-5">
              {children}
            </div>
          </div>

          <aside className="grid gap-6">
            <section className="rounded-3xl border border-slate-800 bg-slate-950/70 p-6">
              <h2 className="text-lg font-semibold text-slate-100">Quick links</h2>
              <div className="mt-4 grid gap-3">
                {quickLinks.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="rounded-2xl border border-slate-800 bg-slate-900/60 px-4 py-3 text-sm text-slate-200 transition hover:border-emerald-500/30 hover:bg-emerald-500/10 hover:text-emerald-200"
                  >
                    {item.label}
                  </Link>
                ))}
              </div>
            </section>

            <section className="rounded-3xl border border-cyan-500/20 bg-cyan-500/10 p-6 text-sm text-cyan-50">
              <h2 className="text-lg font-semibold text-cyan-50">Front-end status</h2>
              <p className="mt-3 leading-6 text-cyan-50/90">
                This route is a live scaffold for one of the missing capability surfaces. It is intentionally simple,
                production-safe, and ready for richer workflows later.
              </p>
            </section>
          </aside>
        </section>
      </div>
    </main>
  );
}