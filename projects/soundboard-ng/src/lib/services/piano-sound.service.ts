import { Injectable } from '@angular/core';
import {
  midiToPitch,
  NOTE_INDEX,
  parsePitch,
  type NoteName,
  type Pitch,
} from './music-theory';
import { parseMidiStepTokens } from './midi-step-parser';

export type { NoteName, Pitch } from './music-theory';

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
    return parsePitch(input);
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
      velocity: number;
    }

    const events: ScheduledEvent[] = [];
    let cursorMs = 0;
    let prevCursorMs = 0;

    for (const step of steps) {
      // Apply timing humanization to each step's wait (delta from the
      // previous step), not to the absolute cursor — perturbing the
      // absolute cursor would let a jitter push earlier events into
      // the past and cause overlap. We add the jittered delta to the
      // running cursor instead.
      if (humanize > 0 && events.length > 0) {
        const delta = cursorMs - prevCursorMs;
        const jitter = 1 + (Math.random() * 2 - 1) * humanize;
        const jitteredDelta = Math.max(0, delta * jitter);
        prevCursorMs = cursorMs;
        cursorMs = cursorMs - delta + jitteredDelta;
      } else {
        prevCursorMs = cursorMs;
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
          velocity,
        });
      } else if ('chord' in step) {
        events.push({
          audioTime: cursorMs / 1000,
          kind: 'chord',
          chord: step.chord,
          durationMs,
          velocity,
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
          velocity: ev.velocity,
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

    const parsed = parseMidiStepTokens(text);
    if (!parsed.length) return;

    const stepMs = options?.stepMs ?? 200;
    const waveform = options?.waveform;
    const velocityHumanize = options?.velocityHumanize ?? 0.12;
    const loop = options?.loop ?? false;

    const LOOKAHEAD_S = 0.15;
    const TICK_MS = 25;

    // Compute the total length of one cycle (in ms) — used both to
    // schedule the loop re-trigger and to fire `onEnd` for one-shots.
    const lastStep = Math.max(
      ...parsed.map((e) => e.startStep + e.lengthSteps),
    );
    const cycleMs = lastStep * stepMs;

    /**
     * Drives one cycle. Each cycle anchors itself 50 ms in the future
     * (the look-ahead window) so events scheduled at audio time `t`
     * always have headroom. Looping cycles re-call this function with
     * the same options so the user can keep the same waveform / loop
     * behavior alive across passes.
     */
    const runCycle = (): { totalMs: number } => {
      const startAnchor = ctx.currentTime + 0.05;
      let nextEventIdx = 0;

      const tick = () => {
        if (!this.audioCtx) {
          this.sequenceTimer = null;
          return;
        }
        const now = this.audioCtx.currentTime;
        while (nextEventIdx < parsed.length) {
          const ev = parsed[nextEventIdx];
          const target = startAnchor + (ev.startStep * stepMs) / 1000;
          if (target >= now + LOOKAHEAD_S) break;

          const delayMs = Math.max(0, (target - now) * 1000);
          const noteDurMs = Math.max(50, ev.lengthSteps * stepMs);
          const optsBase: PlayOptions = { durationMs: noteDurMs };
          if (waveform !== undefined) optsBase.waveform = waveform;
          // Velocity humanization per event.
          if (velocityHumanize > 0) {
            const jitter = 1 + (Math.random() * 2 - 1) * velocityHumanize;
            optsBase.velocity = Math.max(0.05, Math.min(1, 0.7 * jitter));
          }

          setTimeout(() => {
            if (!this.audioCtx) return;
            for (const midi of ev.midis) {
              const pitch = midiToPitch(midi);
              if (!pitch) continue;
              this.scheduleNote(pitch, this.audioCtx, target, optsBase);
            }
          }, delayMs);

          nextEventIdx += 1;
        }
        if (nextEventIdx >= parsed.length) {
          this.sequenceTimer = null;
          return;
        }
        this.sequenceTimer = setTimeout(tick, TICK_MS);
      };

      tick();
      return { totalMs: cycleMs };
    };

    const { totalMs } = runCycle();

    if (loop && parsed.length) {
      // Loop mode: schedule the next cycle to start when this one ends
      // (plus a tiny gap so the last note's release isn't cut off). The
      // recursion is gated by `loopActive` so stopSequence() can bail
      // out cleanly even if a re-trigger is in flight.
      this.loopActive = true;
      const releaseTailMs = 240;
      this.loopTimerHandle = setTimeout(() => {
        if (!this.loopActive) return;
        // Re-run on the same AudioContext (no recursion through
        // playMidiSteps, so we avoid the +50 ms anchor accumulating
        // into audible gaps on every cycle).
        runCycle();
        // Reschedule the next re-trigger. We chain setTimeouts of the
        // same duration so drift is bounded by ~1 ms per cycle.
        this.loopTimerHandle = setTimeout(
          () => {
            if (!this.loopActive) return;
            runCycle();
          },
          totalMs + releaseTailMs,
        );
      }, totalMs);
    } else if (options?.onEnd) {
      // One-shot: fire onEnd after the last note's duration elapses,
      // including the audio engine's release tail (~240ms).
      const releaseTailMs = 240;
      setTimeout(() => options.onEnd?.(), totalMs + releaseTailMs);
    }
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