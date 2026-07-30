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

export default function ResearchQAChatPage() {
  const [messages, setMessages] = useState<QAMessage[]>([
    {
      id: '0',
      type: 'system',
      text: "The Library searches your organization's approved evidence. Answers come only from sources a reviewer approved -- nothing here is generated or guessed. No match means the question gets logged as a research need.",
      timestamp: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
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
      timestamp: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
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

  function handleSaveNote(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!researchNotes.trim()) return;

    addMessage('user', `Saved note: ${researchNotes.substring(0, 50)}...`);
    addMessage('research', `✓ Research note captured. ${researchNotes.length} characters logged.`);
    setResearchNotes('');
  }

  return (
    <main className="min-h-screen bg-[#0a0a0a] text-[#e8d7c6]">
      {/* ROUGH OLD-SCHOOL BOXING HEADER */}
      <header className="border-b-4 border-[#d4a574] bg-[#1a1a1a] px-4 py-4 md:px-8 md:py-6">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
          <div>
            <p className="text-[10px] font-mono uppercase tracking-[0.3em] text-[#d4a574]">Research Lab</p>
            <h1 className="font-display text-2xl font-black tracking-tight text-[#e8d7c6] md:text-3xl">The Library</h1>
            <p className="mt-1 text-xs text-[#b0a095]">Ask. Learn. Document. No fancy talk.</p>
          </div>
          <div className="text-right">
            <p className="font-mono text-[10px] text-[#8a8a8a]">PPBF Fight Card</p>
            <p className="text-xs font-bold text-[#8b4444]">LIVE</p>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-6xl gap-6 p-4 lg:grid-cols-[1fr_300px] md:p-8">
        {/* CHAT */}
        <section className="border-4 border-[#d4a574] bg-[#0f0f0f] p-6 shadow-2xl shadow-black/60">
          {/* Messages */}
          <div className="mb-6 max-h-[500px] space-y-3 overflow-y-auto bg-[#050505] p-4 font-mono text-sm">
            {messages.map((msg) => {
              let messageTone = 'border-2 border-[#d4a574] bg-[#3a3020] text-[#e8d7c6]';
              if (msg.type === 'user') {
                messageTone = 'border-2 border-[#8b4444] bg-[#3a2a2a] text-[#8b4444]';
              } else if (msg.type === 'system') {
                messageTone = 'border-2 border-[#4a4a4a] bg-[#1a1a1a] text-[#b0a095]';
              }

              return (
              <div key={msg.id} className={`flex gap-3 ${msg.type === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-md px-3 py-2 ${messageTone}`}>
                  <p className="text-xs leading-5">{msg.text}</p>
                  {msg.evidence?.length ? (
                    <div className="mt-2 border-t border-[#5a4a3a] pt-2">
                      <p className="text-[9px] font-bold uppercase tracking-[0.12em] text-[#d4a574]">Sources</p>
                      <ul className="mt-1 space-y-1">
                        {msg.evidence.map((item, index) => (
                          <li key={`${msg.id}-ev-${index}`} className="text-[10px] leading-4 text-[#cfbfae]">
                            <span className="font-semibold text-[#e8d7c6]">
                              {item.sourceTitle} (tier {item.authorityTier}) — {item.documentName}
                            </span>
                            <span className="mt-0.5 block opacity-80">“{item.snippet}”</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <p className="text-[9px] opacity-50">{msg.timestamp}</p>
                    {msg.source && <p className="text-[9px] text-[#d4a574]">{msg.source}</p>}
                  </div>
                </div>
              </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <form onSubmit={handleSendMessage} className="flex gap-3">
            <input
              type="text"
              value={userInput}
              onChange={(e) => setUserInput(e.target.value)}
              placeholder="Ask the Library -- answers come only from approved sources"
              disabled={isSearching}
              className="flex-1 border-2 border-[#d4a574] bg-[#1a1a1a] px-3 py-2 text-sm text-[#e8d7c6] placeholder-[#666666] outline-none transition focus:border-[#d4a574] focus:bg-[#3a3020]"
            />
            <button
              type="submit"
              disabled={isSearching}
              className="border-2 border-[#d4a574] bg-[#1f1f1f] px-4 py-2 text-xs font-mono font-bold text-[#d4a574] transition hover:border-[#d4a574] hover:bg-[#3a3020] hover:text-[#e8d7c6] disabled:opacity-50"
            >
              {isSearching ? 'Searching…' : 'Ask'}
            </button>
          </form>
        </section>

        {/* RIGHT PANEL: NOTES & LINKS */}
        <aside className="space-y-4">
          {/* Research Notes */}
          <section className="border-4 border-[#d4a574] bg-[#0d0a08] p-4">
            <p className="text-xs font-mono uppercase tracking-[0.2em] text-[#d4a574]">Notes</p>
            <form onSubmit={handleSaveNote} className="mt-3 space-y-2">
              <textarea
                value={researchNotes}
                onChange={(e) => setResearchNotes(e.target.value)}
                placeholder="Write your findings..."
                className="h-24 w-full border-2 border-[#d4a574] bg-[#1a1a1a] px-2 py-2 text-xs text-[#e8d7c6] placeholder-[#666666] outline-none transition focus:border-[#d4a574] focus:bg-[#3a3020] font-mono"
              />
              <button
                type="submit"
                className="w-full border-2 border-[#d4a574] bg-[#1f1f1f] px-2 py-1 text-xs font-mono font-bold text-[#d4a574] transition hover:border-[#d4a574] hover:bg-[#3a3020] hover:text-[#e8d7c6]"
              >
                Save Note
              </button>
            </form>
          </section>

          {/* Quick Links */}
          <section className="border-4 border-[#4a4a4a] bg-[#0a0a0a] p-4">
            <p className="text-xs font-mono uppercase tracking-[0.2em] text-[#8a8a8a]">Navigate</p>
            <div className="mt-3 space-y-2">
              <Link
                href="/research"
                className="block border-2 border-[#4a4a4a] bg-[#0a0a0a] px-2 py-1 text-xs font-mono text-[#b0b0b0] transition hover:border-[#8a8a8a] hover:bg-[#1a1a1a] hover:text-[#e8d7c6]"
              >
                Research Intake
              </Link>
              <Link
                href="/evidence"
                className="block border-2 border-[#4a4a4a] bg-[#0a0a0a] px-2 py-1 text-xs font-mono text-[#b0b0b0] transition hover:border-[#8a8a8a] hover:bg-[#1a1a1a] hover:text-[#e8d7c6]"
              >
                Evidence Review
              </Link>
              <Link
                href="/operations"
                className="block border-2 border-[#4a4a4a] bg-[#0a0a0a] px-2 py-1 text-xs font-mono text-[#b0b0b0] transition hover:border-[#8a8a8a] hover:bg-[#1a1a1a] hover:text-[#e8d7c6]"
              >
                Operations Hub
              </Link>
              <Link
                href="/admin/shadow"
                className="block border-2 border-[#8b4444] bg-[#1a1a1a] px-2 py-1 text-xs font-mono text-[#8b4444] transition hover:border-[#8b4444] hover:bg-[#3a2a2a] hover:text-[#d4a574]"
              >
                SHADOW (Admin)
              </Link>
            </div>
          </section>

          <section className="border-4 border-[#4a4a4a] bg-[#0a0a0a] p-4">
            <p className="text-xs font-mono uppercase tracking-[0.2em] text-[#8a8a8a]">SHADOW Research Stream</p>
            {signalError ? <p className="mt-2 text-xs text-[#f0c4c4]">{signalError}</p> : null}
            {!signalError && shadowSignals.length === 0 ? <p className="mt-2 text-xs text-[#b0a095]">No SHADOW research signals available.</p> : null}
            <div className="mt-2 space-y-2">
              {shadowSignals.slice(0, 6).map((signal) => (
                <div key={signal.event_id} className="border border-[#4a4a4a] bg-[#101010] px-2 py-1 text-[11px] text-[#cfbfae]">
                  <p className="font-semibold text-[#e8d7c6]">{signal.source_event_name}</p>
                  <p>Label: {signal.evidence_label || 'none'}</p>
                  <p>Source: {signal.source_status}</p>
                  <p>State: {signal.review_state}</p>
                </div>
              ))}
            </div>
          </section>
        </aside>
      </div>
    </main>
  );
}
