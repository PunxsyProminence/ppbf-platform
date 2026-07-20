'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function HomePage() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/public');
  }, [router]);

  return (
    <main className="min-h-screen bg-[var(--canvas-tan)] text-[var(--black)]">
      <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col items-center justify-center px-6 py-10 text-center lg:px-10">
        <p className="text-xs font-mono uppercase tracking-[0.35em] text-[var(--red-primary)]">PPBF Platform</p>
        <h1 className="font-display mt-4 text-5xl font-black tracking-[0.05em] md:text-6xl">Public Portal Loading</h1>
        <p className="mt-4 max-w-2xl text-sm leading-7 text-[var(--gray-dark)] md:text-base">
          Redirecting to the public entry page so visitors see the front door first.
        </p>
      </div>
    </main>
  );
}
