'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getRoleSessionRoute, readRoleSession } from '@/components/roleSession';

export default function DashboardEntryPage() {
  const router = useRouter();

  useEffect(() => {
    const session = readRoleSession();
    if (session) {
      router.replace(getRoleSessionRoute());
      return;
    }

    router.replace('/login');
  }, [router]);

  return (
    <main className="min-h-screen bg-[#0a0a0a] text-[#e8d7c6]">
      <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col items-center justify-center px-6 py-10 text-center lg:px-10">
        <p className="text-xs font-mono uppercase tracking-[0.35em] text-[#d4a574]">Dashboard Entry</p>
        <h1 className="mt-3 text-4xl font-black tracking-tight md:text-5xl">The Bell</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-[#b0a095] md:text-base">
          The browser session decides where you land.
        </p>
      </div>
    </main>
  );
}