'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { apiBase } from '@/lib/apiBase';
import {
  askLibrary,
  claimStatusLabel,
  LibraryResearchError,
  type LibraryEvidenceItem,
} from '@/client/libraryResearch';
import { formatGymClock24 } from '@/src/lib/gymTime';

interface QAMessage {
  id: string;
  type: 'user' | 'system' | 'research';
  text: string;
  timestamp: string;
  source?: string;
  evidence?: LibraryEvidenceItem[];
}

interface ShadowResearchSignal {
  event_id: number;
  source_event_name: string;
  evidence_label: string | null;
  source_status: string;
  review_state: 'pending_review' | 'approved' | 'rejected' | 'promoted' | 'unknown';
}

/* A paper-ground caption label; the sheet's .t-label is tuned for leather. */
const PAPER_LABEL = 'font-mono text-[length:var(--t-xs)] font-bold uppercase tracking-[0.13em] text-[color:var(--hide-600)]';

export default function ResearchQAChatPage() {
  const [messages, setMessages] = useState<QAMessage[]>([
    {
      id: '0',
      type: 'system',
      text: "The Library searches your organization's approved evidence. Answers come only from sources a reviewer approved -- nothing here is generated or guessed. No match means the question gets logged as a research need.",
      timestamp: formatGymClock24(new Date(), { seconds: true }) ?? '',
    },
  ]);
  const [userInput, setUserInput] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [researchNotes, setResearchNotes] = useState<string>('');
  const [shadowSignals, setShadowSignals] = useState<ShadowResearchSignal[]>([]);
  const [signalError, setSignalError] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/shadow/research-projection`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ limit: 20 }),
        });

        if (!response.ok) {
          throw new Error('Unable to load SHADOW research stream.');
        }

        const payload = (await response.json()) as { items?: ShadowResearchSignal[] };
        setShadowSignals(payload.items ?? []);
        setSignalError('');
      } catch (error) {
        setShadowSignals([]);
        setSignalError(error instanceof Error ? error.message : 'Unable to load SHADOW research stream.');
      }
    })();
  }, []);

  function addMessage(type: QAMessage['type'], text: string, source?: string, evidence?: LibraryEvidenceItem[]) {
    const newMessage: QAMessage = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      text,
      timestamp: formatGymClock24(new Date(), { seconds: true }) ?? '',
      source,
      evidence,
    };
    setMessages((prev) => [...prev, newMessage]);
  }

  // The Library answers from approved evidence or says plainly that it has
  // none -- the keyword if/else this replaces answered every question with
  // canned strings while the real chat pointed users here for evidence.
  async function handleSendMessage(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    const question = userInput.trim();
    if (!question || isSearching) return;

    addMessage('user', question);
    setUserInput('');
    setIsSearching(true);
    try {
      const result = await askLibrary(apiBase(), question);
      addMessage('research', result.answer, claimStatusLabel(result.status), result.evidence);
      if (result.status === 'unsupported' && result.researchRequirementId !== null) {
        addMessage(
          'system',
          `This gap is now research requirement #${result.researchRequirementId} -- it will show up in the research queue for staff to source.`,
        );
      }
    } catch (error) {
      const message = error instanceof LibraryResearchError
        ? error.safeMessage
        : 'The Library could not answer right now. Try again shortly.';
      addMessage('system', message);
    } finally {
      setIsSearching(false);
    }
  }

  // The note goes into this page's message list and nowhere else. There is no
  // notes table and no write, so the confirmation has to say so.
  function handleAddNote(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    const note = researchNotes.trim();
    if (!note) return;

    addMessage('user', `Note: ${note}`);
    addMessage(
      'system',
      'This note stays in this browser session only. It is not stored anywhere, and it is gone when you reload or leave the page.',
    );
    setResearchNotes('');
  }

  return (
    /* Room--file: the Library stands in the research room -- cork wall,
       gooseneck light. The conversation itself is a leather desk blotter and
       every answer from approved evidence arrives as a paper slip on it. */
    <main className="room--file min-h-screen bg-[var(--hide-950)]">
      <header className="mat-leather--raised border-b border-[color:rgba(212,175,74,.22)] px-[var(--s5)] py-[var(--s5)]">
        <div className="mx-auto flex w-full max-w-[1200px] flex-wrap items-end justify-between gap-[var(--s4)]">
          <div>
            <p className="t-eyebrow">Research Lab</p>
            <h1 className="t-command mt-[var(--s2)]" style={{ fontSize: 'var(--t-xl)' }}>
              The Library
            </h1>
            <p className="t-muted mt-[var(--s2)]">Ask. Learn. Document. No fancy talk.</p>
          </div>
          <div className="text-right">
            <p className="t-label">PPBF Fight Card</p>
            <p className="plaque mt-[var(--s2)]">● LIVE</p>
          </div>
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-[1200px] gap-[var(--s5)] p-[var(--s5)] lg:grid-cols-[var(--split-major)_var(--split-minor)]">
        {/* CHAT: the riveted frame holds the conversation. */}
        <section aria-label="Library conversation" className="frame self-start">
          <span className="rivet rivet--tl" />
          <span className="rivet rivet--tr" />
          <span className="rivet rivet--bl" />
          <span className="rivet rivet--br" />
          <div className="frame-in mat-leather p-[var(--s5)]">
            {/* Messages */}
            <div
              role="log"
              aria-live="polite"
              aria-relevant="additions"
              className="mb-[var(--s5)] max-h-[500px] space-y-[var(--s4)] overflow-y-auto pr-[var(--s2)]"
            >
              {messages.map((msg) => (
                <div key={msg.id} className={`flex gap-[var(--s3)] ${msg.type === 'user' ? 'justify-end' : 'justify-start'}`}>
                  {msg.type === 'research' ? (
                    /* An answer from approved evidence is a printed record --
                       a paper slip laid on the leather. */
                    <div className="mat-paper max-w-[52ch] rounded-[var(--r-sm)] px-[var(--s4)] py-[var(--s3)]">
                      <p className="t-typed text-[length:var(--t-sm)] leading-relaxed">{msg.text}</p>
                      {msg.evidence?.length ? (
                        <div className="mt-[var(--s3)] border-t border-[color:rgba(51,41,27,.26)] pt-[var(--s3)]">
                          <p className={PAPER_LABEL}>Sources</p>
                          <ul className="mt-[var(--s2)] space-y-[var(--s2)]">
                            {msg.evidence.map((item, index) => (
                              <li key={`${msg.id}-ev-${index}`} className="text-[length:var(--t-xs)] leading-relaxed">
                                <span className="font-semibold">
                                  {item.sourceTitle} (tier {item.authorityTier}) — {item.documentName}
                                </span>
                                <span className="mt-[var(--s1)] block opacity-80">“{item.snippet}”</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                      <div className="mt-[var(--s2)] flex items-center justify-between gap-[var(--s3)]">
                        <p className="font-mono text-[length:var(--t-xs)] text-[color:var(--hide-600)]">{msg.timestamp}</p>
                        {msg.source && <p className={PAPER_LABEL}>{msg.source}</p>}
                      </div>
                    </div>
                  ) : (
                    /* User questions and system notices stay on the leather:
                       raised hide for the asker, recessed dark for the desk
                       clerk's notes. */
                    <div
                      className={`max-w-[52ch] rounded-[var(--r-sm)] px-[var(--s4)] py-[var(--s3)] ${
                        msg.type === 'user'
                          ? 'mat-leather--raised border border-[color:rgba(212,175,74,.28)]'
                          : 'border border-[color:var(--hide-600)] bg-[rgba(0,0,0,.28)]'
                      }`}
                    >
                      <p className={`text-[length:var(--t-sm)] leading-relaxed ${msg.type === 'user' ? 'text-[color:var(--bone-100)]' : 'text-[color:var(--bone-300)]'}`}>
                        {msg.text}
                      </p>
                      <div className="mt-[var(--s2)] flex items-center justify-between gap-[var(--s3)]">
                        <p className="font-mono text-[length:var(--t-xs)] text-[color:var(--bone-400)]">{msg.timestamp}</p>
                        {msg.source && <p className="t-label">{msg.source}</p>}
                      </div>
                    </div>
                  )}
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <form onSubmit={handleSendMessage} className="flex flex-wrap gap-[var(--s3)]">
              <input
                type="text"
                value={userInput}
                onChange={(e) => setUserInput(e.target.value)}
                placeholder="Ask the Library -- answers come only from approved sources"
                disabled={isSearching}
                className="input min-w-[220px] flex-1"
              />
              <button type="submit" disabled={isSearching} className="btn disabled:cursor-not-allowed disabled:opacity-60">
                {isSearching ? 'Searching…' : 'Ask'}
              </button>
            </form>
          </div>
        </section>

        {/* RIGHT PANEL: NOTES & LINKS */}
        <aside className="space-y-[var(--s4)]">
          {/* Research Notes */}
          <section className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s4)]">
            <h2 className="t-command" style={{ fontSize: 'var(--t-sm)' }}>Notes</h2>
            <p className="t-muted mt-[var(--s2)]">Session scratchpad. Nothing typed here is stored.</p>
            <form onSubmit={handleAddNote} className="mt-[var(--s3)] space-y-[var(--s3)]">
              <textarea
                value={researchNotes}
                onChange={(e) => setResearchNotes(e.target.value)}
                placeholder="Write your findings..."
                className="textarea h-[89px]"
              />
              <button type="submit" className="btn btn--ghost w-full">
                Add Note To Transcript
              </button>
            </form>
          </section>

          {/* Quick Links */}
          <nav aria-label="Research navigation" className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.14)] p-[var(--s4)]">
            <h2 className="t-label">Navigate</h2>
            <div className="mt-[var(--s3)] grid gap-[var(--s3)]">
              <Link href="/research" className="btn btn--ghost justify-start">
                Research Intake
              </Link>
              <Link href="/evidence" className="btn btn--ghost justify-start">
                Evidence Review
              </Link>
              <Link href="/operations" className="btn btn--ghost justify-start">
                Operations Hub
              </Link>
              <Link href="/admin/shadow" className="btn btn--ghost justify-start">
                SHADOW (Admin)
              </Link>
            </div>
          </nav>

          <section className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.14)] p-[var(--s4)]">
            <h2 className="t-label">SHADOW Research Stream</h2>
            {signalError ? <p className="t-body mt-[var(--s3)]">{signalError}</p> : null}
            {!signalError && shadowSignals.length === 0 ? (
              <p className="t-muted mt-[var(--s3)]">No SHADOW research signals available.</p>
            ) : null}
            <div className="mt-[var(--s3)] space-y-[var(--s3)]">
              {shadowSignals.slice(0, 6).map((signal) => (
                <div key={signal.event_id} className="mat-leather--raised rounded-[var(--r-sm)] px-[var(--s3)] py-[var(--s2)]">
                  <p className="t-body font-semibold text-[color:var(--bone-100)]">{signal.source_event_name}</p>
                  {/* Law 4: stream facts are records -- mono voice. */}
                  <p className="t-data mt-[var(--s1)] text-[color:var(--bone-300)]">
                    Label: {signal.evidence_label || 'none'}
                    <span className="block">Source: {signal.source_status}</span>
                    <span className="block">State: {signal.review_state}</span>
                  </p>
                </div>
              ))}
            </div>
          </section>
        </aside>
      </div>
    </main>
  );
}
