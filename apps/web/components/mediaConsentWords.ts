// What the two consent screens tell families about where photos and video go
// (HF9-1, lane HF8-9). The owner chose these words: Q3 = A, "A: full wording",
// on #2083. They live in one file so a change of words is one change, and
// mediaConsentWords.test.ts holds a second, hand-written copy of each.
//
// WHY THEY SAY WHAT THEY SAY. Still frames from videos are sent to Microsoft's
// Azure AI service by one function, analyzeFramesWithVision
// (src/server/pilot/shadowFilmStudy.ts), from two places that touch member
// video:
//   - the upload safety scan (videoScan.ts, from videoScanSweep.ts). For a
//     video that names athletes, only when every guardian of every named
//     child has signed and covers video, or the adult's own consent covers it
//     (OD-2026-10-05-022). A video that names nobody, such as team video with
//     no one tagged, is scanned without asking (OD-2026-10-08-014), and so is
//     Teach Shadow footage (the code's reading of OD-2026-09-28-006). Someone
//     in another athlete's video who is not tagged is never asked.
//   - Film Study, when a coach or the gym administrator asks
//     (shadowJobProcessor.ts), with the same consent for the video's own
//     athlete and every tagged athlete (filmStudyConsent.ts).
// The third caller, the admin diagnostic, sends a clip it makes itself.
//
// The test's tripwire fails if a new caller appears. The words are the
// owner's: ask the owner before changing them.

/** The guardian consent page, on every child's card, signed or not (see guardianMediaWords). */
export const GUARDIAN_MEDIA_WORDS =
  'Photos and video are used inside the gym: coaches review them, and a clip the gym publishes goes in its clip '
  + 'library, which coaches and athletes signed in at this gym can browse. Nothing is posted publicly on this consent. '
  + "Still frames from videos are also sent to Microsoft's Azure AI service, which the gym's app uses to check new "
  + "videos for safety and, when a coach or the gym administrator asks, to describe the technique in one athlete's "
  + 'video. Your choice here covers videos your child is filed under or tagged in: with photos only, or no consent, '
  + 'frames from those are not sent. A video your child is in but not tagged in, such as a team video with no one '
  + "tagged, a teaching video, or another athlete's video, can be sent whatever you choose here.";

/** The adult athlete's own panel, straight after what the consent is about. */
export const ADULT_MEDIA_FRAMES_WORDS =
  "Still frames from videos are also sent to Microsoft's Azure AI service, which the gym's app uses to check new "
  + "videos for safety and, when a coach or the gym administrator asks, to describe the technique in one athlete's "
  + 'video. Your choice here covers videos you are filed under or tagged in. A video you are in but not tagged in, '
  + "such as a team video with no one tagged, a teaching video, or another athlete's video, can be sent whatever you "
  + 'choose here.';

// THE ONE SENTENCE A CARD CAN LEAVE OUT. An admin can record a guardian's
// public use from their signed paper form (OD-2026-10-09-003), and that card
// already says "public use allowed" (app/parent/consent/page.tsx). On it, this
// sentence would say the opposite. The owner's answer (Overwatch on #2083,
// comment 7085637440): leave out only this sentence on such a card.
const PUBLIC_SENTENCE = 'Nothing is posted publicly on this consent. ';

/**
 * The guardian passage for one card. `publicUseOnFile` is true only when this
 * guardian's own consent on file is signed and allows public use, the card
 * that reads "public use allowed".
 */
export function guardianMediaWords(publicUseOnFile: boolean): string {
  return publicUseOnFile ? GUARDIAN_MEDIA_WORDS.replace(PUBLIC_SENTENCE, '') : GUARDIAN_MEDIA_WORDS;
}

/**
 * The guardian page header. The owner's answer (same comment): it no longer
 * says the choice "controls one thing"; it also says the choice decides
 * playback and whether still frames go to Microsoft's Azure AI service, in the
 * ruled passages' own words where they have them.
 *
 * Playback is refused when any guardian of the video's own athlete or of a
 * tagged athlete chose photos only or withdrew (assertConsentCoversVideo,
 * through mintUnderPlaybackConsent in app/api/pilot/video/[videoId]/route.ts).
 * A missing consent does not refuse playback, which is why this says the
 * choice "decides whether" and does not say that no answer stops it.
 */
export const GUARDIAN_PAGE_INTRO_WORDS =
  'Nothing here blocks your child from training. It decides whether photos or videos of your child may be used in '
  + 'gym publications. For videos your child is filed under or tagged in, it also decides whether they can be played '
  + "back in the gym's app and whether still frames from them are sent to Microsoft's Azure AI service. You can grant "
  + 'or withdraw consent at any time. If your child has more than one guardian, every guardian must consent before '
  + 'anything is published.';
