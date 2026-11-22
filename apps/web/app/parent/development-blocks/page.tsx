'use client';

import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';

import BackHome from '@/components/BackHome';
import DevelopmentBlockPlanView, { type PlanBlock } from '@/components/DevelopmentBlockPlanView';
import FamilyChildPicker, { openingChild } from '@/components/FamilyChildPicker';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';

/*
 * A guardian reading the plan their child's coach wrote.
 *
 * A GUARDIAN READS EXACTLY WHAT THEIR CHILD READS, and no more. That is the
 * same rule /parent/progression-visibility already states and the same
 * component renders it, so the two screens cannot drift into showing a parent
 * and child different versions of the same block -- which is exactly the
 * discrepancy a family sitting together would find.
 *
 * Owner decision 2026-08-28 governs the content: everything, verbatim,
 * including the nutrition and body composition domain. Nothing here filters,
 * softens or summarises what a coach wrote.
 *
 * READ-ONLY, structurally. Logging or judging progress is the athlete's or a
 * coach's act; the route behind this page has no write verb at all.
 */

interface LinkedChild {
  athlete_id: string;
  full_name?: string;
}

export default function ParentDevelopmentBlocksPage() {
  const [children, setChildren] = useState<LinkedChild[]>([]);
  const [childrenState, setChildrenState] = useState<'loading' | 'loaded' | 'unavailable'>('loading');
  const [activeChildId, setActiveChildId] = useState('');

  const [blocks, setBlocks] = useState<PlanBlock[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'loaded' | 'unavailable'>('idle');

  /* Which child the panel below is FOR, as opposed to which one was asked
     about. A slow read for the child a guardian just navigated away from must
     never land under the one they navigated to: the block cards carry no
     child's name, so nothing on screen would disagree. Same guard and same
     reason as the coach page's blocksAthleteRef. */
  const subjectRef = useRef('');

  // Opens on the remembered child when it is one of these, else on the only
  // child (FAM-11); with two or more and none remembered, nothing is picked
  // and the picker asks. The route checks the guardian link on the read.
  const openChosenChild = useEffectEvent((items: LinkedChild[]) => {
    const opening = openingChild(items);
    if (opening) selectChild(opening);
  });

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        // The route that runs the guardian visibility gate: it returns only
        // the athletes this account is actually linked to.
        const response = await fetch(`${apiBase()}/api/pilot/athletes/list`, {
          method: 'GET',
          credentials: 'include',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('children');
        const payload = (await response.json()) as { items?: LinkedChild[] };
        const items = payload.items ?? [];
        setChildren(items);
        setChildrenState('loaded');
        openChosenChild(items);
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') return;
        // Not "you have no children linked" -- this read did not establish
        // that, and a guardian who reads it would stop looking.
        setChildren([]);
        setChildrenState('unavailable');
      }
    })();
    return () => controller.abort();
  }, []);

  const loadBlocks = useCallback(async (forAthleteId: string) => {
    if (!forAthleteId) {
      setBlocks([]);
      setState('idle');
      return;
    }
    setState('loading');
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/athlete/development-blocks?athlete_id=${encodeURIComponent(forAthleteId)}`,
        { method: 'GET', credentials: 'include' },
      );
      if (!response.ok) throw new Error('blocks');
      const payload = (await response.json()) as { blocks?: PlanBlock[] };
      if (subjectRef.current !== forAthleteId) return;
      setBlocks(payload.blocks ?? []);
      setState('loaded');
    } catch {
      if (subjectRef.current !== forAthleteId) return;
      setBlocks([]);
      setState('unavailable');
    }
  }, []);

  function selectChild(nextId: string) {
    // Set BEFORE the read starts, so an answer for the previous child that
    // arrives afterwards can recognise itself as stale.
    subjectRef.current = nextId;
    setActiveChildId(nextId);
    // A pick in the picker is remembered there, for the next family page.
    void loadBlocks(nextId);
  }

  const activeChildName = children.find((child) => child.athlete_id === activeChildId)?.full_name;

  return (
    <RoleStandaloneView
      roleLabel="Development Plan"
      routeLabel="/parent/development-blocks"
      allowedRoles={['parent']}
      showShellHeader={false}
    >
      <div className="space-y-[var(--s5)]">
        <header className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]">
          <p className="t-eyebrow">Parent Hub</p>
          <h1 className="t-command mt-[var(--s3)] text-[length:var(--t-xl)]">Their Development Plan</h1>
          <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
            What your child&apos;s coach is working on with them over a stretch of weeks, in the
            coach&apos;s own words. You see exactly what your child sees. Nothing here is a score or
            a ranking, and nothing on this page can be changed from it — if something reads wrong,
            that is a conversation with the coach.
          </p>
        </header>

        {/* The family pages' one picker (FAM-11), on its own paper panel as on
            the film and progress pages: a ghost button on this page's leather
            is ink on dark and cannot be read. It shows for two or more
            children only. */}
        <FamilyChildPicker
          linked={children}
          activeId={activeChildId || null}
          onChoose={selectChild}
          className="mat-paper rounded-[var(--r-lg)] p-[var(--s4)]"
        />

        {/* Loading, failed, or nobody linked: the lines this panel always
            carried. With children loaded there is nothing to say here. */}
        {childrenState === 'loaded' && children.length > 0 ? null : (
        <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)]">
          {childrenState === 'loading' && <p className="t-muted">Loading...</p>}

          {childrenState === 'unavailable' && (
            <div className="rounded-[var(--r-md)] border-2 border-[var(--restricted)] bg-[rgba(0,0,0,.28)] p-[var(--s3)]">
              <p className="m-0 text-[length:var(--t-sm)] font-semibold text-[var(--restricted-ink)]">
                Your linked children could not be loaded. This is not a statement that you have
                none — reload and try again.
              </p>
            </div>
          )}

          {childrenState === 'loaded' && children.length === 0 && (
            <p className="t-body text-[color:var(--bone-300)]">
              No child is linked to this account yet. The gym&apos;s administrator sets that link up.
            </p>
          )}
        </section>
        )}

        {activeChildId && (
          <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)]">
            <h2 className="t-eyebrow">Blocks{activeChildName ? ` for ${activeChildName}` : ''}</h2>
            <DevelopmentBlockPlanView
              blocks={blocks}
              state={state}
              subjectLabel="their plan"
              emptyMessage="No development plan has been written yet. That is normal — a coach writes one when they are planning a stretch of weeks, not for every session."
            />
          </section>
        )}

        {/* The one back link (FAM-18), at the foot on the family ground as on
            the film and progress pages. In the leather header above it was ink
            on dark. */}
        <div className="flex flex-wrap gap-[var(--s3)]">
          <BackHome />
        </div>
      </div>
    </RoleStandaloneView>
  );
}
