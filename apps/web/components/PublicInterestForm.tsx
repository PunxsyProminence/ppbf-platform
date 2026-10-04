'use client';

import { useState, type SyntheticEvent } from 'react';
import { apiBase } from '@/lib/apiBase';
import {
  contactMethodLabels,
  contactMethodOptions,
  programInterestLabels,
  programInterestOptions,
  visitorTypeLabels,
  visitorTypeOptions,
  type ContactMethod,
  type ProgramInterest,
  type VisitorType,
} from './publicInterestOptions';

/* The interest form on the front page (moved from /public, which now forwards
   to /). Posts to /api/pilot/public-interest -- the one unauthenticated write
   endpoint in this app. See that route for the rate limiting, honeypot and
   server-side validation this relies on; nothing here is trusted beyond the
   browser.

   No consent checkbox (Jason, 2026-10-03: "it should be assumed that we would
   contact them if they are requesting info"). Sending the form is the request
   to be contacted, and the route records it that way. */

const fallbackAddress = '220 N Jefferson St, Punxsutawney, PA 15767';

export default function PublicInterestForm() {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [visitorType, setVisitorType] = useState<VisitorType>('General Visitor');
  const [programInterest, setProgramInterest] = useState<ProgramInterest>('General Information');
  const [preferredContactMethod, setPreferredContactMethod] = useState<ContactMethod>('Email');
  const [message, setMessage] = useState('');
  // Honeypot: real visitors never see or fill this in.
  const [website, setWebsite] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) {
      return;
    }

    setSubmitting(true);
    setConfirmation('');
    try {
      // credentials: 'omit' -- a signed-out visitor's form; no session cookie
      // is needed or wanted.
      const response = await fetch(`${apiBase()}/api/pilot/public-interest`, {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          full_name: fullName,
          email,
          phone: phone || undefined,
          visitor_type: visitorType,
          program_interest: programInterest,
          preferred_contact_method: preferredContactMethod,
          message: message || undefined,
          website,
        }),
      });

      const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };

      if (!response.ok || !payload.ok) {
        setConfirmation(
          payload.error
          || `Something went wrong sending this and it did not go through. Try again, or just come by: ${fallbackAddress}.`,
        );
        return;
      }

      setConfirmation('Got it -- thanks. A staff member reads every one of these, and someone will get back to you the way you asked.');
      setFullName('');
      setEmail('');
      setPhone('');
      setMessage('');
    } catch {
      setConfirmation(`The connection dropped and this was not sent. Try again, or just come by: ${fallbackAddress}.`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="mt-[var(--s5)] grid gap-[var(--s3)]" onSubmit={handleSubmit} aria-label="Tell us you are interested">
      {/* Honeypot: visually hidden and out of tab order. */}
      <input
        type="text"
        name="website"
        value={website}
        onChange={(e) => setWebsite(e.target.value)}
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="absolute h-0 w-0 opacity-0"
        style={{ position: 'absolute', left: '-9999px' }}
      />
      <label className="grid gap-[var(--s1)]">
        <span className="t-label">Your name</span>
        <input value={fullName} onChange={(e) => setFullName(e.target.value)} className="input" autoComplete="name" required />
      </label>
      <label className="grid gap-[var(--s1)]">
        <span className="t-label">Email</span>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="input" autoComplete="email" required />
      </label>
      <label className="grid gap-[var(--s1)]">
        <span className="t-label">Phone (only if you want a call)</span>
        <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} className="input" autoComplete="tel" />
      </label>
      <label className="grid gap-[var(--s1)]">
        <span className="t-label">Who you are</span>
        <select value={visitorType} onChange={(e) => setVisitorType(e.target.value as VisitorType)} className="input">
          {visitorTypeOptions.map((option) => (
            <option key={option} value={option}>{visitorTypeLabels[option]}</option>
          ))}
        </select>
      </label>
      <label className="grid gap-[var(--s1)]">
        <span className="t-label">What you are interested in</span>
        <select value={programInterest} onChange={(e) => setProgramInterest(e.target.value as ProgramInterest)} className="input">
          {programInterestOptions.map((option) => (
            <option key={option} value={option}>{programInterestLabels[option]}</option>
          ))}
        </select>
      </label>
      <label className="grid gap-[var(--s1)]">
        <span className="t-label">How to reach you</span>
        <select value={preferredContactMethod} onChange={(e) => setPreferredContactMethod(e.target.value as ContactMethod)} className="input">
          {contactMethodOptions.map((option) => (
            <option key={option} value={option}>{contactMethodLabels[option]}</option>
          ))}
        </select>
      </label>
      <label className="grid gap-[var(--s1)]">
        <span className="t-label">Message</span>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Anything you want us to know -- your kid's age, what you are looking for, or what you are worried about."
          className="input min-h-[110px]"
        />
      </label>

      <button type="submit" disabled={submitting} className="btn disabled:cursor-not-allowed disabled:opacity-60">
        {submitting ? 'Sending...' : 'Send this to a coach'}
      </button>

      {confirmation && <p className="t-body" role="status">{confirmation}</p>}

      {/* Jason's wording, relayed by overwatch 2026-10-04. The Privacy link
          comes with the privacy page, which is a separate lane. */}
      <p className="t-muted">This form is for people 13 or older.</p>
      <p className="t-muted">We use what you send only to answer you. We do not sell or share it.</p>
    </form>
  );
}
