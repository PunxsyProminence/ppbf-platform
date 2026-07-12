'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { readRoleSession } from '@/components/roleSession';

interface ShadowMessage {
  id: string;
  type: 'user' | 'shadow';
  text: string;
  timestamp: string;
}

export default function ShadowChatPage() {
  const router = useRouter();
  const [userRole, setUserRole] = useState<string>('');
  const [messages, setMessages] = useState<ShadowMessage[]>([
    {
      id: '0',
      type: 'shadow',
      text: 'SHADOW standing by. Ask me about readiness, RPE, drills, your performance, or platform features.',
      timestamp: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    },
  ]);
  const [userInput, setUserInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const session = readRoleSession();
    if (!session) {
      router.replace('/login');
      return;
    }
    setUserRole(session.role);
  }, [router]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  function addMessage(type: 'user' | 'shadow', text: string) {
    const newMessage: ShadowMessage = {
      id: Date.now().toString(),
      type,
      text,
      timestamp: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    };
    setMessages((prev) => [...prev, newMessage]);
  }

  function handleSendMessage(e: React.FormEvent) {
    e.preventDefault();
    if (!userInput.trim()) return;

    addMessage('user', userInput);
    const question = userInput.toLowerCase();

    // Response logic
    if (question.includes('readiness')) {
      addMessage('shadow', 'Your readiness score is calculated: (sleep × 1.25) - (soreness × 0.45) + (discipline × 0.3). Below 5.0 = alert mode. Check your sleep, manage soreness.');
    } else if (question.includes('rpe') || question.includes('effort')) {
      addMessage('shadow', 'Rate your effort 1-10. If actual effort > intended by 2+, we activate simplify mode. Keep it controlled. Ego is an injury.');
    } else if (question.includes('drill') || question.includes('technique')) {
      addMessage('shadow', 'Drills span 6 levels: Floor Cue → Field Instructions → Science Maps → Biomechanics → Origins → History. Master one tier before advancing.');
    } else if (question.includes('injury') || question.includes('pain') || question.includes('hurt')) {
      addMessage('shadow', 'Pain, dizziness, panic, or unsafe breath = STOP. Full system lockout. No exceptions. Safety trumps everything. Report to coach immediately.');
    } else if (question.includes('how') && question.includes('work')) {
      addMessage('shadow', 'SHADOW tracks your performance, monitors safety gates, logs every decision. All role-specific. Coaches see more than athletes. Everyone gets honesty.');
    } else if (question.includes('data') || question.includes('upload')) {
      addMessage('shadow', 'Admins can import workout data, biometrics, video, and merge it all via /admin/shadow. Your role determines what you see.');
    } else if (question.includes('help') || question.includes('?')) {
      addMessage('shadow', 'I answer questions about: readiness, RPE, drills, injuries, how SHADOW works, data, roles, or anything platform-related. Ask away.');
    } else {
      addMessage('shadow', `You asked: "${userInput}". Try asking about readiness, RPE, drills, injuries, or how SHADOW works.`);
    }

    setUserInput('');
  }

  return (
    <main className="min-h-screen bg-[#0a0a0a] text-slate-100">
      {/* HEADER */}
      <header className="border-b-4 border-red-900 bg-[#1a1a1a] px-4 py-4 md:px-8 md:py-6">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4">
          <div>
            <p className="text-[10px] font-mono uppercase tracking-[0.3em] text-red-400">AI/ML Telemetry Scout</p>
            <h1 className="text-2xl font-black tracking-tight text-red-100 md:text-3xl">SHADOW Chat</h1>
            <p className="mt-1 text-xs text-red-300/70">Ask. Learn. Train harder.</p>
          </div>
          <div className="text-right">
            <p className="font-mono text-[10px] text-slate-500">Role: {userRole.toUpperCase()}</p>
            <p className="text-xs font-bold text-red-400">LIVE</p>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-4xl p-4 md:p-8">
        {/* CHAT BOX */}
        <section className="rounded-lg border-4 border-red-900 bg-[#0f0f0f] p-6 shadow-2xl shadow-black/60">
          {/* Messages */}
          <div className="mb-6 max-h-[550px] space-y-4 overflow-y-auto rounded-lg bg-[#050505] p-4 font-mono text-sm">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex gap-3 ${msg.type === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-md rounded-lg px-4 py-3 ${
                    msg.type === 'user'
                      ? 'border-2 border-red-700 bg-red-950/50 text-red-100'
                      : 'border-2 border-red-600/70 bg-red-950/30 text-red-50'
                  }`}
                >
                  <p className="text-xs leading-6">{msg.text}</p>
                  <p className="mt-2 text-[9px] opacity-50">{msg.timestamp}</p>
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <form onSubmit={handleSendMessage} className="flex gap-2">
            <input
              type="text"
              value={userInput}
              onChange={(e) => setUserInput(e.target.value)}
              placeholder="Ask SHADOW anything..."
              className="flex-1 rounded-lg border-2 border-red-700 bg-red-950/30 px-4 py-3 text-sm text-red-50 placeholder-red-600/40 outline-none transition focus:border-red-500 focus:bg-red-950/50"
            />
            <button
              type="submit"
              className="rounded-lg border-2 border-red-700 bg-red-950/50 px-6 py-3 text-xs font-mono font-bold text-red-300 transition hover:border-red-500 hover:bg-red-900/70 hover:text-red-100"
            >
              Send
            </button>
          </form>
        </section>

        {/* NAV LINKS */}
        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            href="/research/chat"
            className="rounded-lg border-2 border-amber-800 bg-amber-950/30 px-4 py-2 text-xs font-mono text-amber-400 transition hover:border-amber-600 hover:bg-amber-950/50"
          >
            Research Q&A
          </Link>
          <Link
            href="/admin/shadow"
            className="rounded-lg border-2 border-red-800 bg-red-950/40 px-4 py-2 text-xs font-mono text-red-400 transition hover:border-red-600 hover:bg-red-950/60"
          >
            Admin Console
          </Link>
          <Link
            href="/operations"
            className="rounded-lg border-2 border-slate-700 bg-slate-950 px-4 py-2 text-xs font-mono text-slate-400 transition hover:border-slate-500 hover:text-slate-300"
          >
            Operations
          </Link>
        </div>
      </div>
    </main>
  );
}
