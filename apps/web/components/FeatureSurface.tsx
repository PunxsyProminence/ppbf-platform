import Link from 'next/link';
import type { ReactNode } from 'react';
import DevelopmentPipelineBanner, { type PipelineStageKey } from '@/components/DevelopmentPipelineBanner';
import ShadowChatButton from '@/components/ShadowChatButton';

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
    <main className="on-canvas min-h-screen">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-6 py-10 lg:px-10">
        <header className="flex flex-col gap-[var(--s4)] border-b-2 border-[color:var(--brass-700)] pb-[var(--s5)] md:flex-row md:items-end md:justify-between">
          <div className="space-y-3">
            <p className="t-eyebrow tracking-[0.35em]">{eyebrow}</p>
            <h1 className="t-command">{title}</h1>
            <p className="t-body max-w-[72ch]">{description}</p>
          </div>
          <div className="rounded-[var(--r-sm)] border border-[color:rgba(212,175,74,.28)] px-[var(--s4)] py-[var(--s3)] t-data">
            Status: {status}
          </div>
        </header>

        {currentStage && (
          <div className="mt-6">
            <DevelopmentPipelineBanner currentStage={currentStage} />
          </div>
        )}

        <section className="mt-8 grid gap-6 lg:grid-cols-[1.35fr_0.85fr]">
          <div className="rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.28)] p-[var(--s5)]">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {stats.map((item) => (
                <div key={item.label} className="rounded-[var(--r-md)] border border-[color:rgba(212,175,74,.24)] p-[var(--s4)]">
                  <p className="t-label">{item.label}</p>
                  <p className="t-command mt-[var(--s3)]">{item.value}</p>
                </div>
              ))}
            </div>

            <div className="mt-[var(--s5)] rounded-[var(--r-md)] border border-[color:rgba(212,175,74,.24)] p-[var(--s5)]">
              {children}
            </div>
          </div>

          <aside className="grid gap-6">
            <section className="rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.28)] p-[var(--s5)]">
              <h2 className="t-command">Quick links</h2>
              <div className="mt-3">
                <ShadowChatButton context={`${eyebrow} ${title}`} />
              </div>
              <div className="mt-4 grid gap-3">
                {quickLinks.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="btn btn--ghost w-full justify-start text-left"
                  >
                    {item.label}
                  </Link>
                ))}
              </div>
            </section>

            <section className="rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.28)] p-[var(--s5)]">
              <h2 className="t-command">Front-end status</h2>
              <p className="t-body mt-[var(--s3)]">
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