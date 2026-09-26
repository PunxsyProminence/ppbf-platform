import { redirect } from 'next/navigation';

/*
 * COMPATIBILITY REDIRECT. Clip Annotation now lives under Teach Shadow, at
 * /teach-shadow/annotation, because labelling a study clip is machine teaching
 * and the owner ruled that work into its own area rather than leaving it
 * scattered under /coach/.
 *
 * KEPT RATHER THAN DELETED because this URL is in people's history, in the
 * bootstrap script's comments, and in whatever a coach bookmarked while
 * annotating. A 404 would read as "the annotation tool is gone", which is the
 * opposite of what happened.
 *
 * It carries no door of its own -- buildingMapCoverage.test.ts's EXCLUDED
 * names it for that reason. One surface, one door, at the path that serves it.
 */
export default function CoachCalibrationAliasPage() {
  redirect('/teach-shadow/annotation');
}
