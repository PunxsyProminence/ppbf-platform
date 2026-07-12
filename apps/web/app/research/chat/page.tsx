'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';

interface QAMessage {
  id: string;
  type: 'user' | 'system' | 'research';
  text: string;
  timestamp: string;
  source?: string;
}

export default function ResearchQAChatPage() {
  const [messages, setMessages] = useState<QAMessage[]>([
    {
      id: '0',
      type: 'system',
      text: 'Research Q&A Chat initialized. Ask questions about training, techniques, science, or platform usage.',
      timestamp: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    },
  ]);
  const [userInput, setUserInput] = useState('');
  const [researchNotes, setResearchNotes] = useState<string>('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

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

  function handleSendMessage(e: React.FormEvent) {
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

  function handleSaveNote(e: React.FormEvent) {
    e.preventDefault();
    if (!researchNotes.trim()) return;

    addMessage('user', `Saved note: ${researchNotes.substring(0, 50)}...`);
    addMessage('research', `✓ Research note captured. ${researchNotes.length} characters logged.`);
    setResearchNotes('');
  }

  return (
    <main className="min-h-screen bg-[#0a0a0a] text-slate-100">
      {/* ROUGH OLD-SCHOOL BOXING HEADER */}
      <header className="border-b-4 border-red-900 bg-[#1a1a1a] px-4 py-4 md:px-8 md:py-6">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
          <div>
            <p className="text-[10px] font-mono uppercase tracking-[0.3em] text-red-400">Research Lab</p>
            <h1 className="text-2xl font-black tracking-tight text-red-100 md:text-3xl">Q/A Research Chat</h1>
            <p className="mt-1 text-xs text-red-300/70">Ask. Learn. Document. No corporate fluff.</p>
          </div>
          <div className="text-right">
            <p className="font-mono text-[10px] text-slate-500">PPBF Fight Card</p>
            <p className="text-xs font-bold text-red-400">TOUGH</p>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-6xl gap-6 p-4 lg:grid-cols-[1fr_300px] md:p-8">
        {/* CHAT */}
        <section className="rounded-none border-4 border-slate-800 bg-[#0f0f0f] p-6 shadow-2xl shadow-black/60">
          {/* Messages */}
          <div className="mb-6 max-h-[500px] space-y-3 overflow-y-auto rounded-lg bg-[#050505] p-4 font-mono text-sm">
            {messages.map((msg) => (
              <div key={msg.id} className={`flex gap-3 ${msg.type === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-xs rounded-lg px-3 py-2 ${
                    msg.type === 'user'
                      ? 'border border-red-700 bg-red-900/40 text-red-100'
                      : msg.type === 'system'
                        ? 'border border-slate-700 bg-slate-900/50 text-slate-300'
                        : 'border border-red-600/60 bg-red-950/30 text-red-50'
                  }`}
                >
                  <p className="text-xs leading-5">{msg.text}</p>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <p className="text-[9px] opacity-50">{msg.timestamp}</p>
                    {msg.source && <p className="text-[9px] text-red-400/60">{msg.source}</p>}
                  </div>
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <form onSubmit={handleSendMessage} className="flex gap-3">
            <input
              type="text"
              value={userInput}
              onChange={(e) => setUserInput(e.target.value)}
              placeholder="Ask about readiness, RPE, drills, injuries, roles..."
              className="flex-1 rounded-lg border-2 border-red-700 bg-red-950/30 px-3 py-2 text-sm text-red-50 placeholder-red-600/40 outline-none transition focus:border-red-500 focus:bg-red-950/50"
            />
            <button
              type="submit"
              className="rounded-lg border-2 border-red-700 bg-red-950/50 px-4 py-2 text-xs font-mono font-bold text-red-300 transition hover:border-red-500 hover:bg-red-900/70 hover:text-red-100"
            >
              Ask
            </button>
          </form>
        </section>

        {/* RIGHT PANEL: NOTES & LINKS */}
        <aside className="space-y-4">
          {/* Research Notes */}
          <section className="rounded-lg border-3 border-amber-800 bg-[#0d0a08] p-4">
            <p className="text-xs font-mono uppercase tracking-[0.2em] text-amber-600">Notes</p>
            <form onSubmit={handleSaveNote} className="mt-3 space-y-2">
              <textarea
                value={researchNotes}
                onChange={(e) => setResearchNotes(e.target.value)}
                placeholder="Write your findings..."
                className="h-24 w-full rounded-lg border-2 border-amber-800 bg-amber-950/20 px-2 py-2 text-xs text-amber-50 placeholder-amber-600/40 outline-none transition focus:border-amber-600 focus:bg-amber-950/40 font-mono"
              />
              <button
                type="submit"
                className="w-full rounded-lg border-2 border-amber-800 bg-amber-950/30 px-2 py-1 text-xs font-mono font-bold text-amber-300 transition hover:border-amber-600 hover:bg-amber-900/50 hover:text-amber-100"
              >
                Save Note
              </button>
            </form>
          </section>

          {/* Quick Links */}
          <section className="rounded-lg border-3 border-slate-700 bg-[#0a0a0a] p-4">
            <p className="text-xs font-mono uppercase tracking-[0.2em] text-slate-500">Navigate</p>
            <div className="mt-3 space-y-2">
              <Link
                href="/research"
                className="block rounded-lg border-2 border-slate-700 bg-slate-950 px-2 py-1 text-xs font-mono text-slate-400 transition hover:border-slate-500 hover:bg-slate-900 hover:text-slate-200"
              >
                Research Intake
              </Link>
              <Link
                href="/evidence"
                className="block rounded-lg border-2 border-slate-700 bg-slate-950 px-2 py-1 text-xs font-mono text-slate-400 transition hover:border-slate-500 hover:bg-slate-900 hover:text-slate-200"
              >
                Evidence Review
              </Link>
              <Link
                href="/operations"
                className="block rounded-lg border-2 border-slate-700 bg-slate-950 px-2 py-1 text-xs font-mono text-slate-400 transition hover:border-slate-500 hover:bg-slate-900 hover:text-slate-200"
              >
                Operations Hub
              </Link>
              <Link
                href="/admin/shadow"
                className="block rounded-lg border-2 border-red-800 bg-red-950/20 px-2 py-1 text-xs font-mono text-red-500 transition hover:border-red-600 hover:bg-red-950/40 hover:text-red-400"
              >
                SHADOW (Admin)
              </Link>
            </div>
          </section>
        </aside>
      </div>
    </main>
  );
}
