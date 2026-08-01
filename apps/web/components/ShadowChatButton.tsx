"use client";

import Link from 'next/link';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { getRoleSessionSnapshot, subscribeRoleSession } from './roleSession';
import { apiBase } from '@/lib/apiBase';

interface ShadowChatButtonProps {
  readonly className?: string;
  readonly label?: string;
  readonly context?: string;
  readonly subject?: string;
}

export default function ShadowChatButton({ className, label = 'OPEN SHADOW CHAT', context, subject }: ShadowChatButtonProps) {
  const session = useSyncExternalStore(subscribeRoleSession, getRoleSessionSnapshot, () => null);
  const [resolvedRole, setResolvedRole] = useState<string>(session?.role ?? '');
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(Boolean(session));

  useEffect(() => {
    if (session?.role) {
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/auth/session`, {
          method: 'POST',
          credentials: 'include',
        });

        if (!response.ok) {
          if (!cancelled) {
            setIsAuthenticated(false);
            setResolvedRole('');
          }
          return;
        }

        const payload = (await response.json().catch(() => ({ authenticated: false }))) as {
          authenticated?: boolean;
          role?: string;
        };

        if (!cancelled) {
          setIsAuthenticated(payload.authenticated === true);
          setResolvedRole(payload.authenticated ? payload.role || '' : '');
        }
      } catch {
        if (!cancelled) {
          setIsAuthenticated(false);
          setResolvedRole('');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [session]);

  const role = resolvedRole || session?.role || 'guest';
  const roleLabel = role.toUpperCase();
  const mode = role === 'admin' || role === 'organization_admin' || role === 'platform_owner' ? 'master' : 'scoped';
  const roleParam = encodeURIComponent(role);
  const contextParam = context ? `&context=${encodeURIComponent(context)}` : '';
  const subjectParam = subject ? `&subject=${encodeURIComponent(subject)}` : '';
  const shadowHref = `/shadow?mode=${mode}&role=${roleParam}${contextParam}${subjectParam}`;
  const href = isAuthenticated ? shadowHref : '/login';

  return (
    <Link href={href} className={buttonClasses(className)}>
      <span>{label}</span>
      <span className="border border-[color:currentColor] px-1 text-[10px] tracking-[0.08em]">{roleLabel}</span>
    </Link>
  );
}

/* Callers pass `className` to re-skin this button, but appending it to the
   defaults does not make it win: Tailwind resolves two utilities that set the
   same property by their order in the generated stylesheet, not by their order
   in the attribute. So a caller asking for a dark fill could get the default
   light one -- or, worse, get the dark fill and the default dark text, which is
   how the coach workspace ended up with an unreadable button.
   Dropping each default whose property the caller has already claimed makes the
   override deterministic rather than dependent on Tailwind's sort order. */
const DEFAULTS: ReadonlyArray<readonly [prefix: RegExp, classes: string]> = [
  [/(^|\s)(hover:)?bg-/, 'bg-[var(--canvas-tan-light)] hover:bg-[var(--canvas-tan-dark)]'],
  [/(^|\s)text-\[/, 'text-[color:var(--black)]'],
  [/(^|\s)border-\[/, 'border-[color:var(--black)]'],
];

export function buttonClasses(className?: string): string {
  const caller = className ?? '';
  const base = [
    'inline-flex min-h-[44px] items-center justify-center gap-2 border-2 px-3',
    'text-xs font-mono font-bold uppercase tracking-[0.12em] transition',
    'focus-visible:outline-none focus-visible:shadow-[var(--focus)]',
  ];
  for (const [claimed, fallback] of DEFAULTS) {
    if (!claimed.test(caller)) base.push(fallback);
  }
  return `${base.join(' ')} ${caller}`.trim();
}