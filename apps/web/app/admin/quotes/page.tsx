'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';

// The quotes library: the gym's own sayings, motivational lines and boxing
// quotes, kept per organization. A quote is switched off, never deleted -- what
// was on the wall stays on the record. Nothing here decides anything about an
// athlete.

type QuoteType = 'gym_saying' | 'motivational' | 'boxing_quote';
type QuoteShown = 'anywhere' | 'after-hard-session' | 'at-a-milestone';

interface QuoteRow {
  quote_id: string;
  quote_text: string;
  speaker: string;
  quote_type: QuoteType;
  source: string;
  shown: QuoteShown[];
  active: boolean;
}

const TYPE_LABELS: Record<QuoteType, string> = {
  gym_saying: 'Gym saying',
  motivational: 'Motivational',
  boxing_quote: 'Boxing quote',
};

const SHOWN_LABELS: Record<QuoteShown, string> = {
  anywhere: 'Anywhere',
  'after-hard-session': 'After a hard session',
  'at-a-milestone': 'At a milestone',
};

const EMPTY_FORM = {
  quote_text: '',
  speaker: '',
  quote_type: 'gym_saying' as QuoteType,
  source: '',
  shown: 'anywhere' as QuoteShown,
  active: true,
};

export default function QuotesPage() {
  const [items, setItems] = useState<QuoteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);

  const reload = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`${apiBase()}/api/pilot/quotes`, { credentials: 'include', signal });
    if (!response.ok) throw new Error('Unable to load the quotes.');
    const payload = (await response.json()) as { quotes?: QuoteRow[] };
    setItems(payload.quotes ?? []);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        await reload(controller.signal);
        if (controller.signal.aborted) return;
        setErrorMessage(null);
        setLoading(false);
      } catch (error) {
        if (controller.signal.aborted) return;
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load the quotes.');
        setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [reload]);

  async function send(method: 'POST' | 'PATCH', body: Record<string, unknown>, failure: string) {
    setBusy(true);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/quotes`, {
        method,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `${failure} (${response.status})`);
      }
      await reload();
      setErrorMessage(null);
      return true;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : failure);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const handleSave = async () => {
    if (!form.quote_text.trim()) {
      setErrorMessage('A quote needs its words.');
      return;
    }
    const fields = {
      quote_text: form.quote_text,
      speaker: form.speaker,
      quote_type: form.quote_type,
      source: form.source,
      shown: [form.shown],
    };
    const saved = editingId
      ? await send('PATCH', { quote_id: editingId, ...fields }, 'Unable to save the quote.')
      : await send('POST', { ...fields, active: form.active }, 'Unable to add the quote.');
    if (saved) {
      setForm(EMPTY_FORM);
      setEditingId(null);
    }
  };

  const startEdit = (quote: QuoteRow) => {
    setEditingId(quote.quote_id);
    setForm({
      quote_text: quote.quote_text,
      speaker: quote.speaker,
      quote_type: quote.quote_type,
      source: quote.source,
      // The form picks one moment; a quote stored with several keeps the broadest.
      shown: quote.shown.includes('anywhere') ? 'anywhere' : quote.shown[0] ?? 'anywhere',
      active: quote.active,
    });
  };

  return (
    <RoleSessionGate allowedRoles={['admin']}>
      <main className="room room--office min-h-screen bg-[var(--hide-950)] p-[var(--s5)] text-[color:var(--bone-200)]">
        <div className="mx-auto w-full max-w-4xl">
          <header className="mb-[var(--s5)]">
            <p className="t-eyebrow">Admin</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Quotes</h1>
            <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
              The gym&apos;s own sayings, motivational lines and boxing quotes. Only quotes switched on
              can be shown. A quote is switched off, never deleted, so what was on the wall stays on the
              record.
            </p>
          </header>

          {errorMessage && (
            <div className="alert alert--critical" role="alert">
              <span className="alert-icon" aria-hidden="true">✕</span>
              <div className="alert-body">
                <p className="alert-title">Failed</p>
                <p className="alert-msg">{errorMessage}</p>
              </div>
            </div>
          )}

          <section className="mat-leather mb-[var(--s5)] rounded-[var(--r-lg)] p-[var(--s4)]">
            <h2 className="t-label mb-[var(--s3)]">{editingId ? 'Edit quote' : 'Add a quote'}</h2>
            <div className="grid gap-[var(--s3)] md:grid-cols-2">
              <div className="field md:col-span-2">
                <label className="t-label" htmlFor="quote-text">Quote</label>
                <textarea id="quote-text" className="input" rows={2} maxLength={280} value={form.quote_text}
                  onChange={(e) => setForm((f) => ({ ...f, quote_text: e.target.value }))} />
              </div>
              <div className="field">
                <label className="t-label" htmlFor="quote-speaker">Said by (optional)</label>
                <input id="quote-speaker" className="input" value={form.speaker}
                  onChange={(e) => setForm((f) => ({ ...f, speaker: e.target.value }))} />
              </div>
              <div className="field">
                <label className="t-label" htmlFor="quote-source">Source or citation (optional)</label>
                <input id="quote-source" className="input" value={form.source}
                  onChange={(e) => setForm((f) => ({ ...f, source: e.target.value }))} />
              </div>
              <div className="field">
                <label className="t-label" htmlFor="quote-type">Type</label>
                <select id="quote-type" className="input" value={form.quote_type}
                  onChange={(e) => setForm((f) => ({ ...f, quote_type: e.target.value as QuoteType }))}>
                  {(Object.keys(TYPE_LABELS) as QuoteType[]).map((type) => (
                    <option key={type} value={type}>{TYPE_LABELS[type]}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label className="t-label" htmlFor="quote-shown">Shown</label>
                <select id="quote-shown" className="input" value={form.shown}
                  onChange={(e) => setForm((f) => ({ ...f, shown: e.target.value as QuoteShown }))}>
                  {(Object.keys(SHOWN_LABELS) as QuoteShown[]).map((moment) => (
                    <option key={moment} value={moment}>{SHOWN_LABELS[moment]}</option>
                  ))}
                </select>
              </div>
              {!editingId && (
                <label className="t-body flex items-center gap-[var(--s2)] md:col-span-2" htmlFor="quote-active">
                  <input id="quote-active" type="checkbox" checked={form.active}
                    onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))} />
                  Switch it on now
                </label>
              )}
            </div>
            <div className="mt-[var(--s4)] flex gap-[var(--s2)]">
              <button type="button" className="btn" disabled={busy} onClick={() => void handleSave()}>
                {busy ? 'Saving…' : editingId ? 'Save changes' : 'Add quote'}
              </button>
              {editingId && (
                <button type="button" className="btn btn--ghost" disabled={busy}
                  onClick={() => { setEditingId(null); setForm(EMPTY_FORM); }}>
                  Cancel
                </button>
              )}
            </div>
          </section>

          {loading ? (
            <div className="flex justify-center py-[var(--s6)]">
              <span className="working">Loading quotes...</span>
            </div>
          ) : items.length === 0 && !errorMessage ? (
            <div className="mat-leather rounded-[var(--r-lg)]">
              <div className="empty">
                <div className="empty-title">No quotes yet</div>
                <p className="empty-msg mx-auto">An empty library is an honest blank. Add the first line above.</p>
              </div>
            </div>
          ) : (
            <ul className="space-y-[var(--s2)]">
              {items.map((quote) => (
                <li key={quote.quote_id} className="mat-leather rounded-[var(--r-md)] p-[var(--s3)]">
                  <div className="flex flex-wrap items-center gap-[var(--s3)]">
                    {quote.active ? (
                      <span className="badge badge--cleared"><i aria-hidden="true">●</i>on</span>
                    ) : (
                      <span className="badge badge--filed"><i aria-hidden="true">▣</i>off</span>
                    )}
                    <span className="t-data" style={{ fontSize: 'var(--t-xs)' }}>
                      {TYPE_LABELS[quote.quote_type]} · {quote.shown.map((m) => SHOWN_LABELS[m]).join(', ')}
                    </span>
                    <button type="button" className="btn btn--ghost" disabled={busy}
                      onClick={() => startEdit(quote)}>
                      Edit
                    </button>
                    <button type="button" className="btn btn--ghost" disabled={busy}
                      onClick={() => void send('PATCH', { quote_id: quote.quote_id, active: !quote.active }, 'Unable to change the quote.')}>
                      {quote.active ? 'Switch off' : 'Switch on'}
                    </button>
                  </div>
                  <p className="t-body mt-[var(--s2)] font-semibold text-[color:var(--bone-100)]">{quote.quote_text}</p>
                  {quote.speaker || quote.source ? (
                    <p className="t-body mt-[var(--s1)] text-[color:var(--bone-300)]" style={{ fontSize: 'var(--t-sm)' }}>
                      {[quote.speaker, quote.source].filter(Boolean).join(' — ')}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          <div className="mt-[var(--s5)]">
            <Link href="/admin" className="btn btn--ghost">Back to Admin</Link>
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}
