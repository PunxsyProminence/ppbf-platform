'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';
import type {
  WorkoutTemplateItemRow,
  WorkoutTemplateRow,
} from '@/src/server/pilot/workoutTemplates';

// Read-only browse over pilot.workout_templates, the first UI consumer of
// GET /api/pilot/workout-templates. The route has been read-only by design
// since it shipped -- templates are seeded reference data, not something a
// coach authors from the floor -- so this page offers no create, no edit,
// and no delete, and that absence is deliberate rather than unfinished.
//
// Layout, gating and honesty rules mirror /coach/session-scripts: a failed
// read is distinguished from an empty catalog, durations render as minutes
// (a template is the same template at 4:00 and at 6:30), and opening a
// template is the only interaction.

// Type-only imports from the server module, so nothing server-side is pulled
// into this client bundle and the shapes cannot drift from the route's own.
type Template = WorkoutTemplateRow;
type TemplateItem = WorkoutTemplateItemRow;

interface TemplateDetail {
  template: Template;
  items: TemplateItem[];
}

/** What one item prescribes, from the nullable columns it actually has. */
function itemPrescription(item: TemplateItem): string {
  const parts: string[] = [];
  if (item.duration_minutes !== null) parts.push(`${item.duration_minutes} min`);
  if (item.rep_count !== null) parts.push(`${item.rep_count} reps`);
  return parts.join(', ');
}

function CoachWorkoutTemplates() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [openTemplateId, setOpenTemplateId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TemplateDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');

  // No state is set before the first await, matching the session-scripts
  // page: a synchronous setState inside an effect cascades a render before
  // the request has even left.
  const load = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/workout-templates`, {
        method: 'GET',
        credentials: 'include',
      });
      if (!response.ok) throw new Error('The workout templates could not be loaded.');
      const payload = (await response.json()) as { templates?: Template[] };
      setTemplates(payload.templates ?? []);
      setLoadError('');
    } catch (error) {
      setTemplates([]);
      setLoadError(error instanceof Error ? error.message : 'The workout templates could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const openTemplate = useCallback(async (templateId: string) => {
    // Clearing the previous template's detail and error together, so one
    // template's items -- or its failure -- never render under another
    // template's name while the new read is in flight.
    setOpenTemplateId(templateId);
    setDetail(null);
    setDetailError('');
    setDetailLoading(true);
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/workout-templates?template_id=${encodeURIComponent(templateId)}`,
        { method: 'GET', credentials: 'include' },
      );
      if (!response.ok) throw new Error('That workout template could not be opened.');
      const payload = (await response.json()) as Partial<TemplateDetail>;
      if (!payload.template) throw new Error('That workout template could not be opened.');
      setDetail({ template: payload.template, items: payload.items ?? [] });
    } catch (error) {
      setDetail(null);
      setDetailError(error instanceof Error ? error.message : 'That workout template could not be opened.');
    } finally {
      setDetailLoading(false);
    }
  }, []);

  return (
    <main className="room room--floor min-h-screen bg-[var(--hide-950)] px-[var(--s5)] py-[var(--s6)] text-[color:var(--bone-200)]">
      <div className="mx-auto max-w-5xl">
        <header className="border-b-[3px] border-[color:var(--brass-700)] pb-[var(--s5)]">
          <p className="t-eyebrow">Coach</p>
          <h1 className="t-command mt-[var(--s3)] text-[length:var(--t-2xl)]">Workout Templates</h1>
          <p className="t-body mt-[var(--s3)] max-w-3xl text-[color:var(--bone-300)]">
            The reusable session shapes behind the plans: what a session of each type looks like,
            block by block. Read-only -- delivering a session live happens from Session Scripts.
          </p>
          <div className="mt-[var(--s4)] flex flex-wrap gap-[var(--s3)]">
            <Link href="/coach/session-scripts" className="btn btn--ghost">
              Go to session scripts
            </Link>
            <Link href="/coach/drills" className="btn btn--ghost">
              Back to drill library
            </Link>
          </div>
        </header>

        <section className="mt-[var(--s6)]">
          <h2 className="t-command text-[length:var(--t-lg)]">Templates</h2>

          {loading && <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">Loading...</p>}

          {!loading && loadError && (
            <div className="mt-[var(--s3)] rounded-[var(--r-md)] border-2 border-[var(--locked)] bg-[rgba(0,0,0,.28)] p-[var(--s4)]">
              <p className="text-[length:var(--t-sm)] font-semibold text-[var(--locked-ink)]">{loadError}</p>
              <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">
                This is a failure to load, not an empty catalog of templates.
              </p>
            </div>
          )}

          {!loading && !loadError && templates.length === 0 && (
            <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
              No workout templates are loaded in this environment yet.
            </p>
          )}

          <div className="mt-[var(--s4)] grid gap-[var(--s4)] md:grid-cols-2">
            {templates.map((template) => (
              <article key={template.template_id} className="mat-leather--raised rounded-[var(--r-lg)] p-[var(--s4)]">
                <div className="flex items-baseline justify-between gap-[var(--s3)]">
                  <h3 className="t-command text-[length:var(--t-md)]">{template.name}</h3>
                  <span className="plaque">{template.difficulty}</span>
                </div>
                <p className="t-label mt-[var(--s2)]">
                  {template.session_type.replace(/_/g, ' ')}
                  {` -- ${template.age_band}`}
                  {` -- ${template.duration_minutes} min`}
                </p>
                {template.intent.trim() !== '' && (
                  <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">{template.intent}</p>
                )}
                {template.requires_coach_authorization && (
                  <p className="t-body mt-[var(--s2)] text-[length:var(--t-xs)] text-[color:var(--bone-300)]">
                    Requires coach authorization before use.
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => void openTemplate(template.template_id)}
                  className="btn btn--ghost mt-[var(--s4)]"
                >
                  {openTemplateId === template.template_id ? 'Showing template' : 'Open template'}
                </button>
              </article>
            ))}
          </div>
        </section>

        {openTemplateId !== null && (
          <section className="mat-leather mt-[var(--s6)] rounded-[var(--r-lg)] p-[var(--s5)]">
            <h2 className="t-command text-[length:var(--t-lg)]">
              {detail ? detail.template.name : 'Workout template'}
            </h2>

            {detailLoading && (
              <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">Loading the template...</p>
            )}

            {!detailLoading && detailError && (
              <p role="alert" className="mt-[var(--s3)] rounded-[var(--r-md)] border-2 border-[var(--locked)] bg-[rgba(0,0,0,.28)] px-[var(--s3)] py-[var(--s3)] text-[length:var(--t-sm)] font-semibold text-[var(--locked-ink)]">
                {detailError}
              </p>
            )}

            {!detailLoading && !detailError && detail && (
              <>
                {(detail.template.coach_notes ?? '').trim() !== '' && (
                  <div className="mt-[var(--s4)] rounded-[var(--r-md)] border border-[color:rgba(212,175,74,.22)] bg-[rgba(0,0,0,.28)] p-[var(--s4)]">
                    <p className="t-label">Coach notes</p>
                    <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">{detail.template.coach_notes}</p>
                  </div>
                )}

                <h3 className="t-command mt-[var(--s5)] text-[length:var(--t-md)]">The blocks</h3>

                {detail.items.length === 0 && (
                  <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
                    This template has no items yet.
                  </p>
                )}

                <ol className="mt-[var(--s4)] flex flex-col gap-[var(--s3)]">
                  {detail.items.map((item) => (
                    <li
                      key={item.item_id}
                      className="rounded-[var(--r-md)] border border-[color:rgba(212,175,74,.22)] bg-[rgba(0,0,0,.28)] p-[var(--s4)]"
                    >
                      <div className="flex flex-wrap items-baseline gap-[var(--s3)]">
                        <span className="plaque">{item.block.replace(/_/g, ' ')}</span>
                        <h4 className="t-command text-[length:var(--t-sm)]">
                          {item.free_text_drill ?? item.drill_id ?? 'Unnamed drill'}
                        </h4>
                        {itemPrescription(item) !== '' && (
                          <span className="t-label">{itemPrescription(item)}</span>
                        )}
                        {item.scale_level && (
                          <span className="t-label">Scale {item.scale_level}</span>
                        )}
                        <span className="t-label text-[color:var(--bone-400)]">
                          {item.contact_level.replace(/_/g, ' ')}
                        </span>
                      </div>
                      {(item.coach_note ?? '').trim() !== '' && (
                        <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">
                          <span className="t-label">Note: </span>
                          {item.coach_note}
                        </p>
                      )}
                    </li>
                  ))}
                </ol>
              </>
            )}
          </section>
        )}
      </div>
    </main>
  );
}

export default function CoachWorkoutTemplatesPage() {
  return (
    <RoleSessionGate allowedRoles={['coach', 'admin']}>
      <CoachWorkoutTemplates />
    </RoleSessionGate>
  );
}
