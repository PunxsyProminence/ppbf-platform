import Link from 'next/link';
import type { ReactNode } from 'react';
import DevelopmentPipelineBanner, { type PipelineStageKey } from '@/components/DevelopmentPipelineBanner';

interface FeatureSurfaceProps {
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
  readonly status: string;
  readonly currentStage?: PipelineStageKey;
  readonly primaryLinks: Array<{ label: string; href: string }>;
  readonly stats: Array<{ label: string; value: string }>;
  readonly children?: ReactNode;
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
    { label: 'Member Access', href: '/login' },
  ].filter((link, index, all) => all.findIndex((item) => item.href === link.href) === index);

  return (
    <main className="min-h-screen bg-[var(--canvas-tan)] text-[var(--black)]">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-6 py-10 lg:px-10">
        <header className="flex flex-col gap-4 border-b-[3px] border-[var(--black)] pb-6 md:flex-row md:items-end md:justify-between">
          <div className="space-y-3">
            <p className="text-xs font-mono uppercase tracking-[0.35em] text-[var(--red-primary)]">{eyebrow}</p>
            <h1 className="font-display text-4xl tracking-tight text-[var(--black)] md:text-5xl">{title}</h1>
            <p className="max-w-3xl text-sm leading-6 text-[var(--gray-dark)] md:text-base">{description}</p>
          </div>
          <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-4 py-3 text-xs font-mono text-[var(--black)] shadow-[var(--shadow-sm)]">
            Status: {status}
          </div>
        </header>

        {currentStage && (
          <div className="mt-6">
            <DevelopmentPipelineBanner currentStage={currentStage} />
          </div>
        )}

        <section className="mt-8 grid gap-6 lg:grid-cols-[1.35fr_0.85fr]">
          <div className="border-[3px] border-[var(--black)] bg-[var(--canvas-tan-light)] p-6 shadow-[var(--shadow-md)]">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {stats.map((item) => (
                <div key={item.label} className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-4">
                  <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-[var(--gray-medium)]">{item.label}</p>
                  <p className="mt-2 text-xl font-black text-[var(--black)]">{item.value}</p>
                </div>
              ))}
            </div>

            <div className="mt-6 border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-5">
              {children}
            </div>
          </div>

          <aside className="grid gap-6">
            <section className="border-[3px] border-[var(--black)] bg-[var(--canvas-tan-light)] p-6 shadow-[var(--shadow-md)]">
              <h2 className="font-display text-lg tracking-tight text-[var(--black)]">Quick links</h2>
              <div className="mt-4 grid gap-3">
                {quickLinks.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-4 py-3 text-sm text-[var(--black)] transition hover:bg-[var(--olive-dark)] hover:text-[var(--white)]"
                  >
                    {item.label}
                  </Link>
                ))}
              </div>
            </section>

            <section className="border-[3px] border-[var(--black)] bg-[var(--red-primary)] p-6 text-sm text-[var(--white)] shadow-[var(--shadow-md)]">
              <h2 className="font-display text-lg tracking-tight text-[var(--white)]">Front-end status</h2>
              <p className="mt-3 leading-6 text-[var(--white-off)]">
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