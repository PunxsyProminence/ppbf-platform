import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Punxsy Prominence Boxing & Fitness",
  description:
    "Punxsy Prominence Boxing & Fitness is an IRS-recognized 501(c)(3) nonprofit using structured boxing and athlete-development programming to serve youth in Punxsutawney and surrounding rural western Pennsylvania communities. Children participate at no charge.",
};

const structuredData = {
  "@context": "https://schema.org",
  "@type": "NGO",
  name: "Punxsy Prominence Boxing & Fitness",
  alternateName: "PPBF",
  description:
    "IRS-recognized 501(c)(3) nonprofit using structured boxing and athlete-development programming to help young people build discipline, confidence, accountability, and practical life skills.",
  email: "admin@punxsyprominence.org",
  areaServed: {
    "@type": "Place",
    name: "Punxsutawney and surrounding rural Pennsylvania communities",
  },
  founder: {
    "@type": "Person",
    name: "Jason Neale",
    jobTitle: "Head Coach/Governor",
  },
};

const programs = [
  {
    title: "Safety-Focused Youth Development",
    description:
      "Every program is built around age-appropriate safety, supervision, and structured progression from day one.",
  },
  {
    title: "Non-Contact Foundational Instruction",
    description:
      "New athletes start with non-contact fundamentals: footwork, technique, and conditioning before anything else.",
  },
  {
    title: "Progressive Technical Training",
    description:
      "Athletes advance at their own pace through structured skill-building as coaches confirm readiness.",
  },
  {
    title: "Optional Competitive Pathways",
    description:
      "Athletes who are ready and choose to compete have a pathway available. Competing is never required to participate.",
  },
  {
    title: "Coaching & Mentorship",
    description:
      "Coaches mentor athletes on academic responsibility, leadership, decision-making, and community involvement.",
  },
];

export default function HomePage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />
      <main className="min-h-screen bg-[var(--canvas-tan)] text-[var(--black)]">
        {/* Hero */}
        <section className="border-b-[3px] border-[var(--black)] bg-[var(--canvas-tan-light)] px-6 py-16 lg:px-10 lg:py-24">
          <div className="mx-auto flex w-full max-w-5xl flex-col items-center text-center">
            <p className="text-xs font-mono uppercase tracking-[0.35em] text-[var(--red-primary)]">
              Punxsy Prominence Boxing &amp; Fitness
            </p>
            <h1 className="font-display mt-4 text-4xl font-black tracking-tight md:text-6xl">
              Boxing is the engagement platform.
              <br />
              Youth development is the objective.
            </h1>
            <p className="mt-6 max-w-3xl text-base leading-7 text-[var(--gray-dark)] md:text-lg">
              Punxsy Prominence Boxing &amp; Fitness is an IRS-recognized 501(c)(3) nonprofit serving youth in
              Punxsutawney and surrounding rural western Pennsylvania communities.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
              <Link
                href="/login"
                className="inline-flex min-h-[52px] items-center justify-center rounded-full border-2 border-[var(--black)] bg-[var(--red-primary)] px-8 shadow-[var(--shadow-md)] transition hover:bg-[var(--red-highlight)]"
              >
                <span className="text-sm font-black uppercase tracking-[0.15em] text-[var(--white)]">Log In</span>
              </Link>
              <a
                href="#programs"
                className="group inline-flex min-h-[52px] items-center justify-center rounded-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-8 shadow-[var(--shadow-sm)] transition hover:bg-[var(--canvas-tan-dark)]"
              >
                <span className="text-sm font-black uppercase tracking-[0.15em] text-[var(--black)] transition group-hover:text-[var(--white)]">
                  Learn About Our Programs
                </span>
              </a>
            </div>
          </div>
        </section>

        {/* Mission */}
        <section id="mission" aria-labelledby="mission-heading" className="px-6 py-16 lg:px-10">
          <div className="mx-auto w-full max-w-4xl">
            <h2 id="mission-heading" className="text-3xl font-black md:text-4xl">
              Our Mission
            </h2>
            <p className="mt-5 text-base leading-7 text-[var(--gray-dark)] md:text-lg">
              Punxsy Prominence uses structured boxing and athlete-development programming to help young people build
              discipline, confidence, accountability, emotional control, physical fitness, academic responsibility,
              leadership, decision-making, and practical life skills.
            </p>
            <p className="mt-6 border-l-[6px] border-[var(--red-primary)] bg-[var(--canvas-tan-light)] p-5 text-lg font-bold leading-7 md:text-xl">
              Children participate at no charge. Financial circumstances do not determine whether a child can train.
            </p>
          </div>
        </section>

        {/* Programs */}
        <section
          id="programs"
          aria-labelledby="programs-heading"
          className="border-y-[3px] border-[var(--black)] bg-[var(--canvas-tan-light)] px-6 py-16 lg:px-10"
        >
          <div className="mx-auto w-full max-w-5xl">
            <h2 id="programs-heading" className="text-3xl font-black md:text-4xl">
              Programs
            </h2>
            <p className="mt-4 max-w-3xl text-base leading-7 text-[var(--gray-dark)]">
              Every athlete progresses at their own pace. Sparring and competition are optional next steps for
              athletes who are ready and choose that path &mdash; not a requirement of participation.
            </p>
            <div className="mt-8 grid gap-4 md:grid-cols-2">
              {programs.map((program) => (
                <article
                  key={program.title}
                  className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-5 shadow-[var(--shadow-sm)]"
                >
                  <h3 className="text-lg font-bold">{program.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">{program.description}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* Technology */}
        <section id="technology" aria-labelledby="technology-heading" className="px-6 py-16 lg:px-10">
          <div className="mx-auto w-full max-w-4xl">
            <h2 id="technology-heading" className="text-3xl font-black md:text-4xl">
              Technology Supporting Development
            </h2>
            <p className="mt-5 text-base leading-7 text-[var(--gray-dark)] md:text-lg">
              Punxsy Prominence is developing the SHADOW application to support coaching, athlete development,
              program access, progress tracking, evidence-informed learning, and continuous organizational
              improvement. SHADOW is a decision-support and learning system in development; it does not replace
              coaches, medical professionals, or responsible human decision-making.
            </p>
          </div>
        </section>

        {/* Nonprofit and Leadership Information */}
        <section
          id="about"
          aria-labelledby="about-heading"
          className="border-y-[3px] border-[var(--black)] bg-[var(--canvas-tan-light)] px-6 py-16 lg:px-10"
        >
          <div className="mx-auto w-full max-w-4xl">
            <h2 id="about-heading" className="text-3xl font-black md:text-4xl">
              Nonprofit &amp; Leadership
            </h2>
            <dl className="mt-6 grid gap-5 md:grid-cols-2">
              <div>
                <dt className="text-xs font-mono uppercase tracking-[0.2em] text-[var(--gray-medium)]">
                  Legal Name
                </dt>
                <dd className="mt-1 text-base font-semibold">Punxsy Prominence Boxing &amp; Fitness</dd>
              </div>
              <div>
                <dt className="text-xs font-mono uppercase tracking-[0.2em] text-[var(--gray-medium)]">
                  Organization Type
                </dt>
                <dd className="mt-1 text-base font-semibold">IRS-recognized 501(c)(3) nonprofit</dd>
              </div>
              <div>
                <dt className="text-xs font-mono uppercase tracking-[0.2em] text-[var(--gray-medium)]">
                  Primary Service Area
                </dt>
                <dd className="mt-1 text-base font-semibold">
                  Punxsutawney and surrounding rural Pennsylvania communities
                </dd>
              </div>
              <div>
                <dt className="text-xs font-mono uppercase tracking-[0.2em] text-[var(--gray-medium)]">
                  Head Coach / Governor
                </dt>
                <dd className="mt-1 text-base font-semibold">Jason Neale</dd>
              </div>
              <div className="md:col-span-2">
                <dt className="text-xs font-mono uppercase tracking-[0.2em] text-[var(--gray-medium)]">
                  Official Contact
                </dt>
                <dd className="mt-1 text-base font-semibold">
                  <a href="mailto:admin@punxsyprominence.org">admin@punxsyprominence.org</a>
                </dd>
              </div>
            </dl>
          </div>
        </section>

        {/* Footer */}
        <footer className="px-6 py-10 lg:px-10">
          <div className="mx-auto flex w-full max-w-5xl flex-col items-center gap-3 text-center text-sm text-[var(--gray-dark)]">
            <p className="font-bold text-[var(--black)]">Punxsy Prominence Boxing &amp; Fitness</p>
            <p>501(c)(3) nonprofit</p>
            <p>
              <a href="mailto:admin@punxsyprominence.org">admin@punxsyprominence.org</a>
            </p>
            <p>
              <Link href="/login">Log In</Link>
            </p>
            <p className="text-xs text-[var(--gray-medium)]">
              &copy; {new Date().getFullYear()} Punxsy Prominence Boxing &amp; Fitness. All rights reserved.
            </p>
          </div>
        </footer>
      </main>
    </>
  );
}
