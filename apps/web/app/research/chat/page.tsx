'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { apiBase } from '@/lib/apiBase';

interface QAMessage {
  id: string;
  type: 'user' | 'system' | 'research';
  text: string;
  timestamp: string;
  source?: string;
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
      text: "The library's open. Ask questions about training, techniques, science, or how this place works.",
      timestamp: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    },
  ]);
  const [userInput, setUserInput] = useState('');
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

  function addMessage(type: QAMessage['type'], text: string, source?: string) {
    const newMessage: QAMessage = {
      id: Date.now().toString(),
      type,
      text,
      timestamp: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      source,
    };
    setMessages((prev) => [...prev, newMessage]);
  }

  function handleSendMessage(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!userInput.trim()) return;

    addMessage('user', userInput);
    const question = userInput.toLowerCase();

    // Simple Q&A responses
    if (question.includes('readiness')) {
      addMessage(
        'research',
        'Readiness Score = max(1, min(10, (sleepHours × 1.25) - (sorenessLevel × 0.45) + (disciplineScore × 0.3))). Score under 5.0 triggers readiness alert.',
        'SHADOW Spec'
      );
    } else if (question.includes('rpe') || question.includes('exertion')) {
      addMessage(
        'research',
        'RPE (Rate of Perceived Exertion) is rated 1-10. ΔRPE (delta RPE) = observedRpe - intendedRpe. When ΔRPE ≥ 2, simplify mode activates.',
        'Training Science'
      );
    } else if (question.includes('technique') || question.includes('drill')) {
      addMessage(
        'research',
        'Drills are organized in 6 tiers: L01 Floor Cue, L02 Field Instructions, L03 Psycho-Physiological Maps, L04 Biomechanics Citation, L05 Genesis Origins, L06 Historical Chronology.',
        'Drill Library'
      );
    } else if (question.includes('injury') || question.includes('symptom')) {
      addMessage(
        'research',
        'Critical distress signals: Pain detected, dizziness, water panic, unsafe breath hold. Any trigger = CAPABILITY 194 lockout (full system freeze, manual override required).',
        'Safety Gates'
      );
    } else if (question.includes('role') || question.includes('access')) {
      addMessage(
        'research',
        '12 role tiers: ATHLETE (L1-L3), COACH (L4-L6), BOARD MEMBER (L7-L9), ADMIN/AUDITOR (L10-L12). Each role has distinct canSee[], canDo[], cannotDo[] boundaries.',
        'SHADOW Spec'
      );
    } else if (question.includes('audit') || question.includes('log')) {
      addMessage(
        'research',
        'All system events are Zulu-timestamped and audit-logged with role context. Immutable record for compliance, safety, and operational review.',
        'Audit System'
      );
    } else if (question.includes('data') || question.includes('import')) {
      addMessage(
        'research',
        'SHADOW Admin Console (/admin/shadow) accepts workout data, biometric feeds, coach notes, and video annotations. Use "merge" command to consolidate.',
        'Data Integration'
      );
    } else {
      addMessage(
        'research',
        `Your question: "${userInput}". Try asking about readiness, RPE, drills, injuries, roles, audits, or data import.`,
        'General'
      );
    }

    setUserInput('');
  }

  function handleSaveNote(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!researchNotes.trim()) return;

    addMessage('user', `Saved note: ${researchNotes.substring(0, 50)}...`);
    addMessage('research', `✓ Research note captured. ${researchNotes.length} characters logged.`);
    setResearchNotes('');
  }

  return (
    <main className="min-h-screen bg-[var(--canvas-tan)] text-[var(--black)]">
      {/* ROUGH OLD-SCHOOL BOXING HEADER */}
      <header className="border-b-4 border-[var(--black)] bg-[var(--canvas-tan-light)] px-4 py-4 md:px-8 md:py-6">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
          <div>
            <p className="text-[10px] font-mono uppercase tracking-[0.3em] text-[var(--gray-dark)]">Research Lab</p>
            <h1 className="font-display text-2xl font-black tracking-tight text-[var(--black)] md:text-3xl">The Library</h1>
            <p className="mt-1 text-xs text-[var(--gray-dark)]">Ask. Learn. Document. No fancy talk.</p>
          </div>
          <div className="text-right">
            <p className="font-mono text-[10px] text-[var(--gray-dark)]">PPBF Fight Card</p>
            <p className="text-xs font-bold text-[var(--red-primary)]">LIVE</p>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-6xl gap-6 p-4 lg:grid-cols-[1fr_300px] md:p-8">
        {/* CHAT */}
        <section className="border-4 border-[var(--black)] bg-[var(--canvas-tan-light)] p-6 shadow-[var(--shadow-lg)]">
          {/* Messages */}
          <div className="mb-6 max-h-[500px] space-y-3 overflow-y-auto bg-[var(--canvas-tan)] p-4 font-mono text-sm">
            {messages.map((msg) => {
              let messageTone = 'border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] text-[var(--black)]';
              if (msg.type === 'user') {
                messageTone = 'border-2 border-[var(--black)] bg-[var(--canvas-tan-dark)] text-[var(--red-primary)]';
              } else if (msg.type === 'system') {
                messageTone = 'border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] text-[var(--gray-dark)]';
              }

              return (
              <div key={msg.id} className={`flex gap-3 ${msg.type === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-xs px-3 py-2 ${messageTone}`}>
                  <p className="text-xs leading-5">{msg.text}</p>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <p className="text-[9px] opacity-50">{msg.timestamp}</p>
                    {msg.source && <p className="text-[9px] text-[var(--gray-dark)]">{msg.source}</p>}
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
              placeholder="Ask about readiness, work rate, drills, injuries, roles..."
              className="tactical-input flex-1"
            />
            <button
              type="submit"
              className="tactical-btn"
            >
              Ask
            </button>
          </form>
        </section>

        {/* RIGHT PANEL: NOTES & LINKS */}
        <aside className="space-y-4">
          {/* Research Notes */}
          <section className="border-4 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
            <p className="text-xs font-mono uppercase tracking-[0.2em] text-[var(--gray-dark)]">Notes</p>
            <form onSubmit={handleSaveNote} className="mt-3 space-y-2">
              <textarea
                value={researchNotes}
                onChange={(e) => setResearchNotes(e.target.value)}
                placeholder="Write your findings..."
                className="tactical-input h-24 font-mono"
              />
              <button
                type="submit"
                className="tactical-btn w-full"
              >
                Save Note
              </button>
            </form>
          </section>

          {/* Quick Links */}
          <section className="border-4 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
            <p className="text-xs font-mono uppercase tracking-[0.2em] text-[var(--gray-dark)]">Navigate</p>
            <div className="mt-3 space-y-2">
              <Link
                href="/research"
                className="block border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-2 py-1 text-xs font-mono text-[var(--gray-dark)] transition hover:bg-[var(--canvas-tan-dark)] hover:text-[var(--black)]"
              >
                Research Intake
              </Link>
              <Link
                href="/evidence"
                className="block border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-2 py-1 text-xs font-mono text-[var(--gray-dark)] transition hover:bg-[var(--canvas-tan-dark)] hover:text-[var(--black)]"
              >
                Evidence Review
              </Link>
              <Link
                href="/operations"
                className="block border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-2 py-1 text-xs font-mono text-[var(--gray-dark)] transition hover:bg-[var(--canvas-tan-dark)] hover:text-[var(--black)]"
              >
                Operations Hub
              </Link>
              <Link
                href="/admin/shadow"
                className="block border-2 border-[var(--red-primary)] bg-[var(--canvas-tan-light)] px-2 py-1 text-xs font-mono text-[var(--red-primary)] transition hover:bg-[var(--canvas-tan-dark)] hover:text-[var(--black)]"
              >
                SHADOW (Admin)
              </Link>
            </div>
          </section>

          <section className="border-4 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
            <p className="text-xs font-mono uppercase tracking-[0.2em] text-[var(--gray-dark)]">SHADOW Research Stream</p>
            {signalError ? <p className="mt-2 text-xs text-[var(--red-primary)]">{signalError}</p> : null}
            {!signalError && shadowSignals.length === 0 ? <p className="mt-2 text-xs text-[var(--gray-dark)]">No SHADOW research signals available.</p> : null}
            <div className="mt-2 space-y-2">
              {shadowSignals.slice(0, 6).map((signal) => (
                <div key={signal.event_id} className="border border-[var(--black)] bg-[var(--canvas-tan)] px-2 py-1 text-[11px] text-[var(--gray-dark)]">
                  <p className="font-semibold text-[var(--black)]">{signal.source_event_name}</p>
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
