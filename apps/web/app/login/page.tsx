'use client';

import { Suspense } from 'react';
import SignInPanel from '@/components/SignInPanel';

/* This route is now a thin wrapper around SignInPanel (the shared component
   /public's popover also renders), kept alive as its own address for bookmarks,
   direct links, and anyone redirected here with an ?error= query param -- the
   auth logic itself lives in exactly one place.

   Golden Era V1 (2026-08-24): on-canvas + ge-sign-in / ge-bell so The Bell
   receives the riveted paper-desk treatment from ppbf-golden-era.css without
   any auth or role change. */
export default function LoginPage() {
  return (
    <Suspense fallback={<main className="on-canvas min-h-screen" />}>
      <main className="on-canvas ge-sign-in ge-bell min-h-screen">
        <div className="mx-auto w-full max-w-[840px] px-[var(--s5)] py-[var(--s7)]">
          <SignInPanel />
        </div>
      </main>
    </Suspense>
  );
}
