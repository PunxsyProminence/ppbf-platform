'use client';

import { useEffect, useState } from 'react';

import { apiBase } from '@/lib/apiBase';

/**
 * THE GYM'S PROFILE, EDITED BY ITS ADMIN (lane L31 P3, issue #1469).
 *
 * One form for the stored profile every page reads: names, website, contact
 * details, addresses and head coach. Saving is two presses -- the first names
 * the gym and says every public page changes -- like the other writes on the
 * admin screens. The legal name is shown, not edited: it is the gym's name of
 * record, set by the platform owner.
 */

type Field =
  | 'brand' | 'short_name' | 'common_name' | 'website_url' | 'domain' | 'ein'
  | 'contact_email' | 'donations_email' | 'grants_email' | 'established' | 'town'
  | 'service_area' | 'service_area_short'
  | 'physical_street' | 'physical_city' | 'physical_region' | 'physical_postal_code'
  | 'mailing_address' | 'head_coach_name';

type Profile = Record<Field, string>;

const GROUPS: ReadonlyArray<{ title: string; fields: ReadonlyArray<[Field, string, string?]> }> = [
  {
    title: 'Names',
    fields: [
      ['brand', 'Public name (as the gym writes it)'],
      ['short_name', 'Short name'],
      ['common_name', 'Name in running text'],
    ],
  },
  {
    title: 'Website and contact',
    fields: [
      ['website_url', 'Website', 'https://www.example.org'],
      ['domain', 'Domain', 'example.org'],
      ['contact_email', 'Contact email'],
      ['donations_email', 'Donations email'],
      ['grants_email', 'Grants email'],
    ],
  },
  {
    title: 'Where the gym is',
    fields: [
      ['physical_street', 'Street'],
      ['physical_city', 'City'],
      ['physical_region', 'State'],
      ['physical_postal_code', 'ZIP code'],
      ['mailing_address', 'Mailing address'],
      ['town', 'Town (as the copy names it)'],
      ['service_area', 'Area served'],
      ['service_area_short', 'Area served, short form'],
    ],
  },
  {
    title: 'Organization',
    fields: [
      ['ein', 'EIN'],
      ['established', 'Year established'],
      ['head_coach_name', 'Head coach'],
    ],
  },
];

const EMPTY = Object.fromEntries(GROUPS.flatMap((group) => group.fields.map(([field]) => [field, '']))) as Profile;
const LABELS = Object.fromEntries(GROUPS.flatMap((group) => group.fields.map(([field, label]) => [field, label]))) as Record<Field, string>;

/** The server names fields by their stored names; the screen names them as its labels do. */
function inLabels(message: string): string {
  return (Object.keys(LABELS) as Field[]).reduce(
    (text, field) => text.replace(new RegExp(`\\b${field}\\b`, 'g'), `"${LABELS[field]}"`),
    message,
  );
}

/** What a save changes, said truthfully (PROPOSED wording). */
function reachSentence(publicPages: boolean, gymName: string): string {
  return publicPages
    ? `Saves ${gymName}'s profile. The homepage, the privacy page, print sheets, the wall and the sign-in email show it on their next load, within a minute; a wall or sheet already open shows it once reloaded.`
    : `Saves ${gymName}'s profile. The public pages, print sheets, wall and sign-in email name the platform's operating gym, not this one, so they do not change.`;
}

export default function GymProfileForm() {
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable' | 'sign_in'>('loading');
  const [publicPages, setPublicPages] = useState(false);
  const [legalName, setLegalName] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile>(EMPTY);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/admin/organization-profile`, { credentials: 'include' });
        if (response.status === 401 || response.status === 403) {
          if (!cancelled) setState('sign_in');
          return;
        }
        if (!response.ok) throw new Error(`status ${response.status}`);
        const data = (await response.json()) as {
          legal_name?: string | null;
          profile?: Partial<Profile> | null;
          public_pages?: boolean;
        };
        if (cancelled) return;
        setLegalName(data.legal_name ?? null);
        setPublicPages(data.public_pages === true);
        setProfile({ ...EMPTY, ...(data.profile ?? {}) });
        setState('ready');
      } catch {
        if (!cancelled) setState('unavailable');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function edit(field: Field, value: string) {
    // Any edit takes the arming back: the second press saves what the first named.
    setArmed(false);
    setNotice(null);
    setProfile((current) => ({ ...current, [field]: value }));
  }

  async function save() {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/organization-profile`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; profile?: Profile };
      if (!response.ok || !data.ok) throw new Error(inLabels(data.error || 'The profile was not saved.'));
      if (data.profile) setProfile({ ...EMPTY, ...data.profile });
      setNotice({
        tone: 'ok',
        text: publicPages
          ? 'Saved. Pages show it on their next load, within a minute; a wall or sheet already open shows it once reloaded.'
          : 'Saved for this gym. The public pages name the platform’s operating gym, so they do not change.',
      });
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'The profile was not saved.' });
    } finally {
      setArmed(false);
      setBusy(false);
    }
  }

  if (state === 'loading') return <p className="t-muted">Reading the gym profile...</p>;
  if (state === 'unavailable') return <p className="t-muted">The gym profile could not be read just now.</p>;
  if (state === 'sign_in') return <p className="t-muted">Sign in again with Microsoft to edit the gym profile.</p>;

  const gymName = profile.brand.trim() || 'the gym';
  return (
    <form
      className="space-y-[var(--s5)]"
      aria-label="Gym profile"
      onSubmit={(event) => {
        event.preventDefault();
      }}
    >
      <p className="t-body">
        Legal name (the gym&apos;s name of record, set by the platform owner): <strong>{legalName ?? 'not on file'}</strong>
      </p>
      {GROUPS.map((group) => (
        <fieldset key={group.title} className="mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.14)] p-[var(--s4)]">
          <legend className="t-label px-[var(--s2)]">{group.title}</legend>
          <div className="grid gap-[var(--s3)] md:grid-cols-2">
            {group.fields.map(([field, label, placeholder]) => (
              <label key={field} className="block">
                <span className="t-label">{label}</span>
                <input
                  className="input mt-[var(--s1)] w-full"
                  name={field}
                  value={profile[field]}
                  placeholder={placeholder}
                  disabled={busy}
                  onChange={(event) => edit(field, event.target.value)}
                />
              </label>
            ))}
          </div>
        </fieldset>
      ))}

      {notice ? (
        <p className="t-body" role="status">{notice.text}</p>
      ) : null}

      {armed ? (
        <div className="space-y-[var(--s2)]">
          <p className="t-body">{reachSentence(publicPages, gymName)}</p>
          <div className="flex flex-wrap gap-[var(--s2)]">
            <button type="button" className="btn" disabled={busy} onClick={() => void save()}>
              {busy ? 'Saving...' : `Save ${gymName}'s Profile`}
            </button>
            <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => setArmed(false)}>
              Keep Editing
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn" disabled={busy} onClick={() => setArmed(true)}>
          Save Gym Profile
        </button>
      )}
    </form>
  );
}
