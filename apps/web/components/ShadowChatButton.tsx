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
      setResolvedRole(session.role);
      setIsAuthenticated(true);
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
    <Link
      href={href}
      className={`inline-flex min-h-[40px] items-center justify-center gap-2 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-3 text-xs font-mono font-bold uppercase tracking-[0.12em] text-[var(--black)] transition hover:bg-[var(--canvas-tan-dark)] ${className ?? ''}`.trim()}
    >
      <span>{label}</span>
      <span className="border border-[var(--black)] px-1 text-[10px] tracking-[0.08em]">{roleLabel}</span>
    </Link>
  );
}