import { Injectable } from '@angular/core';

/**
 * Musical note name. Sharps only; flats can be normalized to sharps by the
 * caller (e.g. Db -> C#).
 */
export type NoteName =
  | 'C'
  | 'C#'
  | 'D'
  | 'D#'
  | 'E'
  | 'F'
  | 'F#'
  | 'G'
  | 'G#'
  | 'A'
  | 'A#'
  | 'B';

/**
 * A single pitch. Middle C is C4 (= MIDI 60).
 */
export interface Pitch {
  note: NoteName;
  octave: number;
}

/**
 * Composite voices — each one is a mix of harmonics built from standard
 * oscillators, no external samples required. For raw oscillator types
 * (`'sine'`, `'square'`, `'triangle'`, `'sawtooth'`) pass an OscillatorType
 * directly to playNote's `waveform` option.
 *
 * Soft / mellow voices are listed first because they're the ones people
 * usually want for ambient sound design:
 *  - glass        : crystalline sine + light inharmonic shimmer
 *  - marimba      : warm triangle fundamental + quick-decay wood tone
 *  - musicBox     : bell-like partials with very fast decay
 *  - softPiano    : gentler version of `piano` with subdued upper harmonics
 *  - softPad      : slow-attack detuned sines, the calmest voice
 *
 * More characterful voices come after:
 *  - piano        : acoustic-ish piano with decaying partials
 *  - bell         : FM-ish bell with inharmonic ratios
 *  - organ        : full Hammond-like harmonic stack
 *  - pluck        : triangle fundamental with fast release
 *  - lead         : detuned saw pair (synth lead)
 *  - bass         : sine sub + slight triangle harmonic
 *  - pad          : detuned sines + subtle triangle harmonic
 */
export type VoiceName =
  | 'glass'
  | 'marimba'
  | 'musicBox'
  | 'softPiano'
  | 'softPad'
  | 'piano'
  | 'bell'
  | 'organ'
  | 'pluck'
  | 'lead'
  | 'bass'
  | 'pad';

/**
 * Options accepted by playNote / playChord.
 */
export interface PlayOptions {
  /** Note length in ms. If omitted, the note is held until stopNote() is called. */
  durationMs?: number;
  /** Note velocity in 0..1. Defaults to 0.7. */
  velocity?: number;
  /**
   * Oscillator waveform or composite voice name. Defaults to 'sine'.
   * Composite voices (e.g. 'piano', 'lead', 'bell') are built from multiple
   * oscillators in the service so callers don't need any external setup.
   */
  waveform?: OscillatorType | VoiceName;
}

/**
 * Step inside a sequence. One of:
 *  - { note: 'C4', durationMs: 300 }
 *  - { chord: ['C4', 'E4', 'G4'], durationMs: 600 }
 *  - { restMs: 100 }
 */
export type SequenceStep =
  | { note: string; durationMs?: number }
  | { chord: string[]; durationMs?: number }
  | { restMs: number };

export interface SequenceOptions {
  /** Delay between consecutive steps. Defaults to 0. */
  gapMs?: number;
  /** Override waveform / voice for every note in the sequence. */
  waveform?: OscillatorType | VoiceName;
  /** Override velocity for every note in the sequence. */
  velocity?: number;
  /**
   * Legato overlap in ms. Each step starts this many ms BEFORE the previous
   * step finishes, blending into it instead of leaving a hard gap.
   * Defaults to 60ms — gives a much more organic, connected feel.
   * Set to 0 for crisp staccato.
   */
  legatoMs?: number;
  /**
   * Timing humanization as a fraction (0..1). Each step's wait is randomly
   * nudged by up to this fraction of the wait time. 0.08 = ±8% feel.
   * Defaults to 0.08.
   */
  humanize?: number;
  /**
   * Velocity humanization as a fraction (0..1). Each note's velocity is
   * randomly nudged by up to this fraction of its target velocity.
   * Defaults to 0.12.
   */
  velocityHumanize?: number;
}

interface ActiveVoice {
  /** Per-partial oscillator + gain nodes. Composite voices have several. */
  oscs: { osc: OscillatorNode; gain: GainNode }[];
  /** Master gain of the whole voice. */
  master: GainNode;
}

/**
 * One harmonic of a composite voice.
 */
export interface Harmonic {
  /** Frequency multiplier of the fundamental (1 = root, 2 = octave up, ...). */
  mult: number;
  /** Relative volume 0..1. */
  gain: number;
  /** Oscillator waveform used for this harmonic. */
  type: OscillatorType;
  /** Detune in cents (100 cents = 1 semitone). */
  detune?: number;
}

/**
 * MIDI note number to frequency.
 * Standard: A4 = 69 = 440Hz.
 */
const A4_MIDI = 69;
const A4_FREQ = 440;

const NOTE_INDEX: Record<NoteName, number> = {
  C: 0,
  'C#': 1,
  D: 2,
  'D#': 3,
  E: 4,
  F: 5,
  'F#': 6,
  G: 7,
  'G#': 8,
  A: 9,
  'A#': 10,
  B: 11,
};

const FLAT_TO_SHARP: Record<string, NoteName> = {
  Db: 'C#',
  Eb: 'D#',
  Gb: 'F#',
  Ab: 'G#',
  Bb: 'A#',
};

/**
 * Generates musical tones using the Web Audio API. No external assets
 * required — pure oscillators + envelopes.
 *
 * Designed to be flexible: callers can hit single notes (the piano UI),
 * chords, or predefined sequences (planning-page hooks such as "ticket
 * urgente llegó", "ticket resuelto", etc).
 *
 * The AudioContext is created lazily and resumed on demand. Browsers
 * require a user gesture before audio can play, so call `resume()` (or
 * any play* method) from a click/keydown handler.
 */
@Injectable({ providedIn: 'root' })
export class PianoSoundService {
  private audioCtx: AudioContext | null = null;
  private masterGain: GainNode | null = null;

  /**
   * Promise that resolves once the AudioContext exists and is in `running`
   * state. Used to make the first note sound reliably: every play* call
   * awaits this promise, so a freshly-created (still-suspended) context
   * gets resumed before we try to schedule anything.
   */
  private contextReadyPromise: Promise<AudioContext | null> | null = null;

  /** Active (held) voices keyed by pitch string ("C4", "F#5", ...). */
  private active = new Map<string, ActiveVoice>();

  /** Volume 0..1. Applied via masterGain. */
  private volume = 0.7;

  /** Default voice for any note that does not override it. */
  private defaultVoice: OscillatorType | VoiceName = 'sine';

  /** Sequence scheduling handle. */
  private sequenceTimer: any = null;
  /** Loop re-trigger handle. Kept separate so stopSequence() can clean
   * up both the running scheduler and the pending loop callback. */
  private loopTimerHandle: any = null;
  /** When loop mode is engaged, we keep a flag here so the recursive
   * re-trigger doesn't pile up if the user calls stopSequence() while
   * a re-trigger is in flight. */
  private loopActive = false;
  private sequenceStepIndex = 0;

  /**
   * Returns the AudioContext, creating it (and the master gain) on first use.
   * Synchronous; does NOT wait for the context to leave `suspended`.
   * Callers that need to schedule sounds should prefer `ensureRunning()` so
   * the first note after a fresh creation is not dropped while the browser
   * resumes the context.
   */
  private ctx(): AudioContext | null {
    try {
      const Win = window as any;
      const Ctx: typeof AudioContext =
        Win.AudioContext || Win.webkitAudioContext;
      if (!Ctx) return null;
      if (!this.audioCtx) {
        this.audioCtx = new Ctx();
        this.masterGain = this.audioCtx.createGain();
        this.masterGain.gain.value = this.volume;
        this.masterGain.connect(this.audioCtx.destination);
      }
      return this.audioCtx;
    } catch {
      return null;
    }
  }

  /**
   * Ensures the AudioContext is created AND running. Resolves with the
   * context (or null if Web Audio is unavailable). Subsequent calls reuse
   * the same promise so the resume() is only awaited once at the very
   * first user gesture.
   *
   * This is the function all `play*` methods await internally — it's what
   * fixes the "first note is dropped" symptom. Without it, on first use
   * the context is `suspended` and the browser may swallow the note that
   * races with the resume().
   */
  private ensureRunning(): Promise<AudioContext | null> {
    if (this.contextReadyPromise) return this.contextReadyPromise;
    const ctx = this.ctx();
    if (!ctx) {
      this.contextReadyPromise = Promise.resolve(null);
      return this.contextReadyPromise;
    }
    if (ctx.state === 'running') {
      this.contextReadyPromise = Promise.resolve(ctx);
      return this.contextReadyPromise;
    }
    this.contextReadyPromise = (async () => {
      try {
        if (ctx.state === 'suspended') {
          await ctx.resume();
        }
      } catch {
        /* noop */
      }
      return ctx.state === 'running' ? ctx : null;
    })();
    return this.contextReadyPromise;
  }

  /**
   * Must be called from a user gesture handler the first time audio is used,
   * otherwise the browser will leave the AudioContext in 'suspended' state.
   */
  async resume(): Promise<void> {
    const ctx = this.ctx();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        /* noop */
      }
    }
  }

  /**
   * Returns the underlying AudioContext (creating it lazily on first use),
   * or null if Web Audio is unavailable. Useful for sequencers / visualizers
   * that need precise audio-time scheduling.
   */
  getAudioContext(): AudioContext | null {
    return this.ctx();
  }

  /**
   * Sets the master volume (0..1). Values are clamped.
   */
  setVolume(value: number): void {
    this.volume = Math.max(0, Math.min(1, value));
    if (this.masterGain) {
      this.masterGain.gain.value = this.volume;
    }
  }

  getVolume(): number {
    return this.volume;
  }

  /**
   * Sets the default voice for any note that doesn't override it.
   */
  setWaveform(w: OscillatorType | VoiceName): void {
    this.defaultVoice = w;
  }

  /**
   * Returns true if the given identifier is a built-in composite voice
   * (vs. a raw oscillator type).
   */
  static isVoiceName(w: any): w is VoiceName {
    return (
      w === 'glass' ||
      w === 'marimba' ||
      w === 'musicBox' ||
      w === 'softPiano' ||
      w === 'softPad' ||
      w === 'piano' ||
      w === 'bell' ||
      w === 'organ' ||
      w === 'pluck' ||
      w === 'lead' ||
      w === 'bass' ||
      w === 'pad'
    );
  }

  /**
   * Harmonic recipe for each composite voice. Pure oscillator mix — no
   * samples required. Each entry is one oscillator with its own gain.
   */
  private static readonly VOICE_RECIPES: Record<VoiceName, Harmonic[]> = {
    // ----- Soft / mellow voices ----------------------------------

    /**
     * Crystalline glass. Pure sine fundamental + light inharmonic shimmer
     * (3rd harmonic slightly off-integer). Very airy, almost no body.
     */
    glass: [
      { mult: 1, gain: 1.0, type: 'sine' },
      { mult: 3.01, gain: 0.18, type: 'sine' },
      { mult: 5.99, gain: 0.06, type: 'sine' },
    ],

    /**
     * Warm marimba. Triangle fundamental carries the body, with a soft
     * 4th-harmonic "knock" that sells the wooden bar feel.
     */
    marimba: [
      { mult: 1, gain: 1.0, type: 'triangle' },
      { mult: 4, gain: 0.32, type: 'sine' },
    ],

    /**
     * Music box. Triangle fundamental with bell-like upper partials at
     * lightly inharmonic ratios. Quiet, slightly metallic shimmer.
     */
    musicBox: [
      { mult: 1, gain: 0.9, type: 'triangle' },
      { mult: 2, gain: 0.35, type: 'sine' },
      { mult: 3.01, gain: 0.18, type: 'sine' },
      { mult: 5.98, gain: 0.08, type: 'sine' },
    ],

    /**
     * Softer version of `piano` — same shape but the upper harmonics are
     * pulled way down so it sounds muted and felted (think practice-room
     * piano with the lid closed).
     */
    softPiano: [
      { mult: 1, gain: 1.0, type: 'sine' },
      { mult: 2, gain: 0.18, type: 'triangle' },
      { mult: 3, gain: 0.05, type: 'sine' },
    ],

    /**
     * Calmest voice in the set. Slowly-attacking detuned sines with very
     * subdued harmonics — washes out into a warm pad.
     */
    softPad: [
      { mult: 1, gain: 0.6, type: 'sine', detune: -4 },
      { mult: 1, gain: 0.6, type: 'sine', detune: 4 },
      { mult: 2, gain: 0.1, type: 'sine' },
    ],

    // ----- Character voices --------------------------------------

    /** Acoustic-ish piano: fundamental + a few quickly-decaying partials. */
    piano: [
      { mult: 1, gain: 1.0, type: 'sine' },
      { mult: 2, gain: 0.45, type: 'triangle' },
      { mult: 3, gain: 0.18, type: 'sine' },
      { mult: 4, gain: 0.08, type: 'sine' },
    ],
    /** FM-ish bell: inharmonic ratios + quick decay character. */
    bell: [
      { mult: 1, gain: 0.7, type: 'sine' },
      { mult: 2.76, gain: 0.5, type: 'sine' },
      { mult: 5.4, gain: 0.25, type: 'sine' },
      { mult: 8.93, gain: 0.12, type: 'sine' },
    ],
    /** Hammond-ish organ: full harmonic stack with slight detune. */
    organ: [
      { mult: 1, gain: 0.55, type: 'sine' },
      { mult: 2, gain: 0.4, type: 'sine' },
      { mult: 3, gain: 0.3, type: 'sine' },
      { mult: 4, gain: 0.18, type: 'sine' },
      { mult: 6, gain: 0.1, type: 'sine' },
      { mult: 8, gain: 0.06, type: 'sine' },
    ],
    /** Plucked string: triangle fundamental + harmonics, fast release. */
    pluck: [
      { mult: 1, gain: 1.0, type: 'triangle' },
      { mult: 2, gain: 0.35, type: 'triangle' },
      { mult: 3, gain: 0.12, type: 'triangle' },
    ],
    /** Synth lead: detuned saw pair + octave. */
    lead: [
      { mult: 1, gain: 0.45, type: 'sawtooth', detune: -7 },
      { mult: 1, gain: 0.45, type: 'sawtooth', detune: 7 },
      { mult: 2, gain: 0.2, type: 'sawtooth' },
    ],
    /** Sub bass: low sine + slight saw harmonic, short release. */
    bass: [
      { mult: 1, gain: 1.0, type: 'sine' },
      { mult: 2, gain: 0.15, type: 'triangle' },
    ],
    /** Pad: detuned sines + slight low-pass via slow attack. */
    pad: [
      { mult: 1, gain: 0.55, type: 'sine', detune: -5 },
      { mult: 1, gain: 0.55, type: 'sine', detune: 5 },
      { mult: 2, gain: 0.2, type: 'sine' },
      { mult: 3, gain: 0.1, type: 'triangle' },
    ],
  };

  /**
   * Parses a string pitch like "C4", "F#5", "Bb3" into a Pitch object.
   * Returns null if the string cannot be parsed.
   */
  parsePitch(input: string): Pitch | null {
    if (!input) return null;
    const trimmed = String(input).trim();
    const match = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(trimmed);
    if (!match) return null;
    const letter = match[1].toUpperCase() as 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
    const accidental = match[2];
    const octave = parseInt(match[3], 10);

    let base: string;
    if (accidental === '#') {
      base = letter + '#';
    } else if (accidental === 'b') {
      base = letter + 'b';
      const normalized = FLAT_TO_SHARP[base];
      if (!normalized) return null;
      base = normalized;
    } else {
      base = letter;
    }

    if (!(base in NOTE_INDEX)) return null;
    return { note: base as NoteName, octave };
  }

  /**
   * Returns the frequency (Hz) for a given pitch.
   */
  frequencyOf(pitch: Pitch): number {
    const midi =
      (pitch.octave + 1) * 12 + NOTE_INDEX[pitch.note] - (12 + 9);
    return A4_FREQ * Math.pow(2, (midi - A4_MIDI) / 12);
  }

  /**
   * Plays a single note. Pass either a "C4" string or a Pitch object.
   * If `durationMs` is given the note auto-stops after that. Otherwise it
   * is held until `stopNote()` is called with the same pitch.
   *
   * The envelope has a soft attack (~18ms), a slow exponential release
   * (~220ms), and a gentle mid-sustain dip on long notes so they don't
   * sound flat — much more organic than a pure on/off oscillator.
   */
  /**
   * Plays a single note. Pass either a "C4" string or a Pitch object.
   * If `durationMs` is given the note auto-stops after that. Otherwise it
   * is held until `stopNote()` is called with the same pitch.
   *
   * Awaits `ensureRunning()` internally so the first note after a fresh
   * context (or after the browser suspended it) is never dropped.
   */
  async playNote(input: string | Pitch, options?: PlayOptions): Promise<void> {
    const pitch = typeof input === 'string' ? this.parsePitch(input) : input;
    if (!pitch) return;
    const ctx = await this.ensureRunning();
    if (!ctx || !this.masterGain) return;
    this.scheduleNote(pitch, ctx, ctx.currentTime, options);
  }

  /**
   * Schedules a note on the AudioContext timeline at `targetTime`. All
   * envelope / oscillator events use `targetTime` as their reference so
   * the audio engine plays them sample-accurately regardless of when this
   * is called (i.e. it doesn't suffer setTimeout jitter).
   *
   * This is the only place where notes are actually created. Public
   * `playNote` / `playChord` / `playSequence` route through here.
   */
  private scheduleNote(
    pitch: Pitch,
    ctx: AudioContext,
    targetTime: number,
    options?: PlayOptions,
  ): void {
    if (!this.masterGain) return;
    const key = `${pitch.note}${pitch.octave}`;

    // If the same note is already playing, stop the previous one first
    // so we never stack two oscillators on the same pitch.
    this.stopNoteInternal(key);

    const velocity = Math.max(0, Math.min(1, options?.velocity ?? 0.7));
    const voice = options?.waveform ?? this.defaultVoice;
    const freq = this.frequencyOf(pitch);

    const voiceMaster = ctx.createGain();
    const attack = 0.018;
    const release = 0.22;
    voiceMaster.gain.setValueAtTime(0.0001, targetTime);
    voiceMaster.gain.exponentialRampToValueAtTime(
      velocity,
      targetTime + attack,
    );
    voiceMaster.connect(this.masterGain);

    const partials = this.buildPartials(ctx, voice, freq, targetTime, voiceMaster);

    const active: ActiveVoice = { oscs: partials, master: voiceMaster };
    this.active.set(key, active);

    if (options?.durationMs && options.durationMs > 0) {
      const noteDur = options.durationMs / 1000;
      const stopAt = targetTime + noteDur;
      // Subtle mid-sustain dip so long notes don't feel flat. ~8% drop
      // at the middle of the note's lifetime, ramped back up before release.
      if (noteDur > 0.25) {
        const dipAt = targetTime + noteDur * 0.55;
        const dipLevel = Math.max(0.0001, velocity * 0.92);
        voiceMaster.gain.setValueAtTime(velocity, dipAt - 0.001);
        voiceMaster.gain.exponentialRampToValueAtTime(dipLevel, dipAt);
        voiceMaster.gain.exponentialRampToValueAtTime(velocity, stopAt - 0.05);
      }
      voiceMaster.gain.setValueAtTime(
        voiceMaster.gain.value,
        stopAt - 0.005,
      );
      voiceMaster.gain.exponentialRampToValueAtTime(0.0001, stopAt + release);
      for (const p of partials) {
        try {
          p.osc.stop(stopAt + release + 0.02);
        } catch {
          /* osc already stopped */
        }
      }
      const ourVoice = active;
      // Cleanup uses wall-clock since `Date.now()` is the only safe clock
      // here — targetTime is in audio time and would over-shoot.
      setTimeout(
        () => {
          if (this.active.get(key) === ourVoice) {
            this.active.delete(key);
          }
        },
        options.durationMs + (release + 0.1) * 1000,
      );
    }
  }

  /**
   * Builds the oscillators for a given voice (raw type or composite).
   * Returns the partials connected to the given voice-master gain.
   */
  private buildPartials(
    ctx: AudioContext,
    voice: OscillatorType | VoiceName,
    freq: number,
    now: number,
    out: GainNode,
  ): { osc: OscillatorNode; gain: GainNode }[] {
    if (PianoSoundService.isVoiceName(voice)) {
      const recipe = PianoSoundService.VOICE_RECIPES[voice];
      return recipe.map((h) => {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = h.type;
        osc.frequency.setValueAtTime(freq * h.mult, now);
        if (h.detune) osc.detune.setValueAtTime(h.detune, now);
        g.gain.setValueAtTime(h.gain, now);
        osc.connect(g);
        g.connect(out);
        osc.start(now);
        return { osc, gain: g };
      });
    }

    // Raw oscillator.
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = voice as OscillatorType;
    osc.frequency.setValueAtTime(freq, now);
    g.gain.setValueAtTime(1, now);
    osc.connect(g);
    g.connect(out);
    osc.start(now);
    return [{ osc, gain: g }];
  }

  /**
   * Stops a single note (the one that was held without a duration).
   * Safe to call even if the note is not currently active.
   */
  stopNote(input: string | Pitch): void {
    const pitch = typeof input === 'string' ? this.parsePitch(input) : input;
    if (!pitch) return;
    this.stopNoteInternal(`${pitch.note}${pitch.octave}`);
  }

  private stopNoteInternal(key: string): void {
    const voice = this.active.get(key);
    if (!voice) return;
    this.active.delete(key);
    try {
      const ctx = this.audioCtx;
      if (ctx) {
        const now = ctx.currentTime;
        const release = 0.12;
        voice.master.gain.cancelScheduledValues(now);
        voice.master.gain.setValueAtTime(voice.master.gain.value, now);
        voice.master.gain.exponentialRampToValueAtTime(
          0.0001,
          now + release,
        );
        for (const p of voice.oscs) {
          try {
            p.osc.stop(now + release + 0.01);
          } catch {
            /* osc may have already stopped */
          }
        }
      }
    } catch {
      /* master may already be gone */
    }
  }

  /**
   * Stops every held note. Useful when leaving the page or interrupting
   * a live performance.
   */
  stopAll(): void {
    for (const key of Array.from(this.active.keys())) {
      this.stopNoteInternal(key);
    }
  }

  /**
   * Plays a chord (multiple notes simultaneously) for `durationMs` ms.
   *
   * Resolves all notes to a single shared `targetTime` so they all start
   * sample-accurately together (otherwise each `playNote` would compute
   * its own `currentTime` and the chord would smear by a few ms).
   */
  async playChord(
    input: Array<string | Pitch>,
    options?: PlayOptions,
  ): Promise<void> {
    if (!input?.length) return;
    const dur = options?.durationMs ?? 600;
    const ctx = await this.ensureRunning();
    if (!ctx || !this.masterGain) return;
    const targetTime = ctx.currentTime;
    for (const p of input) {
      const pitch = typeof p === 'string' ? this.parsePitch(p) : p;
      if (!pitch) continue;
      this.scheduleNote(pitch, ctx, targetTime, { ...options, durationMs: dur });
    }
  }

  /**
   * Schedules a sequence of steps to be played one after another. Each step
   * has its own `durationMs`; `gapMs` adds silence between consecutive steps.
   *
   * Legato / humanization defaults (override via SequenceOptions):
   *  - `legatoMs: 60`     — each step starts this many ms BEFORE the
   *                         previous one finishes, blending into it instead
   *                         of leaving a hard gap.
   *  - `humanize: 0.08`   — timing of each step's wait is nudged by up to
   *                         ±8 % randomly, so the rhythm doesn't feel
   *                         quantized / robotic.
   *  - `velocityHumanize: 0.12` — each note's velocity is nudged by up to
   *                         ±12 %, adding natural dynamic variation.
   *
  /**
   * Schedules a sequence of steps to be played one after another.
   *
   * Uses a look-ahead scheduler: a `setTimeout` tick (every 25ms) decides
   * which events are due in the next ~150ms and pre-schedules them on the
   * AudioContext timeline (sample-accurate). This avoids the 5–20 ms jitter
   * of pure `setTimeout`-driven playback that you can hear as irregular
   * note durations.
   *
   * Humanization (`humanize`, `velocityHumanize`) is applied to the AUDIO
   * TIME of each event, not to the setTimeout wait, so timing stays musical
   * without accumulating drift.
   *
   * Replaces any currently running sequence. Call `stopSequence()` to abort.
   *
   * Returns a promise that resolves once the AudioContext is running and
   * the first event has been scheduled — safe to await if you need to know
   * the sequence has actually started. Most callers can ignore it.
   */
  playSequence(
    steps: SequenceStep[],
    options?: SequenceOptions,
  ): Promise<void> {
    this.stopSequence();
    if (!steps?.length) return Promise.resolve();

    const gap = options?.gapMs ?? 0;
    const legato = options?.legatoMs ?? 60;
    const humanize = options?.humanize ?? 0.08;
    const velocityHumanize = options?.velocityHumanize ?? 0.12;
    const baseVelocity = options?.velocity;
    const waveform = options?.waveform;

    /** Look-ahead in seconds. Events scheduled within this window of
     * `currentTime` get pushed onto the AudioContext. */
    const LOOKAHEAD_S = 0.15;
    /** setTimeout tick interval. Keep small enough that we never miss a
     * short event, but big enough not to peg the CPU. */
    const TICK_MS = 25;

    // Pre-compute the timeline as (audioTime, noteOrChord, durationMs)
    // pairs. We compute everything up-front using a relative timeline,
    // then shift it by the AudioContext time once it's available.
    interface ScheduledEvent {
      /** Absolute audio time (seconds) at which the note should play. */
      audioTime: number;
      /** 'note' | 'chord' | 'rest' */
      kind: 'note' | 'chord' | 'rest';
      note?: string;
      chord?: string[];
      durationMs?: number;
    }

    const events: ScheduledEvent[] = [];
    let cursorMs = 0;

    for (const step of steps) {
      // Apply timing humanization to each step's start time.
      if (humanize > 0 && events.length > 0) {
        const jitter = 1 + (Math.random() * 2 - 1) * humanize;
        cursorMs = Math.max(0, cursorMs * jitter);
      }

      if ('restMs' in step) {
        cursorMs += step.restMs;
        continue;
      }

      // Velocity with humanization.
      const v = baseVelocity !== undefined ? baseVelocity : 0.7;
      let velocity = v;
      if (velocityHumanize > 0) {
        const jitter = 1 + (Math.random() * 2 - 1) * velocityHumanize;
        velocity = Math.max(0.05, Math.min(1, v * jitter));
      }
      const durationMs = step.durationMs ?? 400;

      if ('note' in step) {
        events.push({
          audioTime: cursorMs / 1000,
          kind: 'note',
          note: step.note,
          durationMs,
          // Stash velocity on a side channel — we resolve it in the tick.
          ...({ velocity } as any),
        });
      } else if ('chord' in step) {
        events.push({
          audioTime: cursorMs / 1000,
          kind: 'chord',
          chord: step.chord,
          durationMs,
          ...({ velocity } as any),
        });
      }

      // Legato: next step starts (duration - legato) into this one.
      const advance = Math.max(20, durationMs - legato);
      cursorMs += advance + gap;
    }

    let nextEventIdx = 0;
    let startAnchor = 0; // audio time at which the sequence started

    const tick = () => {
      const ctx = this.audioCtx;
      if (!ctx) {
        this.sequenceTimer = null;
        return;
      }
      const now = ctx.currentTime;

      // Schedule all events whose audio time falls within the look-ahead.
      // Each event uses its absolute `target` as the schedule time so the
      // audio engine plays it sample-accurately — no setTimeout jitter.
      while (nextEventIdx < events.length) {
        const ev = events[nextEventIdx];
        const target = startAnchor + ev.audioTime;
        if (target >= now + LOOKAHEAD_S) break;

        const opts: PlayOptions = {
          durationMs: ev.durationMs,
          ...(waveform !== undefined ? { waveform } : {}),
          ...({ velocity: (ev as any).velocity } as any),
        };
        if (ev.kind === 'note' && ev.note) {
          const pitch = this.parsePitch(ev.note);
          if (pitch) this.scheduleNote(pitch, ctx, target, opts);
        } else if (ev.kind === 'chord' && ev.chord) {
          // Schedule every chord voice at the SAME targetTime so the
          // chord stays tight (no smear).
          for (const n of ev.chord) {
            const pitch = this.parsePitch(n);
            if (pitch) this.scheduleNote(pitch, ctx, target, opts);
          }
        }

        nextEventIdx += 1;
      }

      // Stop ticking once everything has been scheduled.
      if (nextEventIdx >= events.length) {
        this.sequenceTimer = null;
        return;
      }
      this.sequenceTimer = setTimeout(tick, TICK_MS);
    };

    return this.ensureRunning().then(() => {
      const ctx = this.audioCtx;
      if (!ctx || steps.length === 0) return;
      // Anchor the sequence to "50 ms from now" so the very first event
      // has headroom to be scheduled in the look-ahead window without
      // firing in the past (which would be ignored).
      startAnchor = ctx.currentTime + 0.05;
      nextEventIdx = 0;
      this.sequenceStepIndex = 0;
      tick();
    });
  }

  /**
   * Aborts any currently scheduled sequence AND any pending loop
   * re-trigger. Safe to call multiple times.
   */
  stopSequence(): void {
    this.loopActive = false;
    if (this.sequenceTimer) {
      clearTimeout(this.sequenceTimer);
      this.sequenceTimer = null;
    }
    if (this.loopTimerHandle) {
      clearTimeout(this.loopTimerHandle);
      this.loopTimerHandle = null;
    }
    this.sequenceStepIndex = 0;
  }

  /**
   * Plays a pattern given as a MIDI:step string. Each token is either:
   *   - `step@midi:length` (single note), or
   *   - `step@[m1,m2,...]:length` (chord).
   *
   * Unlike `playSequence()`, this method preserves the EXPLICIT step
   * positions — so `2@75:1 2@67:2` plays D#5 and G4 simultaneously
   * from step 2 (not D#5 followed by G4). Multiple notes sharing a
   * step form chords at that moment.
   *
   * `stepMs` controls how long a step lasts in milliseconds. The default
   * (200ms) matches the piano sequencer's default of 100 BPM at 1/16.
   *
   * Returns a promise that resolves once the AudioContext is running
   * and all events have been scheduled.
   */
  async playMidiSteps(
    text: string,
    options?: SequenceOptions & {
      stepMs?: number;
      totalSteps?: number;
      loop?: boolean;
      /** Called once when the LAST event of a one-shot finishes. In
       * loop mode this is NOT called for the initial pass (only on
       * each cycle's end before re-triggering, which is rarely what
       * you want). Use it to reset UI state ("playing" highlights,
       * etc) after a non-looping preset finishes. */
      onEnd?: () => void;
    },
  ): Promise<void> {
    const ctx = await this.ensureRunning();
    if (!ctx || !this.masterGain) return;
    this.stopSequence();
    if (!text?.trim()) return;

    const msStepMs = options?.stepMs ?? 200;
    const msTotalSteps = options?.totalSteps ?? Infinity;
    const msWaveform = options?.waveform;
    const msVelocityHumanize = options?.velocityHumanize ?? 0.12;
    const msLoop = options?.loop ?? false;

    const stepMs = options?.stepMs ?? 200;
    const totalSteps = options?.totalSteps ?? Infinity;
    const waveform = options?.waveform;
    const velocityHumanize = options?.velocityHumanize ?? 0.12;

    // Parse tokens into { startStep, midis[], lengthSteps }.
    interface Event {
      startStep: number;
      midis: number[];
      lengthSteps: number;
    }

    const explicitNoteRegex = /^(\d{1,3})@(\d{1,3}):(\d{1,3})$/;
    const explicitChordRegex = /^(\d{1,3})@\[([^\]]+)\]:(\d{1,3})$/;
    const seqNoteRegex = /^(\d{1,3}):(\d{1,3})$/;
    const seqChordRegex = /^\[([^\]]+)\]:(\d{1,3})$/;

    const tokens = text
      .replace(/[\n,;]/g, ' ')
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean);

    const events: Event[] = [];
    let cursorStep = 0;

    for (const tok of tokens) {
      const expChord = explicitChordRegex.exec(tok);
      if (expChord) {
        const start = parseInt(expChord[1], 10);
        const length = parseInt(expChord[3], 10);
        if (!Number.isFinite(start) || !length) continue;
        const midis = expChord[2]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => parseInt(s, 10))
          .filter((n) => Number.isFinite(n) && n >= 0 && n <= 127);
        if (midis.length) {
          events.push({ startStep: start, midis, lengthSteps: length });
        }
        continue;
      }
      const expNote = explicitNoteRegex.exec(tok);
      if (expNote) {
        const start = parseInt(expNote[1], 10);
        const midi = parseInt(expNote[2], 10);
        const length = parseInt(expNote[3], 10);
        if (!Number.isFinite(start) || !length) continue;
        events.push({ startStep: start, midis: [midi], lengthSteps: length });
        continue;
      }
      const seqChord = seqChordRegex.exec(tok);
      if (seqChord) {
        const length = parseInt(seqChord[2], 10);
        if (!length) continue;
        const midis = seqChord[1]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => parseInt(s, 10))
          .filter((n) => Number.isFinite(n) && n >= 0 && n <= 127);
        if (midis.length) {
          events.push({
            startStep: cursorStep,
            midis,
            lengthSteps: length,
          });
          cursorStep += Math.max(1, length);
        }
        continue;
      }
      const seqNote = seqNoteRegex.exec(tok);
      if (seqNote) {
        const midi = parseInt(seqNote[1], 10);
        const length = parseInt(seqNote[2], 10);
        if (!length) continue;
        events.push({
          startStep: cursorStep,
          midis: [midi],
          lengthSteps: length,
        });
        cursorStep += Math.max(1, length);
      }
    }

    if (!events.length) return;

    // Compute the absolute audio time for each event.
    const LOOKAHEAD_S = 0.15;
    const TICK_MS = 25;
    const startAnchor = ctx.currentTime + 0.05;

    let nextEventIdx = 0;
    let scheduled = 0;

    const tick = () => {
      if (!this.audioCtx) {
        this.sequenceTimer = null;
        return;
      }
      const now = this.audioCtx.currentTime;
      while (nextEventIdx < events.length) {
        const ev = events[nextEventIdx];
        const target = startAnchor + (ev.startStep * msStepMs) / 1000;
        if (target >= now + LOOKAHEAD_S) break;

        const delayMs = Math.max(0, (target - now) * 1000);
        const noteDurMs = Math.max(50, ev.lengthSteps * msStepMs);
        const optsBase: PlayOptions = { durationMs: noteDurMs };
        if (msWaveform !== undefined) optsBase.waveform = msWaveform;
        // Velocity humanization per event.
        if (msVelocityHumanize > 0) {
          const jitter = 1 + (Math.random() * 2 - 1) * msVelocityHumanize;
          optsBase.velocity = Math.max(0.05, Math.min(1, 0.7 * jitter));
        }

        setTimeout(() => {
          for (const midi of ev.midis) {
            const pitch = this.midiToPitchInternal(midi);
            if (!pitch) continue;
            this.scheduleNote(pitch, this.audioCtx!, target, optsBase);
          }
        }, delayMs);

        scheduled += 1;
        nextEventIdx += 1;
      }
      if (nextEventIdx >= events.length) {
        this.sequenceTimer = null;
        return;
      }
      this.sequenceTimer = setTimeout(tick, TICK_MS);
    };

    tick();

    // Compute when the last note finishes so we can fire onEnd exactly
    // once for non-looping playback.
    const lastStep = events.length
      ? Math.max(...events.map((e) => e.startStep + e.lengthSteps))
      : 0;
    const totalMs = lastStep * msStepMs;

    if (msLoop && events.length) {
      // Loop mode: re-trigger after one full cycle. The recursion is
      // gated by `loopActive`: stopSequence() flips it to false so
      // any in-flight re-trigger bails out.
      this.loopActive = true;
      const loopGapMs = msStepMs;
      const loopTotalMs = lastStep * msStepMs + loopGapMs;
      this.loopTimerHandle = setTimeout(() => {
        if (!this.loopActive) return;
        this.playMidiSteps(text, { ...options, loop: true });
      }, loopTotalMs);
    } else if (options?.onEnd && events.length) {
      // One-shot: fire onEnd after the last note's duration elapses,
      // including the audio engine's release tail (~240ms).
      const releaseTailMs = 240;
      setTimeout(() => options.onEnd?.(), totalMs + releaseTailMs);
    }
    void msTotalSteps;
  }

  /**
   * Internal MIDI-to-Pitch helper used by playMidiSteps. Doesn't expose
   * the FULL midiToPitch semantics to the public API to avoid coupling
   * with external parsers.
   */
  private midiToPitchInternal(midi: number): Pitch | null {
    if (!Number.isFinite(midi) || midi < 0 || midi > 127) return null;
    const NOTE_INDEX: Record<NoteName, number> = {
      C: 0,
      'C#': 1,
      D: 2,
      'D#': 3,
      E: 4,
      F: 5,
      'F#': 6,
      G: 7,
      'G#': 8,
      A: 9,
      'A#': 10,
      B: 11,
    };
    const idx = midi % 12;
    const octave = Math.floor(midi / 12) - 1;
    const entry = Object.entries(NOTE_INDEX).find(([, v]) => v === idx);
    if (!entry) return null;
    return { note: entry[0] as NoteName, octave };
  }

  /**
   * Returns the 12 semitone names for a given octave, useful for UI rendering.
   */
  static semitones(): NoteName[] {
    return [
      'C',
      'C#',
      'D',
      'D#',
      'E',
      'F',
      'F#',
      'G',
      'G#',
      'A',
      'A#',
      'B',
    ];
  }
}
