'use client';

import Link from 'next/link';
import { useEffect, useState, type SyntheticEvent } from 'react';
import ShadowChatButton from '@/components/ShadowChatButton';
import { readRoleSession, subscribeRoleSession } from '@/components/roleSession';
import { apiBase } from '@/lib/apiBase';

type VisitorType =
  | 'Athlete / Participant'
  | 'Parent / Guardian'
  | 'Volunteer'
  | 'Coach'
  | 'Donor / Sponsor'
  | 'Board / Community Partner'
  | 'General Visitor';

interface TelemetryTrace {
  timestamp: string;
  event: 'visitor path selected' | 'intake form started' | 'intake form submitted' | 'FAQ opened' | 'quick link clicked';
  detail: string;
}

const pathwayCards: Array<{ title: string; visitorType: VisitorType; description: string }> = [
  {
    title: 'Prospective Athlete / Participant',
    visitorType: 'Athlete / Participant',
    description: 'Learn about entry-level training options and first-step participation pathways.',
  },
  {
    title: 'Parent / Guardian',
    visitorType: 'Parent / Guardian',
    description: 'Understand family engagement expectations, safety framing, and support channels.',
  },
  {
    title: 'Volunteer',
    visitorType: 'Volunteer',
    description: 'Explore community support opportunities and operational contribution pathways.',
  },
  {
    title: 'Coach Interest',
    visitorType: 'Coach',
    description: 'Signal coaching interest and receive follow-up on program alignment expectations.',
  },
  {
    title: 'Donor / Sponsor',
    visitorType: 'Donor / Sponsor',
    description: 'Review sponsor partnership lanes and contribution alignment opportunities.',
  },
  {
    title: 'Board / Community Partner',
    visitorType: 'Board / Community Partner',
    description: 'Open a governance or partnership conversation with clear public boundaries.',
  },
  {
    title: 'General Visitor',
    visitorType: 'General Visitor',
    description: 'Get a clear overview of programs, mission, and next-step contact options.',
  },
];

const programCards = [
  {
    title: 'Boxing and Fitness',
    whatItIs: 'Skill and conditioning-focused public program lane.',
    whoFor: 'Participants seeking structured boxing and fitness development.',
    nextStep: 'Submit public interest intake and choose Athlete / Participant.',
  },
  {
    title: 'Youth Development',
    whatItIs: 'Youth-centered growth track combining discipline, movement, and support.',
    whoFor: 'Young participants and guardians looking for guided development.',
    nextStep: 'Select Parent / Guardian or Athlete / Participant pathway.',
  },
  {
    title: 'Adaptive Training',
    whatItIs: 'Modified training support for varied readiness and inclusion needs.',
    whoFor: 'Participants requiring adaptive progression and structured pacing.',
    nextStep: 'Submit intake notes outlining preferred support requirements.',
  },
  {
    title: 'Competition Pathway',
    whatItIs: 'Progression route for participants exploring competitive lanes.',
    whoFor: 'Athletes preparing for structured readiness and escalation checkpoints.',
    nextStep: 'Request follow-up under Competition Track program interest.',
  },
  {
    title: 'Parent Support',
    whatItIs: 'Public guidance for family engagement in development flow.',
    whoFor: 'Parents/guardians supporting participant progression.',
    nextStep: 'Use intake form and choose Parent Support interest option.',
  },
  {
    title: 'Community / Volunteer Support',
    whatItIs: 'Public-facing support opportunities for community contributors.',
    whoFor: 'Volunteers and community advocates.',
    nextStep: 'Select Volunteer pathway and add preferred contribution note.',
  },
  {
    title: 'Sponsor / Partner Support',
    whatItIs: 'Partnership lane for donors, sponsors, and community collaborators.',
    whoFor: 'Organizations or individuals exploring support partnerships.',
    nextStep: 'Select Donor / Sponsor or Board / Community Partner path.',
  },
];

const faqItems = [
  {
    question: 'What is PPBF?',
    answer: 'PPBF is a structured platform and program model centered on safe progression, accountability, and development visibility.',
  },
  {
    question: 'Who can participate?',
    answer: 'Visitors, first-time participants, families, volunteers, coaches, and partners can all use this public entry surface.',
  },
  {
    question: 'Do I need boxing experience?',
    answer: 'No. Public intake supports both first-time and experienced participants.',
  },
  {
    question: 'How do parents get involved?',
    answer: 'Select Parent / Guardian pathway and submit intake notes for follow-up guidance.',
  },
  {
    question: 'How can I volunteer?',
    answer: 'Choose Volunteer path, select Volunteer Support in the form, and include availability details.',
  },
  {
    question: 'How can sponsors or partners help?',
    answer: 'Choose Donor / Sponsor or Board / Community Partner and outline partnership interests in the intake form.',
  },
  {
    question: 'Does submitting this form create an account?',
    answer: 'No. Submitting this form only records your interest for staff follow-up. It does not create an account or enroll you in anything -- a staff member reviews every submission before any real onboarding begins.',
  },
];

const visitorTypeOptions: VisitorType[] = [
  'Athlete / Participant',
  'Parent / Guardian',
  'Volunteer',
  'Coach',
  'Donor / Sponsor',
  'Board / Community Partner',
  'General Visitor',
];

const programInterestOptions = [
  'Boxing / Fitness',
  'Youth Development',
  'Adaptive Training',
  'Competition Track',
  'Parent Support',
  'Volunteer Support',
  'Sponsorship / Partnership',
  'General Information',
] as const;

const contactMethodOptions = ['Email', 'Phone', 'Either'] as const;

export default function PublicPortalPage() {
  const [activeRole, setActiveRole] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<VisitorType>('General Visitor');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [visitorType, setVisitorType] = useState<VisitorType>('General Visitor');
  const [programInterest, setProgramInterest] = useState<(typeof programInterestOptions)[number]>('General Information');
  const [preferredContactMethod, setPreferredContactMethod] = useState<(typeof contactMethodOptions)[number]>('Email');
  const [message, setMessage] = useState('');
  const [consentToContact, setConsentToContact] = useState(false);
  // Hidden honeypot field -- real visitors never see or fill this in (see the
  // input below, which is visually hidden and excluded from tab order). Any
  // value here marks the submission as almost certainly automated.
  const [website, setWebsite] = useState('');
  const [formStarted, setFormStarted] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [openFaq, setOpenFaq] = useState<string | null>(null);
  const [telemetryTraces, setTelemetryTraces] = useState<TelemetryTrace[]>([]);

  useEffect(() => {
    const syncRole = () => {
      const session = readRoleSession();
      setActiveRole(session?.role ?? null);
    };

    syncRole();
    return subscribeRoleSession(syncRole);
  }, []);

  function addTrace(event: TelemetryTrace['event'], detail: string) {
    setTelemetryTraces((prev) => [{ timestamp: new Date().toISOString(), event, detail }, ...prev].slice(0, 80));
  }

  function startFormIfNeeded() {
    if (!formStarted) {
      setFormStarted(true);
      addTrace('intake form started', 'Public interest intake interaction began.');
    }
  }

  function selectPath(path: VisitorType) {
    setSelectedPath(path);
    setVisitorType(path);
    addTrace('visitor path selected', `Selected pathway: ${path}`);
  }

  function toggleFaq(question: string) {
    setOpenFaq((current) => (current === question ? null : question));
    addTrace('FAQ opened', question);
  }

  // Posts to /api/pilot/public-interest -- the one unauthenticated write
  // endpoint in this app. See that route for the rate limiting, honeypot,
  // and server-side validation this relies on; nothing here is trusted
  // beyond the browser.
  async function handleSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!consentToContact) {
      setConfirmation('Please provide consent to be contacted before submitting.');
      return;
    }
    if (submitting) {
      return;
    }

    setSubmitting(true);
    setConfirmation('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/public-interest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          full_name: fullName,
          email,
          phone: phone || undefined,
          visitor_type: visitorType,
          program_interest: programInterest,
          preferred_contact_method: preferredContactMethod,
          message: message || undefined,
          consent_to_contact: consentToContact,
          website,
        }),
      });

      const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };

      if (!response.ok || !payload.ok) {
        setConfirmation(
          payload.error
          || 'Something went wrong submitting this form. Please try again, or contact us directly at '
          + '204 Pennsylvania Ave, Big Run, PA 15715.',
        );
        return;
      }

      setConfirmation('Thank you -- your interest has been received. A staff member will follow up with you.');
      addTrace('intake form submitted', `${fullName || 'Visitor'} submitted interest as ${visitorType} for ${programInterest}.`);
      setFullName('');
      setEmail('');
      setPhone('');
      setMessage('');
      setConsentToContact(false);
    } catch {
      setConfirmation(
        'Network error -- this was not submitted. Please try again, or contact us directly at '
        + '204 Pennsylvania Ave, Big Run, PA 15715.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen bg-[var(--canvas-tan)] text-[var(--black)]">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-6 py-10 lg:px-10">
        <header className="flex flex-col gap-4 border-b-[3px] border-[var(--black)] pb-6 md:flex-row md:items-end md:justify-between">
          <div className="space-y-3">
            <p className="text-xs font-mono uppercase tracking-[0.35em] text-[var(--red-primary)]">PUBLIC PORTAL</p>
            <h1 className="font-display text-4xl tracking-tight text-[var(--black)] md:text-5xl">PPBF Public Entry + Interest Intake</h1>
            <p className="max-w-4xl text-sm leading-7 text-[var(--gray-dark)] md:text-base">
              The public-facing front door for awareness, trust building, community introduction, public interest intake, volunteer recruitment, partner engagement, and future athlete enrollment.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/login"
              className="inline-flex min-h-[40px] items-center justify-center border-2 border-[var(--black)] bg-[var(--red-primary)] px-3 text-xs font-mono font-bold uppercase tracking-[0.12em] text-[var(--white)] transition hover:bg-[var(--red-highlight)]"
            >
              Member Login
            </Link>
            {/* Members only: SHADOW requires an authenticated session, and this
                button sends signed-out visitors to /login. The label says so
                rather than advertising a public chat surface that does not exist. */}
            <ShadowChatButton context="Public Portal" label="MEMBER SHADOW CHAT" />
            <Link
              href="/help#tester-guide"
              className="inline-flex min-h-[40px] items-center justify-center border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-3 text-xs font-mono font-bold uppercase tracking-[0.12em] text-[var(--black)] transition hover:bg-[var(--canvas-tan-dark)]"
            >
              Tester Guide
            </Link>
            <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-4 py-3 text-xs font-mono text-[var(--black)] shadow-[var(--shadow-sm)]">
              Status: ready
            </div>
          </div>
        </header>

        <section className="mt-6 grid gap-3 md:grid-cols-3">
          {[
            { label: 'Audience', value: 'Visitors' },
            { label: 'Purpose', value: 'Awareness + Interest Intake' },
            { label: 'Access', value: 'Public / Read-only' },
          ].map((item) => (
            <div key={item.label} className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4 shadow-[var(--shadow-sm)]">
              <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-[var(--gray-medium)]">{item.label}</p>
              <p className="mt-2 text-xl font-black text-[var(--black)]">{item.value}</p>
            </div>
          ))}
        </section>

        {activeRole === 'admin' && (
          <section className="mt-6 border-[3px] border-[var(--black)] bg-[var(--red-primary)] p-5 text-[var(--white)] shadow-[var(--shadow-md)]">
            <p className="text-xs font-mono uppercase tracking-[0.24em] text-[var(--canvas-tan-light)]">Admin Editing Mode</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <p className="text-sm leading-6 text-[var(--white)]">You are viewing the public surface as an admin. Use these links to manage visitor-facing content and announcements.</p>
              <Link
                href="/admin"
                className="inline-flex min-h-[40px] items-center justify-center border-2 border-[var(--white)] bg-transparent px-3 text-xs font-mono font-bold uppercase tracking-[0.12em] text-[var(--white)] transition hover:bg-[var(--white)] hover:text-[var(--red-primary)]"
              >
                Open Admin Workspace
              </Link>
              <Link
                href="/login"
                className="inline-flex min-h-[40px] items-center justify-center border-2 border-[var(--white)] bg-[var(--canvas-tan-light)] px-3 text-xs font-mono font-bold uppercase tracking-[0.12em] text-[var(--black)] transition hover:bg-[var(--white)]"
              >
                Manage Announcements
              </Link>
            </div>
          </section>
        )}

        <section className="mt-6 border-[3px] border-[var(--black)] bg-[var(--canvas-tan-light)] p-5 shadow-[var(--shadow-md)]">
          <p className="text-xs font-mono uppercase tracking-[0.25em] text-[var(--red-primary)]">Identity</p>
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            {['VETERAN-OWNED', '501(c)(3) PUBLIC CHARITY', 'COMMUNITY IMPACT DRIVEN'].map((item) => (
              <div key={item} className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-4 text-center">
                <p className="text-lg font-black tracking-[0.18em] text-[var(--black)]">{item}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-6 border-[3px] border-[var(--black)] bg-[var(--canvas-tan-light)] p-5 shadow-[var(--shadow-sm)]">
          <h2 className="text-[20px] font-black text-[var(--black)]">PUBLIC PORTAL PURPOSE</h2>
          <p className="mt-3 text-[16px] leading-7 text-[var(--gray-dark)]">
            This portal is for public awareness and contact interest only. It does not route users into internal systems.
          </p>
        </section>

        <div className="mt-6 space-y-6">
        <section id="volunteer-recruitment" className="border-[3px] border-[var(--black)] bg-[var(--canvas-tan-light)] p-5 shadow-[var(--shadow-sm)]">
          <h2 className="text-[20px] font-black text-[var(--black)]">CHOOSE YOUR PATH</h2>
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {pathwayCards.map((path) => {
              const selected = selectedPath === path.visitorType;
              return (
                <article key={path.title} className={`border-2 p-4 ${selected ? 'border-[var(--red-primary)] bg-[var(--canvas-tan-dark)]' : 'border-[var(--black)] bg-[var(--canvas-tan)]'}`}>
                  <p className="text-[18px] font-bold text-[var(--black)]">{path.title}</p>
                  <p className="mt-2 text-[14px] leading-6 text-[var(--gray-dark)]">{path.description}</p>
                  <button
                    type="button"
                    onClick={() => selectPath(path.visitorType)}
                    className="mt-3 min-h-[44px] border-2 border-[var(--black)] bg-[var(--red-primary)] px-3 text-[14px] font-bold text-[var(--white)] transition hover:bg-[var(--red-highlight)]"
                  >
                    Select
                  </button>
                </article>
              );
            })}
          </div>
        </section>

        <section id="interest-intake" className="border-[3px] border-[var(--black)] bg-[var(--canvas-tan-light)] p-5 shadow-[var(--shadow-sm)]">
          <h2 className="text-[20px] font-black text-[var(--black)]">PUBLIC INTEREST INTAKE</h2>
          <form className="mt-4 grid gap-3" onSubmit={handleSubmit}>
            {/* Honeypot: visually hidden and out of tab order, so a real
                visitor never encounters it, but most simple bots fill in
                every field they can find. */}
            <input
              type="text"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              tabIndex={-1}
              autoComplete="off"
              aria-hidden="true"
              className="absolute h-0 w-0 opacity-0"
              style={{ position: 'absolute', left: '-9999px' }}
            />
            <input
              value={fullName}
              onChange={(e) => {
                startFormIfNeeded();
                setFullName(e.target.value);
              }}
              placeholder="Full Name"
              className="min-h-[44px] border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3 text-[16px] text-[var(--black)]"
              required
            />
            <input
              type="email"
              value={email}
              onChange={(e) => {
                startFormIfNeeded();
                setEmail(e.target.value);
              }}
              placeholder="Email"
              className="min-h-[44px] border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3 text-[16px] text-[var(--black)]"
              required
            />
            <input
              value={phone}
              onChange={(e) => {
                startFormIfNeeded();
                setPhone(e.target.value);
              }}
              placeholder="Phone (optional)"
              className="min-h-[44px] border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3 text-[16px] text-[var(--black)]"
            />

            <select
              value={visitorType}
              onChange={(e) => {
                startFormIfNeeded();
                setVisitorType(e.target.value as VisitorType);
              }}
              className="min-h-[44px] border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3 text-[16px] text-[var(--black)]"
            >
              {visitorTypeOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>

            <select
              value={programInterest}
              onChange={(e) => {
                startFormIfNeeded();
                setProgramInterest(e.target.value as (typeof programInterestOptions)[number]);
              }}
              className="min-h-[44px] border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3 text-[16px] text-[var(--black)]"
            >
              {programInterestOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>

            <select
              value={preferredContactMethod}
              onChange={(e) => {
                startFormIfNeeded();
                setPreferredContactMethod(e.target.value as (typeof contactMethodOptions)[number]);
              }}
              className="min-h-[44px] border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3 text-[16px] text-[var(--black)]"
            >
              {contactMethodOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>

            <textarea
              value={message}
              onChange={(e) => {
                startFormIfNeeded();
                setMessage(e.target.value);
              }}
              placeholder="Message / Notes"
              className="min-h-[110px] border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3 py-2 text-[16px] text-[var(--black)]"
            />

            <label className="flex items-center gap-2 text-[14px] text-[var(--gray-dark)]">
              <input
                type="checkbox"
                checked={consentToContact}
                onChange={(e) => {
                  startFormIfNeeded();
                  setConsentToContact(e.target.checked);
                }}
              />
              <span>Consent to be contacted</span>
            </label>

            <button
              type="submit"
              disabled={submitting}
              className="min-h-[44px] border-2 border-[var(--black)] bg-[var(--red-primary)] px-4 text-[14px] font-bold text-[var(--white)] transition hover:bg-[var(--red-highlight)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? 'Submitting...' : 'Submit Interest'}
            </button>

            {confirmation && <p className="text-[14px] text-[var(--red-primary)]">{confirmation}</p>}
          </form>
        </section>

        <section id="partner-engagement" className="border-[3px] border-[var(--black)] bg-[var(--canvas-tan-light)] p-5 shadow-[var(--shadow-sm)]">
          <h2 className="text-[20px] font-black text-[var(--black)]">PROGRAM PREVIEW</h2>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {programCards.map((program) => (
              <article key={program.title} className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-4">
                <p className="text-[18px] font-bold text-[var(--black)]">{program.title}</p>
                <p className="mt-2 text-[14px] leading-6 text-[var(--gray-dark)]">What it is: {program.whatItIs}</p>
                <p className="mt-1 text-[14px] leading-6 text-[var(--gray-dark)]">Who it is for: {program.whoFor}</p>
                <p className="mt-1 text-[14px] leading-6 text-[var(--gray-dark)]">Next step: {program.nextStep}</p>
              </article>
            ))}
          </div>
        </section>

        <section id="public-faq" className="border-[3px] border-[var(--black)] bg-[var(--canvas-tan-light)] p-5 shadow-[var(--shadow-sm)]">
          <h2 className="text-[20px] font-black text-[var(--black)]">PUBLIC FAQ</h2>
          <div className="mt-4 space-y-2">
            {faqItems.map((item) => {
              const expanded = openFaq === item.question;
              return (
                <article key={item.question} className="border-2 border-[var(--black)] bg-[var(--canvas-tan)]">
                  <button
                    type="button"
                    onClick={() => toggleFaq(item.question)}
                    aria-expanded={expanded}
                    aria-controls={`faq-panel-${item.question.replace(/[^a-z0-9]/gi, '-').toLowerCase()}`}
                    className="flex min-h-[44px] w-full items-center justify-between px-4 py-2 text-left"
                  >
                    <span className="text-[16px] font-semibold text-[var(--black)]">{item.question}</span>
                    <span className="font-mono text-[var(--red-primary)]">{expanded ? '−' : '+'}</span>
                  </button>
                  {expanded && (
                    <p
                      id={`faq-panel-${item.question.replace(/[^a-z0-9]/gi, '-').toLowerCase()}`}
                      className="border-t-2 border-[var(--black)] px-4 py-3 text-[14px] leading-6 text-[var(--gray-dark)]"
                    >
                      {item.answer}
                    </p>
                  )}
                </article>
              );
            })}
          </div>
        </section>

        <section className="border-[3px] border-[var(--black)] bg-[var(--canvas-tan-light)] p-5 shadow-[var(--shadow-sm)]">
          <h2 className="text-[20px] font-black text-[var(--black)]">PUBLIC ACCESS BOUNDARY</h2>
          <p className="mt-3 text-[16px] leading-7 text-[var(--gray-dark)]">
            This public portal is for awareness and interest intake only. It does not expose private athlete data, coach notes, parent records, board materials, admin controls, or internal SHADOW data.
          </p>
        </section>

        <section className="border-[3px] border-[var(--black)] bg-[var(--canvas-tan-light)] p-5 shadow-[var(--shadow-sm)]">
          <h2 className="text-[20px] font-black text-[var(--black)]">NEXT STEP AFTER SUBMISSION</h2>
          <div className="mt-3 grid gap-2 text-[14px] font-mono text-[var(--red-primary)]">
            <p>Interest Submitted</p>
            <p>↓</p>
            <p>Pending Admin Review</p>
            <p>↓</p>
            <p>Route to Correct Intake</p>
            <p>↓</p>
            <p>Contact / Onboarding</p>
          </div>
        </section>

        <section className="border-[3px] border-[var(--black)] bg-[var(--canvas-tan-light)] p-5 shadow-[var(--shadow-sm)]">
          <h2 className="text-[20px] font-black text-[var(--black)]">PUBLIC QUICK LINKS</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {/* Members only -- see note on the portal header button above. */}
            <ShadowChatButton context="Public Quick Links" label="Member SHADOW Chat" />
            {[
              { label: 'Public FAQ', href: '/public#public-faq' },
              { label: 'Interest Intake', href: '/public#interest-intake' },
              { label: 'Volunteer Recruitment', href: '/public#volunteer-recruitment' },
              { label: 'Partner Engagement', href: '/public#partner-engagement' },
            ].map((link) => (
              <a
                key={link.label}
                href={link.href}
                onClick={() => addTrace('quick link clicked', `${link.label} -> ${link.href}`)}
                className="inline-flex min-h-[44px] items-center border-2 border-[var(--black)] bg-[var(--red-primary)] px-4 text-[14px] font-bold text-[var(--white)] transition hover:bg-[var(--red-highlight)]"
              >
                {link.label}
              </a>
            ))}
          </div>
        </section>

        <section className="border-[3px] border-[var(--black)] bg-[var(--canvas-tan-light)] p-5 shadow-[var(--shadow-sm)]">
          <h2 className="text-[18px] font-black text-[var(--black)]">LOCAL PUBLIC TELEMETRY</h2>
          <div className="mt-3 max-h-[220px] space-y-2 overflow-y-auto border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-3">
            {telemetryTraces.length === 0 && <p className="text-[14px] text-[var(--gray-dark)]">No local traces yet.</p>}
            {telemetryTraces.map((trace, idx) => (
              <div key={`${trace.timestamp}-${idx}`} className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-2 text-[13px] text-[var(--gray-dark)]">
                <p className="font-mono text-[var(--red-primary)]">[{trace.timestamp}]</p>
                <p>{trace.event}</p>
                <p>{trace.detail}</p>
              </div>
            ))}
          </div>
        </section>
        </div>
      </div>
    </main>
  );
}