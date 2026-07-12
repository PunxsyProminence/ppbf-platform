'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { roleRoutes, type ClubRole } from '@/components/roleRoutes';
import { createRoleSession, getRoleSessionRoute, readRoleSession } from '@/components/roleSession';

export default function LoginPage() {
  const router = useRouter();
  const [pin, setPin] = useState('');
  const [selectedRole, setSelectedRole] = useState<ClubRole>('athlete');
  const [error, setError] = useState('');

  useEffect(() => {
    const session = readRoleSession();
    if (session) {
      router.replace(getRoleSessionRoute());
    }
  }, [router]);

  function signIn() {
    const result = createRoleSession(selectedRole, pin);

    if (!result.ok) {
      setError(result.reason);
      return;
    }

    setError('');
    router.push(getRoleSessionRoute());
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.14),_transparent_28%),linear-gradient(180deg,#020617_0%,#0b1120_100%)] text-slate-100">
      <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-6 py-10 lg:px-10">
        <header className="border-b border-slate-800 pb-6">
          <p className="text-xs font-mono uppercase tracking-[0.35em] text-emerald-300/80">Club Login</p>
          <h1 className="mt-3 text-4xl font-black tracking-tight md:text-5xl">Sign in to your dashboard</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300 md:text-base">
            Enter the operator PIN and pick the role you are using today. The app will send you straight to the matching dashboard.
          </p>
        </header>

        <section className="mt-8 grid gap-6 lg:grid-cols-[1fr_1.1fr]">
          <div className="rounded-3xl border border-slate-800 bg-slate-950/70 p-6 shadow-2xl shadow-black/20">
            <h2 className="text-lg font-semibold text-slate-100">Sign-in controls</h2>

            <label className="mt-5 block text-sm font-medium text-slate-300" htmlFor="role">
              Role
            </label>
            <select
              id="role"
              value={selectedRole}
              onChange={(event) => setSelectedRole(event.target.value as ClubRole)}
              className="mt-2 w-full rounded-2xl border border-slate-800 bg-slate-900/80 px-4 py-3 text-slate-100 outline-none transition focus:border-emerald-500/50"
            >
              {roleRoutes.map((item) => (
                <option key={item.role} value={item.role}>
                  {item.label}
                </option>
              ))}
            </select>

            <label className="mt-5 block text-sm font-medium text-slate-300" htmlFor="pin">
              Operator PIN
            </label>
            <input
              id="pin"
              type="password"
              inputMode="numeric"
              value={pin}
              onChange={(event) => setPin(event.target.value)}
              placeholder="Enter PIN"
              className="mt-2 w-full rounded-2xl border border-slate-800 bg-slate-900/80 px-4 py-3 text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-emerald-500/50"
            />

            {error ? <p className="mt-4 text-sm text-rose-300">{error}</p> : null}

            <button
              type="button"
              onClick={signIn}
              className="mt-6 inline-flex items-center justify-center rounded-2xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm font-mono font-bold text-emerald-300 transition hover:bg-emerald-500/20 hover:text-emerald-200"
            >
              Sign in
            </button>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            {roleRoutes.map((item) => (
              <div
                key={item.role}
                className="rounded-3xl border border-slate-800 bg-slate-950/70 p-5"
              >
                <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-slate-500">Role</p>
                <h2 className="mt-2 text-xl font-black text-slate-100">{item.label}</h2>
                <p className="mt-2 text-sm leading-6 text-slate-400">{item.description}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-8 rounded-3xl border border-cyan-500/20 bg-cyan-500/10 p-6 text-sm text-cyan-50">
          <h2 className="text-lg font-semibold text-cyan-50">Note</h2>
          <p className="mt-3 leading-6 text-cyan-50/90">
            This is a lightweight operator session for a static front end. It is not server-authenticated, but it will route you to the right dashboard and keep the session in the browser.
          </p>
        </section>
      </div>
    </main>
  );
}