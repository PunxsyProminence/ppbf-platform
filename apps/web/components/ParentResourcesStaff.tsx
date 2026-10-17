'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import { formatGymDate } from '@/src/lib/gymTime';
import { deriveCoachDisplayName } from '@/src/shared/coachDisplayName';

/* PARENT RESOURCES, the staff side (PH-11b): every resource of the gym in any
   state, an add form, and Edit / Publish / Archive on each, against
   /api/pilot/coach/parent-resources. Nothing is deleted: archive is the end.

   The server decides: who may write (coaches and organization admins), whether
   parents can open an internal link (PH-11 Q-A A), and which programs a
   resource may name. A refusal (4xx) is shown in the server's words, or as
   not saved when it gives none; no answer, or a 5xx, may still have been
   saved, so it says to reload and check. A read that did not answer is never
   shown as "no resources".

   Every change names the version it was made from (updated_at, as read); a
   resource someone else changed since is refused (409) and the list can be
   read again. */

export interface StaffResourceItem {
  resource_id: string;
  title: string;
  summary: string;
  resource_type: 'guide' | 'checklist' | 'video' | 'policy';
  destination: string;
  program_id: string | null;
  program_name: string | null;
  state: 'draft' | 'published' | 'archived';
  published_at: string | null;
  updated_at: string;
  written_by: string;
  edited_by: string | null;
  parents_cannot_open: boolean;
  program_archived?: boolean;
}

interface Program { program_id: string; program_name: string }

interface Fields { title: string; summary: string; resource_type: StaffResourceItem['resource_type']; destination: string; program_id: string }

const ROUTE = '/api/pilot/coach/parent-resources';
const TYPES: Array<[StaffResourceItem['resource_type'], string]> = [
  ['guide', 'Guide'], ['checklist', 'Checklist'], ['video', 'Video'], ['policy', 'Policy'],
];
const TYPE_LABEL = Object.fromEntries(TYPES) as Record<StaffResourceItem['resource_type'], string>;
const STATE_LABEL: Record<StaffResourceItem['state'], string> = { draft: 'Draft', published: 'Published', archived: 'Archived' };
const EMPTY: Fields = { title: '', summary: '', resource_type: 'guide', destination: '', program_id: '' };
const BLANK = 'Fill in the title, the summary and the link.';
const UNKNOWN = 'The server did not answer clearly, so this may not have been saved. Reload the page to check.';
const REFUSED = 'That was not saved.';
// The server names a coach it cannot name with the family-facing floor; staff read it as the office.
const COACH_FLOOR = deriveCoachDisplayName(null);
const STAFF_FLOOR = 'Gym office';
const staffName = (name: string) => (name === COACH_FLOOR ? STAFF_FLOOR : name);

type ReadState = { state: 'loading' } | { state: 'failed' } | { state: 'loaded'; items: StaffResourceItem[]; programs: Program[] };

async function readList(): Promise<ReadState> {
  try {
    const response = await fetch(`${apiBase()}${ROUTE}`, { credentials: 'include' });
    const payload = (await response.json().catch(() => null)) as { items?: unknown; programs?: unknown } | null;
    return response.ok && payload && Array.isArray(payload.items) && Array.isArray(payload.programs)
      ? { state: 'loaded', items: payload.items as StaffResourceItem[], programs: payload.programs as Program[] }
      : { state: 'failed' };
  } catch {
    return { state: 'failed' };
  }
}

function fieldsOf(item: StaffResourceItem): Fields {
  return { title: item.title, summary: item.summary, resource_type: item.resource_type, destination: item.destination, program_id: item.program_id ?? '' };
}

function FieldInputs({ id, value, onChange, programs }: Readonly<{
  id: string; value: Fields; onChange: (next: Fields) => void; programs: Program[];
}>) {
  const set = (key: keyof Fields) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    onChange({ ...value, [key]: event.target.value });
  return (
    <>
      <div className="field">
        <label className="t-label" htmlFor={`${id}-title`}>Title</label>
        <input id={`${id}-title`} className="input" value={value.title} onChange={set('title')} maxLength={200} />
      </div>
      <div className="field">
        <label className="t-label" htmlFor={`${id}-summary`}>Summary</label>
        <textarea id={`${id}-summary`} className="textarea" value={value.summary} onChange={set('summary')} maxLength={1000} />
      </div>
      <div className="field">
        <label className="t-label" htmlFor={`${id}-type`}>Type</label>
        <select id={`${id}-type`} className="select" value={value.resource_type} onChange={set('resource_type')}>
          {TYPES.map(([type, label]) => <option key={type} value={type}>{label}</option>)}
        </select>
      </div>
      <div className="field">
        <label className="t-label" htmlFor={`${id}-link`}>Link: an app page starting with / or an https:// address</label>
        <input id={`${id}-link`} className="input" value={value.destination} onChange={set('destination')} />
      </div>
      <div className="field">
        <label className="t-label" htmlFor={`${id}-audience`}>Who sees it</label>
        <select id={`${id}-audience`} className="select" value={value.program_id} onChange={set('program_id')}>
          <option value="">Every family</option>
          {programs.map((p) => <option key={p.program_id} value={p.program_id}>{p.program_name}</option>)}
        </select>
      </div>
    </>
  );
}

export default function ParentResourcesStaff() {
  const [read, setRead] = useState<ReadState>({ state: 'loading' });
  const [draft, setDraft] = useState<Fields>(EMPTY);
  const [publishNow, setPublishNow] = useState(false);
  const [editing, setEditing] = useState<{ id: string; updatedAt: string; fields: Fields } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // reload: the list may be out of date (a 409, or an unclear answer), so offer to read it again.
  const [notice, setNotice] = useState<{ text: string; reload: boolean } | null>(null);
  // n changes on every request, so the same element can be focused again.
  const [focus, setFocus] = useState<{ id: string; n: number } | null>(null);
  const focusOn = (id: string) => setFocus((f) => ({ id, n: (f?.n ?? 0) + 1 }));
  // Set before the first await, so a second tap in the same tick is refused.
  const inFlight = useRef(false);
  const readTicket = useRef(0);

  // Only the newest read may land; an unmounted page drops any read still in flight.
  const load = useCallback(() => {
    const ticket = ++readTicket.current;
    void readList().then((next) => {
      if (ticket === readTicket.current) setRead(next);
    });
  }, []);

  useEffect(() => {
    load();
    return () => { readTicket.current += 1; };
  }, [load]);

  useEffect(() => {
    if (focus) document.getElementById(focus.id)?.focus();
  }, [focus]);

  const fail = (text: string, reload = false) => {
    setNotice({ text, reload });
    focusOn('parent-resources-notice');
  };

  const reload = () => {
    setNotice(null);
    setEditing(null);
    setRead({ state: 'loading' });
    load();
  };

  const send = async (key: string, method: 'POST' | 'PATCH', body: Record<string, unknown>): Promise<StaffResourceItem | null> => {
    if (inFlight.current) return null;
    inFlight.current = true;
    setBusy(key);
    setNotice(null);
    try {
      const response = await fetch(`${apiBase()}${ROUTE}`, {
        method, credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => null)) as { ok?: unknown; item?: StaffResourceItem; error?: unknown } | null;
      if (response.ok && payload?.ok === true && payload.item && typeof payload.item.resource_id === 'string') {
        const item = payload.item;
        setRead((current) => current.state !== 'loaded' ? current
          : { ...current, items: [item, ...current.items.filter((i) => i.resource_id !== item.resource_id)] });
        focusOn(`parent-resource-${item.resource_id}`);
        return item;
      }
      if (response.status >= 400 && response.status < 500) {
        fail(typeof payload?.error === 'string' && payload.error.trim() ? payload.error : REFUSED, response.status === 409);
      } else fail(UNKNOWN, true);
      return null;
    } catch {
      fail(UNKNOWN, true);
      return null;
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };

  const body = (fields: Fields) => ({ ...fields, program_id: fields.program_id || null });
  const blank = (fields: Fields) => !fields.title.trim() || !fields.summary.trim() || !fields.destination.trim();

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    if (blank(draft)) return fail(BLANK);
    if (await send('add', 'POST', { ...body(draft), publish: publishNow })) {
      setDraft(EMPTY);
      setPublishNow(false);
    }
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    if (blank(editing.fields)) return fail(BLANK);
    const sent = { resource_id: editing.id, updated_at: editing.updatedAt, action: 'edit', ...body(editing.fields) };
    if (await send(`edit-${editing.id}`, 'PATCH', sent)) setEditing(null);
  };

  if (read.state === 'loading') return <p className="t-muted">Loading…</p>;
  if (read.state === 'failed') {
    return <p role="alert" className="t-body">Resources could not be loaded. Reload the page to try again.</p>;
  }

  return (
    <div className="space-y-[var(--s5)]">
      {/* Announced once: focus moves to it, so it is not also a live region. */}
      {notice ? (
        <div className="space-y-[var(--s2)]">
          <p id="parent-resources-notice" tabIndex={-1} className="t-body">{notice.text}</p>
          {notice.reload ? <button type="button" className="btn btn--ghost btn--tap" onClick={reload}>Reload the list</button> : null}
        </div>
      ) : null}

      <form onSubmit={add} noValidate aria-label="Add a resource" className="mat-leather space-y-[var(--s3)] rounded-[var(--r-lg)] p-[var(--s4)]">
        <h2 className="t-command text-[length:var(--t-md)]">Add a resource</h2>
        <FieldInputs id="parent-resource-new" value={draft} onChange={setDraft} programs={read.programs} />
        <fieldset className="space-y-[var(--s2)]">
          <legend className="t-label">When</legend>
          <label className="flex min-h-[var(--tap)] items-center gap-[var(--s2)]">
            <input type="radio" name="parent-resource-when" checked={!publishNow} onChange={() => setPublishNow(false)} /> Save as draft
          </label>
          <label className="flex min-h-[var(--tap)] items-center gap-[var(--s2)]">
            <input type="radio" name="parent-resource-when" checked={publishNow} onChange={() => setPublishNow(true)} /> Publish now
          </label>
        </fieldset>
        <button type="submit" className="btn btn--tap" disabled={busy !== null}>{busy === 'add' ? 'Saving…' : 'Add resource'}</button>
      </form>

      {read.items.length === 0 ? <p className="t-muted">No resources have been added yet.</p> : (
        <ul className="space-y-[var(--s3)]" aria-label="Parent resources">
          {read.items.map((item) => {
            // A program no longer active is still this resource's; keep it choosable while editing.
            const programs = item.program_id && !read.programs.some((p) => p.program_id === item.program_id)
              ? [...read.programs, { program_id: item.program_id, program_name: item.program_name ?? 'Its program' }]
              : read.programs;
            const published = item.published_at ? formatGymDate(item.published_at) : null;
            return (
              <li key={item.resource_id} className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                <h3 id={`parent-resource-${item.resource_id}`} tabIndex={-1} className="t-body font-semibold">{item.title}</h3>
                <p className="t-muted mt-[var(--s2)]">
                  {TYPE_LABEL[item.resource_type]} · {STATE_LABEL[item.state]} · {item.program_id ? item.program_name ?? 'One program' : 'Every family'}
                  {published ? ` · First published ${published}` : ''} · Last changed by {staffName(item.edited_by ?? item.written_by)}
                </p>
                {item.parents_cannot_open ? <p className="t-body mt-[var(--s2)]">Parents cannot open this link.</p> : null}
                {item.program_archived ? <p className="t-body mt-[var(--s2)]">Its program is archived.</p> : null}
                {editing?.id === item.resource_id ? (
                  <form onSubmit={save} noValidate aria-label={`Edit ${item.title}`} className="mt-[var(--s3)] space-y-[var(--s3)]">
                    <FieldInputs id={`parent-resource-edit-${item.resource_id}`} value={editing.fields}
                      onChange={(fields) => setEditing((e) => e && { ...e, fields })} programs={programs} />
                    <div className="flex flex-wrap gap-[var(--s2)]">
                      <button type="submit" className="btn btn--tap" disabled={busy !== null}
                        aria-label={busy === `edit-${item.resource_id}` ? `Saving… ${item.title}` : `Save changes to ${item.title}`}>
                        {busy === `edit-${item.resource_id}` ? 'Saving…' : 'Save changes'}
                      </button>
                      <button type="button" className="btn btn--ghost btn--tap" aria-label={`Cancel editing ${item.title}`}
                        onClick={() => { setEditing(null); focusOn(`parent-resource-${item.resource_id}`); }}>Cancel</button>
                    </div>
                  </form>
                ) : (
                  <div className="mt-[var(--s3)] flex flex-wrap gap-[var(--s2)]">
                    {/* One edit at a time: opening another would drop this one's changes. */}
                    {editing === null ? (
                      <button type="button" className="btn btn--ghost btn--tap" disabled={busy !== null} aria-label={`Edit ${item.title}`}
                        onClick={() => { setEditing({ id: item.resource_id, updatedAt: item.updated_at, fields: fieldsOf(item) }); focusOn(`parent-resource-edit-${item.resource_id}-title`); }}>
                        Edit
                      </button>
                    ) : null}
                    {item.state !== 'published' ? (
                      <button type="button" className="btn btn--tap" disabled={busy !== null}
                        aria-label={busy === `publish-${item.resource_id}` ? `Publishing… ${item.title}` : `Publish ${item.title}`}
                        onClick={() => void send(`publish-${item.resource_id}`, 'PATCH', { resource_id: item.resource_id, updated_at: item.updated_at, action: 'publish' })}>
                        {busy === `publish-${item.resource_id}` ? 'Publishing…' : 'Publish'}
                      </button>
                    ) : null}
                    {item.state !== 'archived' ? (
                      <button type="button" className="btn btn--ghost btn--tap" disabled={busy !== null}
                        aria-label={busy === `archive-${item.resource_id}` ? `Archiving… ${item.title}` : `Archive ${item.title}`}
                        onClick={() => void send(`archive-${item.resource_id}`, 'PATCH', { resource_id: item.resource_id, updated_at: item.updated_at, action: 'archive' })}>
                        {busy === `archive-${item.resource_id}` ? 'Archiving…' : 'Archive'}
                      </button>
                    ) : null}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
