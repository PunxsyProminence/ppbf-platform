import Link from 'next/link';
import type { ReactNode } from 'react';
import DevelopmentPipelineBanner, { type PipelineStageKey } from '@/components/DevelopmentPipelineBanner';

interface FeatureSurfaceProps {
  eyebrow: string;
  title: string;
  description: string;
  status: string;
  currentStage?: PipelineStageKey;
  primaryLinks: Array<{ label: string; href: string }>;
  stats: Array<{ label: string; value: string }>;
  children?: ReactNode;
}

export default function FeatureSurface({
  eyebrow,
  title,
  description,
  status,
  currentStage,
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
    <main className="min-h-screen bg-[#0a0a0a] text-[#e8d7c6]">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-6 py-10 lg:px-10">
        <header className="flex flex-col gap-4 border-b-4 border-[#8b4444] pb-6 md:flex-row md:items-end md:justify-between">
          <div className="space-y-3">
            <p className="text-xs font-mono uppercase tracking-[0.35em] text-[#d4a574]">{eyebrow}</p>
            <h1 className="font-display text-4xl tracking-tight text-[#e8d7c6] md:text-5xl">{title}</h1>
            <p className="max-w-3xl text-sm leading-6 text-[#b0a095] md:text-base">{description}</p>
          </div>
          <div className="border-2 border-[#8b4444] bg-[#1a1a1a] px-4 py-3 text-xs font-mono text-[#e8d7c6] shadow-2xl shadow-black/70">
            Status: {status}
          </div>
        </header>

        {currentStage && (
          <div className="mt-6">
            <DevelopmentPipelineBanner currentStage={currentStage} />
          </div>
        )}

        <section className="mt-8 grid gap-6 lg:grid-cols-[1.35fr_0.85fr]">
          <div className="border-4 border-[#3d2817] bg-[#1a1a1a] p-6 shadow-2xl shadow-black/70">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {stats.map((item) => (
                <div key={item.label} className="border-2 border-[#5a4a3a] bg-[#0f0f0f] p-4">
                  <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-[#b0a095]">{item.label}</p>
                  <p className="mt-2 text-xl font-black text-[#e8d7c6]">{item.value}</p>
                </div>
              ))}
            </div>

            <div className="mt-6 border-2 border-[#8b4444] bg-[#0f0f0f] p-5">
              {children}
            </div>
          </div>

          <aside className="grid gap-6">
            <section className="border-4 border-[#3d2817] bg-[#1a1a1a] p-6 shadow-2xl shadow-black/70">
              <h2 className="font-display text-lg tracking-tight text-[#e8d7c6]">Quick links</h2>
              <div className="mt-4 grid gap-3">
                {quickLinks.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="border-2 border-[#5a4a3a] bg-[#0f0f0f] px-4 py-3 text-sm text-[#e8d7c6] transition hover:border-[#d4a574] hover:bg-[#3d2817]"
                  >
                    {item.label}
                  </Link>
                ))}
              </div>
            </section>

            <section className="border-4 border-[#8b4444] bg-[#3d2817] p-6 text-sm text-[#e8d7c6] shadow-2xl shadow-black/70">
              <h2 className="font-display text-lg tracking-tight text-[#e8d7c6]">Front-end status</h2>
              <p className="mt-3 leading-6 text-[#e8d7c6]">
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