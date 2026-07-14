'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { readRoleSession, clearRoleSession } from '@/components/roleSession';
import TutorialButton from '@/components/TutorialButton';

interface ShadowMessage {
  id: string;
  type: 'user' | 'shadow';
  text: string;
  timestamp: string;
}

export default function ShadowChatPage() {
  const router = useRouter();
  const [userRole] = useState<string>(() => (typeof window !== 'undefined' ? readRoleSession()?.role ?? '' : ''));
  const [messages, setMessages] = useState<ShadowMessage[]>([
    {
      id: '0',
      type: 'shadow',
      text: "I'm in your corner. What's the damage? Ask me about readiness, work rate, technique, or anything about training.",
      timestamp: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    },
  ]);
  const [userInput, setUserInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const session = readRoleSession();
    if (!session) {
      router.replace('/login');
    }
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

  function handleLogout() {
    clearRoleSession();
    router.push('/login');
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
    <main className="min-h-screen bg-[#0a0a0a] text-[#e8d7c6]">
      {/* HEADER */}
      <header className="border-b-4 border-[#8b4444] bg-[#1a1a1a] px-4 py-4 md:px-8 md:py-6">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4">
          <div>
            <p className="text-[10px] font-mono uppercase tracking-[0.3em] text-[#dc2626]">The Scout</p>
            <h1 className="font-display text-2xl font-black tracking-tight text-[#e8d7c6] md:text-3xl">SHADOW</h1>
            <p className="mt-1 text-xs text-[#b0a095]">I&apos;m in your corner.</p>
          </div>
          <div className="flex items-center gap-4 text-right">
            <div>
              <p className="font-mono text-[10px] text-[#8a8a8a]">Role: {userRole.toUpperCase()}</p>
              <p className="text-xs font-bold text-[#dc2626]">LIVE</p>
            </div>
            <button
              onClick={handleLogout}
              className="border-2 border-[#8b4444] bg-[#2a1a1a] px-3 py-2 text-xs font-semibold uppercase tracking-[0.1em] text-[#b0a095] transition hover:border-[#d4a574] hover:bg-[#3a2a2a] hover:text-[#e8d7c6]"
            >
              Logout
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-4xl p-4 md:p-8">
        {/* CHAT BOX */}
        <section className="border-4 border-[#8b4444] bg-[#0f0f0f] p-6 shadow-2xl shadow-black/60">
          {/* Messages */}
          <div className="mb-6 max-h-[550px] space-y-4 overflow-y-auto bg-[#050505] p-4 font-mono text-sm">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex gap-3 ${msg.type === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-md px-4 py-3 ${
                    msg.type === 'user'
                      ? 'border-2 border-[#dc2626] bg-[#2a1a1a] text-[#ff6b6b]'
                      : 'border-2 border-[#d4a574] bg-[#2a1f0f] text-[#e8d7c6]'
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
              placeholder="What do you need to know?"
              className="flex-1 border-2 border-[#8b4444] bg-[#1a1a1a] px-4 py-3 text-sm text-[#e8d7c6] placeholder-[#6a5a4a] outline-none transition focus:border-[#dc2626] focus:bg-[#2a1a1a]"
            />
            <button
              type="submit"
              className="border-2 border-[#8b4444] bg-[#2a1a1a] px-6 py-3 text-xs font-mono font-bold text-[#dc2626] transition hover:border-[#dc2626] hover:bg-[#3a2a2a] hover:text-[#ff6b6b]"
            >
              Ask
            </button>
          </form>
        </section>

        {/* NAV LINKS */}
        <div className="mt-6 flex flex-wrap gap-3">
          <TutorialButton anchor="shadow-guide" className="border-[#8b4444] bg-[#1a1a1a] text-[#d4a574] hover:border-[#d4a574] hover:bg-[#2a1a1a]" />
          <Link
            href="/research/chat"
            className="border-2 border-[#d4a574] bg-[#1f1f1f] px-4 py-2 text-xs font-mono text-[#d4a574] transition hover:border-[#d4a574] hover:bg-[#2a1f1f]"
          >
            The Library
          </Link>
          <Link
            href="/admin/shadow"
            className="border-2 border-[#8b4444] bg-[#1a1a1a] px-4 py-2 text-xs font-mono text-[#dc2626] transition hover:border-[#dc2626] hover:bg-[#2a1a1a]"
          >
            The Office
          </Link>
          <Link
            href="/operations"
            className="border-2 border-[#4a4a4a] bg-[#1a1a1a] px-4 py-2 text-xs font-mono text-[#b0b0b0] transition hover:border-[#8a8a8a] hover:text-[#e8d7c6]"
          >
            Operations
          </Link>
          <Link
            href="/coach/video-analysis"
            className="border-2 border-[#8b4444] bg-[#1a1a1a] px-4 py-2 text-xs font-mono text-[#d4a574] transition hover:border-[#d4a574] hover:bg-[#2a1a1a]"
          >
            AI Video Analysis (Planned)
          </Link>
          <Link
            href="/board/compliance-monitoring"
            className="border-2 border-[#8b4444] bg-[#1a1a1a] px-4 py-2 text-xs font-mono text-[#d4a574] transition hover:border-[#d4a574] hover:bg-[#2a1a1a]"
          >
            Compliance Monitoring (Planned)
          </Link>
          <Link
            href="/athlete/progression-intelligence"
            className="border-2 border-[#8b4444] bg-[#1a1a1a] px-4 py-2 text-xs font-mono text-[#d4a574] transition hover:border-[#d4a574] hover:bg-[#2a1a1a]"
          >
            Progression Intelligence (Planned)
          </Link>
          <Link
            href="/source-control/publication-workflow"
            className="border-2 border-[#8b4444] bg-[#1a1a1a] px-4 py-2 text-xs font-mono text-[#d4a574] transition hover:border-[#d4a574] hover:bg-[#2a1a1a]"
          >
            Publication Workflow (Planned)
          </Link>
        </div>
      </div>
    </main>
  );
}
