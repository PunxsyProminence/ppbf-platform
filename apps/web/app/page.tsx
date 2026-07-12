'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getRoleSessionRoute, readRoleSession } from '@/components/roleSession';

export default function HomePage() {
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
        <p className="text-xs font-mono uppercase tracking-[0.35em] text-[#d4a574]">PPBF Platform</p>
        <h1 className="font-display mt-4 text-5xl font-black tracking-[0.05em] md:text-6xl">Taking You Where You Belong</h1>
        <p className="mt-4 max-w-2xl text-sm leading-7 text-[#b0a095] md:text-base">Get your hands taped and head to your corner.</p>
      </div>
    </main>
  );
}
