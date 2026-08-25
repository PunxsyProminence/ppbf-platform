'use client';

import { Suspense } from 'react';
import SignInPanel from '@/components/SignInPanel';

/* This route is now a thin wrapper around SignInPanel (the shared component
   /public's popover also renders), kept alive as its own address for bookmarks,
   direct links, and anyone redirected here with an ?error= query param -- the
   auth logic itself lives in exactly one place. */
export default function LoginPage() {
  return (
    <Suspense fallback={<main className="on-canvas min-h-screen theme-golden ge-bell" />}>
      {/* ge-bell: Golden Era Visual 001 scope. The only functional change on
          this route is this class name -- every material, the gym plate, the
          frame and the title treatment live in scoped CSS under .ge-bell
          (design-system/current/ppbf-golden-era.css), so the auth flow inside
          SignInPanel is untouched and no other surface is affected. */}
      <main className="on-canvas min-h-screen theme-golden ge-bell">
        <div className="ge-bell__column mx-auto w-full max-w-[840px] px-[var(--s5)] py-[var(--s7)]">
          <SignInPanel />
        </div>
      </main>
    </Suspense>
  );
}
