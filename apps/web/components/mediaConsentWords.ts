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

/** The guardian consent page, on every child's card, signed or not. */
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
