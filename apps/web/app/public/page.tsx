'use client';

import Link from 'next/link';
import { Suspense, useCallback, useEffect, useRef, useState, type SyntheticEvent } from 'react';
import PhotoSlot from '@/components/PhotoSlot';
import ShadowChatButton from '@/components/ShadowChatButton';
import SignInPanel from '@/components/SignInPanel';
import { readRoleSession, subscribeRoleSession } from '@/components/roleSession';
import { GYM_STAFF_CARDS, gymPhotoSlotsFor, gymPhotoSrc } from '@/src/shared/gymPhotos';
import { apiBase } from '@/lib/apiBase';

/**
 * THE SIGN-IN POPOVER -- owner decision 2026-08-16: /public stays the front
 * door (story first, sign-in secondary) and signing in becomes a panel on
 * this same page rather than a trip to another one. Structurally identical to
 * CommandsOverlay (components/CommandsOverlay.tsx): full-screen backdrop,
 * Escape closes, focus returns to whatever opened it. That pattern already
 * exists and works, so it is reused rather than a new one invented.
 */
function SignInOverlay({ onClose }: { onClose: () => void }) {
  const restoreRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement;
    panelRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      restoreRef.current?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="ppbf fixed inset-0 z-[210] flex items-start justify-center overflow-y-auto px-4 py-8 sm:items-center"
      role="presentation"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="absolute inset-0 bg-[rgba(8,6,4,.72)]" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Sign in"
        tabIndex={-1}
        className="relative w-full max-w-[720px]"
      >
        <Suspense fallback={null}>
          <SignInPanel embedded onClose={onClose} />
        </Suspense>
      </div>
    </div>
  );
}

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

// Card titles and descriptions are copy and can be reworded freely. The
// `visitorType` values are not: they are submitted as `visitor_type` and
// checked server-side against VISITOR_TYPES in src/server/pilot/publicInterest.ts.
// Changing one of those strings here makes the submission bounce.
const pathwayCards: Array<{ title: string; visitorType: VisitorType; description: string }> = [
  {
    title: 'I want to train here',
    visitorType: 'Athlete / Participant',
    description:
      'Boxing, fitness, or both. You do not need to be in shape first, and you do not have to fight anybody -- plenty of people here never do.',
  },
  {
    title: 'I am a parent or guardian',
    visitorType: 'Parent / Guardian',
    description:
      'You want to know who is coaching your kid, how they are kept safe, and what a night in here actually looks like. Those are the right questions. Ask them.',
  },
  {
    title: 'I want to help out',
    visitorType: 'Volunteer',
    description:
      'Working the door at events, driving to matches, keeping time, fixing equipment. Weekly or once in a while -- both are useful.',
  },
  {
    title: 'I want to coach',
    visitorType: 'Coach',
    description:
      'Tell us what you have coached and who you would want to work with. We will talk through experience, clearances, and where you would fit.',
  },
  {
    title: 'I want to support the gym',
    visitorType: 'Donor / Sponsor',
    description:
      'Kids train free because people and local businesses cover the cost. Ask what your money would actually pay for -- we will tell you.',
  },
  {
    title: 'I am here about a partnership',
    visitorType: 'Board / Community Partner',
    description:
      'Schools, youth organizations, local business, board service. Start it here and we will take the conversation off the public page.',
  },
  {
    title: 'I am just looking around',
    visitorType: 'General Visitor',
    description:
      'No agenda needed. Read what we run, see who it is for, and reach out only if something fits.',
  },
];

// Four different reasons people train here -- fitness only, adult recreational
// boxing, youth boxing and mentorship, and competition -- get their own cards
// and lead the list, because a visitor who only ever wants the conditioning
// work should not have to infer that they are allowed to want it. The "next
// step" lines name the exact dropdown option to pick, so the form below reads
// as an answer to the card rather than a separate puzzle.
const programCards = [
  {
    title: 'Fitness Only -- Nobody Hits You',
    whatItIs:
      'Bags, rope, footwork, conditioning. Boxing training without the boxing. No contact, no sparring, not now and not later.',
    whoFor:
      'Adults who want a hard workout and have zero interest in getting punched. This is a full program, not a beginner phase you graduate out of.',
    nextStep: 'Pick Boxing / Fitness in the form below and write "fitness only" in the message.',
  },
  {
    title: 'Adult Recreational Boxing',
    whatItIs:
      'Actual boxing -- stance, footwork, combinations, pad work -- taught at a pace that fits someone with a job and a bad back. Sparring is available if you ever want it and is never required.',
    whoFor: 'Adults who want to learn to box, whether or not they ever step in a ring.',
    nextStep: 'Pick Boxing / Fitness below and tell us you are an adult starting out.',
  },
  {
    title: 'Youth Boxing and Mentorship',
    whatItIs:
      'Kids and teens train with coaches who also ask about school, attitude, and how they treat people. Everyone starts non-contact: footwork, technique, conditioning, supervised the whole time.',
    whoFor:
      'Young people who need somewhere to put their energy and adults who will stay in their corner. Kids train free.',
    nextStep: "Pick Youth Development below. Parents, put your kid's age in the message.",
  },
  {
    title: 'Competitive Boxing',
    whatItIs:
      'For athletes who decide on their own that they want to compete. A coach confirms readiness before any of it. Nobody gets pushed toward a ring to fill a card.',
    whoFor: 'Athletes who choose it. Competing is optional here and always has been.',
    nextStep: 'Pick Competition Track below.',
  },
  {
    title: 'Adaptive Training',
    whatItIs:
      'The same work, adjusted -- around an injury, a disability, a health condition, or a body coming back from a long time off.',
    whoFor: 'Anyone who has been told they cannot, or has been quietly counted out somewhere else.',
    nextStep: 'Pick Adaptive Training below and tell us as much or as little as you want.',
  },
  {
    title: 'For Parents and Guardians',
    whatItIs:
      'Straight answers about supervision, contact rules, what a session looks like, and how to reach a coach directly. You are welcome to stay and watch any session.',
    whoFor:
      'Parents deciding whether to bring their kid through the door, and parents whose kid already trains here.',
    nextStep: 'Pick Parent Support below and ask whatever you actually want to ask.',
  },
  {
    title: 'Volunteering',
    whatItIs:
      'Events, transportation, equipment, timekeeping, the unglamorous work that keeps a gym open. No boxing background needed.',
    whoFor: 'People with a few hours and a willingness to be useful.',
    nextStep: 'Pick Volunteer Support below and tell us when you are free.',
  },
  {
    title: 'Sponsors and Partners',
    whatItIs:
      'Businesses, schools, and community organizations who help keep training free for kids. We will tell you exactly what your support pays for.',
    whoFor: 'Organizations or individuals who want to back this with money, space, or gear.',
    nextStep: 'Pick Sponsorship / Partnership below.',
  },
];

// Ordered by what people are actually afraid to ask, not by org chart. The
// account/staff-review answer at the bottom is the register the rest of this
// page is written to match: plain, specific, and honest about what happens next.
const faqItems = [
  {
    question: 'Do I have to fight anybody?',
    answer: 'No. A lot of people here never get hit, on purpose or by accident, and that is a normal way to train here for as long as you want. Sparring and competing are separate choices you make later, only if you want them, and a coach signs off on readiness before either one.',
  },
  {
    question: 'Is my kid going to get hurt?',
    answer: 'Every kid starts non-contact -- footwork, technique, conditioning -- supervised the whole time. Contact comes later, only when a coach confirms a kid is ready for it, with the right gear and a coach running it. You are welcome to stay and watch any session, start to finish, and you should.',
  },
  {
    question: 'What does it cost?',
    answer: 'Kids train free. Whether a child can train here is not decided by what their family can pay. Adults, ask us -- we would rather tell you straight than post a number that goes stale.',
  },
  {
    question: 'Do I need to be in shape first?',
    answer: 'No, and nobody here started that way either. Come as you are. You will be sore and you will be welcome.',
  },
  {
    question: 'I have never boxed. Is that a problem?',
    answer: 'No. Most people who walk in have never thrown a punch. First-timers and experienced fighters use the same door and the same form.',
  },
  {
    question: 'Is this just for kids, or can adults train too?',
    answer: 'Both. Youth development is why this place exists, and adults train here as well -- fitness only, recreational boxing, or competition if that is what they want.',
  },
  {
    question: 'Who is actually coaching my kid?',
    answer: "Jason Neale is head coach. PPBF is a veteran-owned 501(c)(3) nonprofit with a board and real records behind it, not a side project run out of somebody's garage. Ask to meet whoever would be working with your kid before you commit to anything.",
  },
  {
    question: 'I want to help. What is useful?',
    answer: 'Time or money, and both count. Volunteers work events, drive, keep time, and fix things. Sponsors and partners cover the cost of keeping training free for kids. Pick Volunteer Support or Sponsorship / Partnership in the form and say what you have to offer.',
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

/* The three lists above are wire values, not copy. Each one is submitted as-is
   and re-checked server-side against VISITOR_TYPES / PROGRAM_INTERESTS /
   CONTACT_METHODS in src/server/pilot/publicInterest.ts, and staff read the
   stored value on the review screen -- so the strings themselves cannot be
   softened without breaking submissions and renaming what reviewers see.

   What a visitor reads can still be plain English. These maps supply the
   <option> label only; the submitted value stays the canonical string. They are
   typed as complete Records so a value added to a list above fails typecheck
   until it has a label here, rather than silently rendering an empty option. */
const visitorTypeLabels: Record<VisitorType, string> = {
  'Athlete / Participant': 'I want to train here',
  'Parent / Guardian': 'I am a parent or guardian',
  Volunteer: 'I want to volunteer',
  Coach: 'I want to coach',
  'Donor / Sponsor': 'I want to donate or sponsor',
  'Board / Community Partner': 'I am here about a partnership',
  'General Visitor': 'I am just looking around',
};

const programInterestLabels: Record<(typeof programInterestOptions)[number], string> = {
  'Boxing / Fitness': 'Boxing or fitness training (fitness only is fine)',
  'Youth Development': 'Youth boxing and mentorship (under 18)',
  'Adaptive Training': 'Adaptive training (injury, disability, long time off)',
  'Competition Track': 'Competing as an amateur boxer',
  'Parent Support': 'Questions from a parent or guardian',
  'Volunteer Support': 'Volunteering',
  'Sponsorship / Partnership': 'Sponsorship or partnership',
  'General Information': 'Something else -- I just have a question',
};

const contactMethodLabels: Record<(typeof contactMethodOptions)[number], string> = {
  Email: 'Email me',
  Phone: 'Call or text me',
  Either: 'Either is fine',
};

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
  const [showSignIn, setShowSignIn] = useState(false);
  const closeSignIn = useCallback(() => setShowSignIn(false), []);

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
      addTrace('intake form started', 'Started filling in the contact form.');
    }
  }

  function selectPath(path: VisitorType) {
    setSelectedPath(path);
    setVisitorType(path);
    addTrace('visitor path selected', `Picked: ${visitorTypeLabels[path]}`);
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
      setConfirmation('Please check the box above so we know it is okay to contact you.');
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
          || 'Something went wrong sending this and it did not go through. Try again, or just come by: '
          + '220 N Jefferson St, Punxsutawney, PA 15767.',
        );
        return;
      }

      setConfirmation('Got it -- thanks. A staff member reads every one of these, and someone will get back to you the way you asked.');
      addTrace('intake form submitted', `${fullName || 'Visitor'} submitted interest as ${visitorType} for ${programInterest}.`);
      setFullName('');
      setEmail('');
      setPhone('');
      setMessage('');
      setConsentToContact(false);
    } catch {
      setConfirmation(
        'The connection dropped and this was not sent. Try again, or just come by: '
        + '220 N Jefferson St, Punxsutawney, PA 15767.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="on-canvas min-h-screen">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-6 py-10 lg:px-10">
        <header className="flex flex-col gap-4 border-b-[3px] border-[color:rgba(107,78,18,.28)] pb-6 md:flex-row md:items-end md:justify-between">
          <div className="space-y-3">
            <p className="text-xs font-mono uppercase tracking-[0.35em] text-[color:var(--brass-800)]">PUNXSY PROMINENCE BOXING &amp; FITNESS</p>
            <h1 className="font-display text-4xl tracking-tight text-[color:var(--hide-950)] md:text-5xl">A boxing gym for kids, for adults, and for anyone who just wants to get in shape.</h1>
            <p className="max-w-4xl text-sm leading-7 text-[color:var(--hide-800)] md:text-base">
              We are a nonprofit gym in Punxsutawney, Pennsylvania. Some people here are training to compete. Most are
              not. Kids come for coaching and for adults who notice how their week is going, and kids train free. Adults
              come to learn to box, or to work the bags hard and never get hit once. All of it counts as training here.
            </p>
            <p className="max-w-4xl text-sm leading-7 text-[color:var(--hide-800)] md:text-base">
              Nothing on this page signs you up for anything. Read what we run, and if something sounds like you, tell us
              and a person here will get back to you.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* Opens the sign-in popover in place -- owner decision
                2026-08-16: signing in is a panel on this page, not a trip
                to another one. /login still exists as its own address for
                anyone who bookmarked it or was redirected there with an
                error to explain, so nothing else depends on this button
                navigating anywhere. */}
            <button
              type="button"
              onClick={() => setShowSignIn(true)}
              className="btn"
            >
              Member Login
            </button>
            {/* Members only: SHADOW requires an authenticated session, and this
                button sends signed-out visitors to /login. The label says so
                rather than advertising a public chat surface that does not exist. */}
            <ShadowChatButton context="Public Portal" label="MEMBER SHADOW CHAT" />
            <Link
              href="/help#tester-guide"
              className="btn btn--ghost"
            >
              Tester Guide
            </Link>
            {/* Law 4, mono records: an address is a fact a visitor copies down,
                not prose. It also replaces a "Status: ready" chip that told a
                nervous parent nothing and told them it in machine language. */}
            <div className="border border-[color:rgba(107,78,18,.28)] rounded-[var(--r-md)] mat-paper px-4 py-3 text-xs font-mono text-[color:var(--hide-950)] shadow-[var(--shadow-sm)]">
              220 N Jefferson St, Punxsutawney, PA 15767
            </div>
          </div>
        </header>

        <section className="mt-6 grid gap-3 md:grid-cols-3">
          {[
            { label: 'Who trains here', value: 'Kids, teens, and adults' },
            { label: 'What it costs kids', value: 'Nothing' },
            { label: 'Do you have to fight?', value: 'No' },
          ].map((item) => (
            <div key={item.label} className="border border-[color:rgba(107,78,18,.28)] rounded-[var(--r-md)] mat-paper p-4 shadow-[var(--shadow-sm)]">
              <p className="text-[length:var(--t-xs)] font-mono uppercase tracking-[0.2em] text-[color:var(--hide-600)]">{item.label}</p>
              <p className="mt-2 text-xl font-black text-[color:var(--hide-950)]">{item.value}</p>
            </div>
          ))}
        </section>

        {activeRole === 'admin' && (
          <section className="mt-[var(--s5)] mat-paper rounded-[var(--r-lg)] border-2 border-[color:var(--brass-600)] p-[var(--s5)]">
            <p className="t-eyebrow">Admin Editing Mode</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <p className="t-body">You are viewing the public surface as an admin. Use these links to manage visitor-facing content and announcements.</p>
              <Link
                href="/admin"
                className="inline-flex min-h-[44px] items-center justify-center border-2 border-[color:var(--bone-100)] bg-transparent px-3 text-xs font-mono font-bold uppercase tracking-[0.12em] text-[color:var(--bone-100)] transition hover:bg-[var(--bone-100)] hover:text-[color:var(--brass-800)]"
              >
                Open Admin Workspace
              </Link>
              {/* Was pointed at /login, which cannot manage anything --
                  /notices is the real announcement read/write/update
                  surface, already gated to admin/coach/platform_owner/board. */}
              <Link
                href="/notices"
                className="btn btn--ghost"
              >
                Manage Announcements
              </Link>
            </div>
          </section>
        )}

        <section className="mt-6 border-[3px] border-[color:rgba(107,78,18,.28)] mat-paper p-5 shadow-[var(--shadow-md)]">
          <p className="text-xs font-mono uppercase tracking-[0.25em] text-[color:var(--brass-800)]">Who runs this place</p>
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            {['VETERAN-OWNED', '501(c)(3) NONPROFIT', 'KIDS TRAIN FREE'].map((item) => (
              <div key={item} className="border border-[color:rgba(107,78,18,.28)] rounded-[var(--r-md)] mat-paper p-4 text-center">
                <p className="text-lg font-black tracking-[0.18em] text-[color:var(--hide-950)]">{item}</p>
              </div>
            ))}
          </div>
        </section>

        {/* THE ROOM.
            Frames, hung, mostly empty -- and that is the honest state, not a
            build that has not finished. The owner is taking these photographs
            and has none yet, so every frame is a real frame waiting for a real
            picture rather than a stock image of somebody else's gym or a grey
            rectangle that reads as a broken CDN. See src/shared/gymPhotos.ts
            for how a photograph actually gets in here. */}
        <section id="the-room" className="mt-6 border-[3px] border-[color:rgba(107,78,18,.28)] mat-paper p-5 shadow-[var(--shadow-sm)]">
          <h2 className="text-[length:var(--t-md)] font-black text-[color:var(--hide-950)]">WHAT IT LOOKS LIKE IN HERE</h2>
          <p className="mt-3 max-w-4xl text-[length:var(--t-sm)] leading-7 text-[color:var(--hide-800)]">
            {(() => {
              /* Three honest states, not two: the frames now carry drawn
                 stand-ins (manifest .svg illustrations, labeled as such inside
                 the image and in the alt) until real photographs land, and the
                 caption must not call a drawing a photograph. A committed
                 photograph is any filled slot that is not an .svg. */
              const filled = gymPhotoSlotsFor('public').filter((slot) => gymPhotoSrc(slot.file) !== null);
              if (filled.length === 0) {
                return 'These frames are empty because nobody has taken the photographs yet, and we would rather show you an empty frame than a stock photo of somebody else’s gym. Until they are up: come and look at the real thing. You do not need an appointment and you do not need to call first.';
              }
              if (filled.every((slot) => (slot.file ?? '').endsWith('.svg'))) {
                return 'Drawn stand-ins of our own room — labeled as exactly that — until the photographs are taken. Never a stock photo of somebody else’s gym. Come and look at the real thing: you do not need an appointment and you do not need to call first.';
              }
              return 'Photographs of this gym. Not a stock photo of a different gym in a different state.';
            })()}
          </p>
          <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {gymPhotoSlotsFor('public').map((slot) => (
              <PhotoSlot key={slot.key} slot={slot} shape="wide" />
            ))}
          </div>
        </section>

        {/* THE PEOPLE.
            A parent seeing a coach's face matters more than any paragraph, so
            the photograph is the point of this section and the words are the
            caption. Exactly one person is named, because exactly one is known:
            /public has said "Jason Neale is head coach" since the Phase 1
            rewrite and nobody has typed in another. Inventing plausible
            coaches to fill a grid would be a lie on the page a parent reads
            before deciding whether to trust this place with their kid. */}
        <section id="who-coaches" className="mt-6 border-[3px] border-[color:rgba(107,78,18,.28)] mat-paper p-5 shadow-[var(--shadow-sm)]">
          <h2 className="text-[length:var(--t-md)] font-black text-[color:var(--hide-950)]">WHO WOULD BE COACHING YOUR KID</h2>
          <p className="mt-3 max-w-4xl text-[length:var(--t-sm)] leading-7 text-[color:var(--hide-800)]">
            You should know the face of whoever is going to be working with your kid before you leave them here. Ask
            to meet them. Stay and watch the whole session. Both of those are normal and neither of them is rude.
          </p>
          <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {GYM_STAFF_CARDS.map((person) => (
              <article key={person.key} className="border border-[color:rgba(107,78,18,.28)] rounded-[var(--r-md)] mat-paper p-4">
                <PhotoSlot
                  slot={{
                    key: person.key,
                    title: person.name,
                    caption: person.role,
                    file: person.photo,
                    alt: person.alt,
                    surfaces: ['public'],
                  }}
                  shape="tall"
                />
                {person.bio ? (
                  <p className="mt-3 text-[length:var(--t-sm)] leading-6 text-[color:var(--hide-800)]">{person.bio}</p>
                ) : (
                  <p className="mt-3 text-[length:var(--t-sm)] leading-6 text-[color:var(--hide-800)]">
                    Nothing written here yet. Come in and ask him yourself.
                  </p>
                )}
              </article>
            ))}
          </div>
          <p className="mt-4 max-w-4xl text-[length:var(--t-sm)] leading-7 text-[color:var(--hide-800)]">
            Other coaches and volunteers work here too, and they are not listed yet because nobody has put their
            names and photographs up. That is a gap on this page, not a gap in the gym.
          </p>
        </section>

        <section className="mt-6 border-[3px] border-[color:rgba(107,78,18,.28)] mat-paper p-5 shadow-[var(--shadow-sm)]">
          <h2 className="text-[length:var(--t-md)] font-black text-[color:var(--hide-950)]">WHAT THIS PAGE IS</h2>
          <p className="mt-3 text-[length:var(--t-sm)] leading-7 text-[color:var(--hide-800)]">
            This is the front door: what we run, who it is for, and a way to reach a person. It does not log you into
            anything and it does not put you in a system. If you would rather do this in person, the gym is at 220 N
            Jefferson St in Punxsutawney and you are welcome to come watch a session before you decide anything.
          </p>
        </section>

        <div className="mt-6 space-y-6">
        <section id="volunteer-recruitment" className="mat-paper rounded-[var(--r-lg)] border border-[color:rgba(107,78,18,.28)] p-[var(--s5)]">
          <h2 className="text-[length:var(--t-md)] font-black text-[color:var(--hide-950)]">WHICH ONE SOUNDS LIKE YOU?</h2>
          <p className="mt-3 text-[length:var(--t-sm)] leading-7 text-[color:var(--hide-800)]">
            Pick the closest one. All it does is fill in the form further down, you can change it, and picking the wrong
            one costs you nothing.
          </p>
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {pathwayCards.map((path) => {
              // The selected card used --canvas-tan-dark, which aliases to
              // --hide-600: leather, not a darker tan. Its dark body copy
              // landed at 1.43:1 and its title at 1.68:1, so selecting a
              // pathway made the card unreadable. --paper-2 is the actual
              // "canvas, one shade down" and keeps the copy at ink contrast.
              const selected = selectedPath === path.visitorType;
              return (
                <article key={path.title} className={`border-2 p-4 ${selected ? 'border-[color:var(--brass-600)] mat-paper' : 'border-[color:rgba(107,78,18,.28)] mat-paper'}`}>
                  <p className="text-[length:var(--t-md)] font-bold text-[color:var(--hide-950)]">{path.title}</p>
                  <p className="mt-2 text-[length:var(--t-sm)] leading-6 text-[color:var(--hide-800)]">{path.description}</p>
                  <button
                    type="button"
                    onClick={() => selectPath(path.visitorType)}
                    className="mt-3 min-h-[44px] border border-[color:rgba(107,78,18,.28)] rounded-[var(--r-md)] bg-[var(--brass-800)] px-3 text-[length:var(--t-sm)] font-bold text-[color:var(--bone-100)] transition hover:bg-[var(--red-highlight)]"
                  >
                    That is me
                  </button>
                </article>
              );
            })}
          </div>
        </section>

        <section id="interest-intake" className="mat-paper rounded-[var(--r-lg)] border border-[color:rgba(107,78,18,.28)] p-[var(--s5)]">
          <h2 className="text-[length:var(--t-md)] font-black text-[color:var(--hide-950)]">TELL US YOU ARE INTERESTED</h2>
          <p className="mt-3 text-[length:var(--t-sm)] leading-7 text-[color:var(--hide-800)]">
            This is not an application and it does not sign you or your kid up for anything. It is how you tell us you
            are curious so a person can get back to you. Your name and an email are all we actually need. Everything else
            just helps us point you at the right coach.
          </p>
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
              placeholder="Your name"
              className="input"
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
              className="input"
              required
            />
            <input
              value={phone}
              onChange={(e) => {
                startFormIfNeeded();
                setPhone(e.target.value);
              }}
              placeholder="Phone (only if you want a call)"
              className="input"
            />

            <select
              value={visitorType}
              onChange={(e) => {
                startFormIfNeeded();
                setVisitorType(e.target.value as VisitorType);
              }}
              className="input"
            >
              {/* value stays the canonical wire string the server validates;
                  only the label a visitor reads is plain English. */}
              {visitorTypeOptions.map((option) => (
                <option key={option} value={option}>
                  {visitorTypeLabels[option]}
                </option>
              ))}
            </select>

            <select
              value={programInterest}
              onChange={(e) => {
                startFormIfNeeded();
                setProgramInterest(e.target.value as (typeof programInterestOptions)[number]);
              }}
              className="input"
            >
              {programInterestOptions.map((option) => (
                <option key={option} value={option}>
                  {programInterestLabels[option]}
                </option>
              ))}
            </select>

            <select
              value={preferredContactMethod}
              onChange={(e) => {
                startFormIfNeeded();
                setPreferredContactMethod(e.target.value as (typeof contactMethodOptions)[number]);
              }}
              className="input"
            >
              {contactMethodOptions.map((option) => (
                <option key={option} value={option}>
                  {contactMethodLabels[option]}
                </option>
              ))}
            </select>

            <textarea
              value={message}
              onChange={(e) => {
                startFormIfNeeded();
                setMessage(e.target.value);
              }}
              placeholder="Anything you want us to know -- your kid's age, what you are looking for, or what you are worried about."
              className="min-h-[110px] border border-[color:rgba(107,78,18,.28)] rounded-[var(--r-md)] mat-paper px-3 py-2 text-[length:var(--t-sm)] text-[color:var(--hide-950)]"
            />

            <label className="flex items-center gap-2 text-[length:var(--t-sm)] text-[color:var(--hide-800)]">
              <input
                type="checkbox"
                checked={consentToContact}
                onChange={(e) => {
                  startFormIfNeeded();
                  setConsentToContact(e.target.checked);
                }}
              />
              <span>Yes, it is okay to contact me.</span>
            </label>

            <button
              type="submit"
              disabled={submitting}
              className="min-h-[44px] border border-[color:rgba(107,78,18,.28)] rounded-[var(--r-md)] bg-[var(--brass-800)] px-4 text-[length:var(--t-sm)] font-bold text-[color:var(--bone-100)] transition hover:bg-[var(--red-highlight)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? 'Sending...' : 'Send this to a coach'}
            </button>

            {confirmation && <p className="text-[length:var(--t-sm)] text-[color:var(--brass-800)]">{confirmation}</p>}
          </form>
        </section>

        <section id="partner-engagement" className="mat-paper rounded-[var(--r-lg)] border border-[color:rgba(107,78,18,.28)] p-[var(--s5)]">
          <h2 className="text-[length:var(--t-md)] font-black text-[color:var(--hide-950)]">WHAT WE ACTUALLY RUN</h2>
          <p className="mt-3 text-[length:var(--t-sm)] leading-7 text-[color:var(--hide-800)]">
            Not everybody in this building is training to fight. Most are not. There are four different reasons people
            train here and none of them is more legitimate than the others.
          </p>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {programCards.map((program) => (
              <article key={program.title} className="border border-[color:rgba(107,78,18,.28)] rounded-[var(--r-md)] mat-paper p-4">
                <p className="text-[length:var(--t-md)] font-bold text-[color:var(--hide-950)]">{program.title}</p>
                <p className="mt-2 text-[length:var(--t-sm)] leading-6 text-[color:var(--hide-800)]">What it is: {program.whatItIs}</p>
                <p className="mt-1 text-[length:var(--t-sm)] leading-6 text-[color:var(--hide-800)]">Who it is for: {program.whoFor}</p>
                <p className="mt-1 text-[length:var(--t-sm)] leading-6 text-[color:var(--hide-800)]">How to start: {program.nextStep}</p>
              </article>
            ))}
          </div>
        </section>

        <section id="public-faq" className="mat-paper rounded-[var(--r-lg)] border border-[color:rgba(107,78,18,.28)] p-[var(--s5)]">
          <h2 className="text-[length:var(--t-md)] font-black text-[color:var(--hide-950)]">QUESTIONS PEOPLE ACTUALLY ASK</h2>
          <div className="mt-4 space-y-2">
            {faqItems.map((item) => {
              const expanded = openFaq === item.question;
              return (
                <article key={item.question} className="border border-[color:rgba(107,78,18,.28)] rounded-[var(--r-md)] mat-paper">
                  <button
                    type="button"
                    onClick={() => toggleFaq(item.question)}
                    aria-expanded={expanded}
                    aria-controls={`faq-panel-${item.question.replace(/[^a-z0-9]/gi, '-').toLowerCase()}`}
                    className="flex min-h-[44px] w-full items-center justify-between px-4 py-2 text-left"
                  >
                    <span className="text-[length:var(--t-sm)] font-semibold text-[color:var(--hide-950)]">{item.question}</span>
                    <span className="font-mono text-[color:var(--brass-800)]">{expanded ? '−' : '+'}</span>
                  </button>
                  {expanded && (
                    <p
                      id={`faq-panel-${item.question.replace(/[^a-z0-9]/gi, '-').toLowerCase()}`}
                      className="border-t-2 border-[color:rgba(107,78,18,.28)] px-4 py-3 text-[length:var(--t-sm)] leading-6 text-[color:var(--hide-800)]"
                    >
                      {item.answer}
                    </p>
                  )}
                </article>
              );
            })}
          </div>
        </section>

        <section className="mat-paper rounded-[var(--r-lg)] border border-[color:rgba(107,78,18,.28)] p-[var(--s5)]">
          <h2 className="text-[length:var(--t-md)] font-black text-[color:var(--hide-950)]">WHAT IS NOT ON THIS PAGE</h2>
          <p className="mt-3 text-[length:var(--t-sm)] leading-7 text-[color:var(--hide-800)]">
            No athlete records, no coach notes, no parent files, no board materials, no admin tools. Those sit behind a
            login and this page cannot see them. The same goes the other way: what your family tells us stays with staff.
          </p>
        </section>

        <section className="mat-paper rounded-[var(--r-lg)] border border-[color:rgba(107,78,18,.28)] p-[var(--s5)]">
          <h2 className="text-[length:var(--t-md)] font-black text-[color:var(--hide-950)]">WHAT HAPPENS AFTER YOU HIT SEND</h2>
          <div className="mt-3 grid gap-2 text-[length:var(--t-sm)] font-mono text-[color:var(--brass-800)]">
            <p>You send the form</p>
            <p>↓</p>
            <p>A staff member reads it. A person, not a script.</p>
            <p>↓</p>
            <p>We work out which coach or program fits</p>
            <p>↓</p>
            <p>Someone contacts you the way you asked to be contacted</p>
          </div>
          <p className="mt-3 text-[length:var(--t-sm)] leading-7 text-[color:var(--hide-800)]">
            No account gets created anywhere in there, and nobody is enrolled in anything until you have talked to a
            human being first.
          </p>
        </section>

        <section className="mat-paper rounded-[var(--r-lg)] border border-[color:rgba(107,78,18,.28)] p-[var(--s5)]">
          <h2 className="text-[length:var(--t-md)] font-black text-[color:var(--hide-950)]">JUMP TO</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {/* Members only -- see note on the portal header button above. */}
            <ShadowChatButton context="Public Quick Links" label="Member SHADOW Chat" />
            {/* Labels now name the section each anchor actually lands on, in
                page order. "Volunteer Recruitment" pointed at the pathway
                chooser and "Partner Engagement" at the programme list, so both
                promised something the destination did not contain. The hrefs
                and section ids are unchanged. */}
            {[
              { label: 'The room', href: '/public#the-room' },
              { label: 'Who coaches', href: '/public#who-coaches' },
              { label: 'Which one is you', href: '/public#volunteer-recruitment' },
              { label: 'Get in touch', href: '/public#interest-intake' },
              { label: 'Programs', href: '/public#partner-engagement' },
              { label: 'Questions', href: '/public#public-faq' },
            ].map((link) => (
              <a
                key={link.label}
                href={link.href}
                onClick={() => addTrace('quick link clicked', `${link.label} -> ${link.href}`)}
                className="btn"
              >
                {link.label}
              </a>
            ))}
          </div>
        </section>

        <section className="mat-paper rounded-[var(--r-lg)] border border-[color:rgba(107,78,18,.28)] p-[var(--s5)]">
          <h2 className="text-[length:var(--t-md)] font-black text-[color:var(--hide-950)]">WHAT YOU HAVE CLICKED ON THIS PAGE</h2>
          <p className="mt-3 text-[length:var(--t-sm)] leading-7 text-[color:var(--hide-800)]">
            This list lives in your browser and nowhere else. It is not sent to us and it disappears when you close the
            tab.
          </p>
          <div className="mt-3 max-h-[220px] space-y-2 overflow-y-auto border border-[color:rgba(107,78,18,.28)] rounded-[var(--r-md)] mat-paper p-3">
            {telemetryTraces.length === 0 && <p className="text-[length:var(--t-sm)] text-[color:var(--hide-800)]">Nothing yet. This fills in as you click around.</p>}
            {telemetryTraces.map((trace, idx) => (
              <div key={`${trace.timestamp}-${idx}`} className="border border-[color:rgba(107,78,18,.28)] rounded-[var(--r-md)] mat-paper p-2 text-[length:var(--t-xs)] text-[color:var(--hide-800)]">
                <p className="font-mono text-[color:var(--brass-800)]">[{trace.timestamp}]</p>
                <p>{trace.event}</p>
                <p>{trace.detail}</p>
              </div>
            ))}
          </div>
        </section>
        </div>
      </div>
      {showSignIn && <SignInOverlay onClose={closeSignIn} />}
    </main>
  );
}