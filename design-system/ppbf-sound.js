/* ===========================================================================
   PPBF Sound — the gym's own noises, synthesized
   ---------------------------------------------------------------------------
   ZERO ASSETS, same as everything else. There are no .mp3 or .wav files here:
   every sound is built from oscillators and filtered noise through the Web
   Audio API. The kiosk renders on a cold tablet with no network, and that
   promise does not get an exception for audio.

   FIVE RULES, stricter than the visual system's:

   1. OFF BY DEFAULT. Sound is opt-in, always. Browsers already require a user
      gesture before audio can start, so a page that wants sound must ask.

   2. NEVER THE ONLY CHANNEL. Law 3 does not stop applying because the channel
      is audio. Every sound accompanies a visible change — a stamp, a badge, a
      state flip. A user with the volume down, on a loud gym floor, or with a
      hearing impairment loses nothing. Sound is confirmation, never
      information.

   3. STATE CHANGES ONLY. A check-in accepted, a lock engaged, a round bell.
      Never hover, never focus, never keystrokes. UI chrome that clicks is how
      a tool starts feeling like a toy, and this one holds medical clearances.

   4. THE FLOOR IS LOUD. A gym floor at session time drowns a tablet speaker,
      so floor kiosks should generally leave this off and lean on the visual
      channel that already carries the whole message. Sound earns its place on
      quiet surfaces: the office, the clinic, an after-hours kiosk.

   5. ONE AT A TIME, AND SHORT. Nothing here runs past ~1.2s, and an overlapping
      call is dropped rather than stacked. A queue of chimes is noise.

   A CLASSIC SCRIPT, DELIBERATELY. This is not an ES module, because browsers
   block `import` over file:// on CORS grounds and every other preview in this
   folder opens by double-clicking it off disk. A module here would mean the
   sound section silently vanished for anyone browsing the design system the
   normal way. So the file defines one global and nothing else.

   USAGE — preview pages, and anything served from disk:
     <script src="../ppbf-sound.js"></script>
     const snd = new PPBFSound();
     await snd.enable();          // must be inside a click/keydown handler
     snd.play('bell');
     await snd.setEnabled(false); // persisted to localStorage

   USAGE — the Next.js app (bundlers happily take the side effect):
     import '@/../../design-system/ppbf-sound.js';
     const snd = new window.PPBFSound();

   Voices: 'bell' 'stamp' 'latch' 'accept' 'refuse'
   ========================================================================= */
(function () {
'use strict';

const STORAGE_KEY = 'ppbf.sound.enabled';

/* Bell partials are inharmonic — that is what separates struck bronze from a
   sine beep. These ratios approximate a small boxing-ring gong. */
const BELL_PARTIALS = [
  { ratio: 1.00, gain: 0.50, decay: 1.15 },
  { ratio: 2.01, gain: 0.22, decay: 0.80 },
  { ratio: 3.04, gain: 0.13, decay: 0.55 },
  { ratio: 4.22, gain: 0.07, decay: 0.35 },
  { ratio: 5.78, gain: 0.04, decay: 0.22 },
];

class PPBFSound {
  #ctx = null;
  #master = null;
  #enabled = false;
  #busyUntil = 0;

  constructor({ volume = 0.35 } = {}) {
    this.volume = volume;
    // Restore the stored choice, but never construct an AudioContext here:
    // one created outside a user gesture starts suspended and some browsers
    // warn on every page load.
    this.#enabled = readStoredPreference();
  }

  get enabled() { return this.#enabled; }

  /** True once audio is actually live and play() can make noise. */
  get running() { return this.#enabled && this.#ctx?.state === 'running'; }

  /**
   * Turn sound on. MUST be called from inside a user gesture.
   * Resolves true if audio is live afterwards.
   */
  async enable() {
    try {
      const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Ctor) throw new Error('Web Audio unavailable');

      if (!this.#ctx) {
        this.#ctx = new Ctor();
        this.#master = this.#ctx.createGain();
        this.#master.connect(this.#ctx.destination);
      }
      if (this.#ctx.state === 'suspended') await this.#ctx.resume();
      this.#master.gain.value = this.volume;

      this.#enabled = true;
      writeStoredPreference(true);
      return this.#ctx.state === 'running';
    } catch {
      // No Web Audio (old browser, locked-down kiosk). Stay silent — rule 2
      // means the visual channel already carries the whole message.
      this.#enabled = false;
      return false;
    }
  }

  /** @param {boolean} on */
  async setEnabled(on) {
    if (on) return this.enable();
    this.#enabled = false;
    writeStoredPreference(false);
    if (this.#master) this.#master.gain.value = 0;
    return false;
  }

  /**
   * Fire a voice by name. Safe to call unconditionally: returns false and does
   * nothing when disabled, unsupported, unknown, or still busy.
   * @returns {boolean} whether the sound was actually started
   */
  play(name) {
    if (!this.running) return false;
    const now = this.#ctx.currentTime;
    if (now < this.#busyUntil) return false;      // rule 5: no stacking

    switch (name) {
      case 'bell':   this.#busyUntil = now + this.#bell();   return true;
      case 'stamp':  this.#busyUntil = now + this.#stamp();  return true;
      case 'latch':  this.#busyUntil = now + this.#latch();  return true;
      case 'accept': this.#busyUntil = now + this.#accept(); return true;
      case 'refuse': this.#busyUntil = now + this.#refuse(); return true;
      default: return false;
    }
  }

  /* --- primitives ------------------------------------------------------- */

  /** Percussive envelope: near-instant attack, exponential decay. */
  #env(dur, peak, delay = 0) {
    const g = this.#ctx.createGain();
    const t = this.#ctx.currentTime + delay;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + 0.004);
    // exponentialRampToValueAtTime can never reach 0, so decay to a floor.
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.connect(this.#master);
    return g;
  }

  #tone({ freq, dur, type = 'sine', peak = 0.4, delay = 0 }) {
    const t = this.#ctx.currentTime + delay;
    const o = this.#ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    const g = this.#env(dur, peak, delay);
    o.connect(g);
    o.start(t);
    o.stop(t + dur + 0.02);
    o.onended = () => { o.disconnect(); g.disconnect(); };
  }

  /* A burst of filtered noise — the transient of a physical impact. Without
     it a "thud" is just a low sine, which reads as a video game. */
  #noise({ dur, cutoff = 1400, type = 'lowpass', peak = 0.5, q = 0.8, delay = 0 }) {
    const t = this.#ctx.currentTime + delay;
    const rate = this.#ctx.sampleRate;
    const len = Math.max(1, Math.ceil(rate * dur));
    const buf = this.#ctx.createBuffer(1, len, rate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    const src = this.#ctx.createBufferSource();
    src.buffer = buf;
    const filt = this.#ctx.createBiquadFilter();
    filt.type = type;
    filt.frequency.setValueAtTime(cutoff, t);
    filt.Q.value = q;
    const g = this.#env(dur, peak, delay);
    src.connect(filt);
    filt.connect(g);
    src.start(t);
    src.onended = () => { src.disconnect(); filt.disconnect(); g.disconnect(); };
  }

  /* --- the five voices. Each returns its duration in seconds. ----------- */

  /** The round bell. Struck bronze: inharmonic partials, long tail. */
  #bell() {
    for (const p of BELL_PARTIALS) {
      this.#tone({ freq: 784 * p.ratio, dur: p.decay, type: 'sine', peak: p.gain });
    }
    // The strike. Without a transient the bell fades in rather than being hit.
    this.#noise({ dur: 0.03, cutoff: 5200, type: 'bandpass', peak: 0.30, q: 1.4 });
    return 1.15;
  }

  /** A rubber stamp driven into paper. Impact, no ring — same physics as
      --e-stamp: it arrives and stops dead. */
  #stamp() {
    this.#noise({ dur: 0.07, cutoff: 900, type: 'lowpass', peak: 0.85 });
    this.#tone({ freq: 128, dur: 0.10, type: 'triangle', peak: 0.55 });
    return 0.14;
  }

  /** A lock engaging — Layer 11. Mechanical and final, deliberately not a
      "sad" tone: a safety lock is correct behaviour, not a failure. */
  #latch() {
    this.#noise({ dur: 0.045, cutoff: 2600, type: 'bandpass', peak: 0.70, q: 2.2 });
    this.#tone({ freq: 196, dur: 0.16, type: 'square', peak: 0.16 });
    this.#tone({ freq: 392, dur: 0.09, type: 'triangle', peak: 0.14 });
    return 0.20;
  }

  /** Accepted — a check-in cleared. Two notes rising a fifth. */
  #accept() {
    this.#tone({ freq: 523.25, dur: 0.13, type: 'triangle', peak: 0.42 });
    this.#tone({ freq: 783.99, dur: 0.20, type: 'triangle', peak: 0.38, delay: 0.09 });
    return 0.32;
  }

  /** Refused — Layer 20 declines, or a gate withholds. A flat low double note,
      firm rather than shrill: the REDACTED stamp on screen does the telling. */
  #refuse() {
    this.#tone({ freq: 174.61, dur: 0.22, type: 'sawtooth', peak: 0.22 });
    this.#tone({ freq: 164.81, dur: 0.28, type: 'sawtooth', peak: 0.18, delay: 0.02 });
    return 0.30;
  }
}

/* --- preference storage --------------------------------------------------
   localStorage throws in some embedded webviews and in private mode. A sound
   preference is never worth breaking a page over. */
function readStoredPreference() {
  try { return globalThis.localStorage?.getItem(STORAGE_KEY) === '1'; }
  catch { return false; }
}
function writeStoredPreference(on) {
  try { globalThis.localStorage?.setItem(STORAGE_KEY, on ? '1' : '0'); }
  catch { /* a blocked storage API is not an error worth surfacing */ }
}

globalThis.PPBFSound = PPBFSound;
})();
