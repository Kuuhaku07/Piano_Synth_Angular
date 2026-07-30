import {
  ChangeDetectorRef,
  Component,
  HostListener,
  OnDestroy,
  OnInit,
  ViewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  PianoSoundService,
  NoteName,
  Pitch,
  VoiceName,
  Harmonic,
} from '../../services/piano-sound.service';
import {
  CachedSequence,
  SequenceCacheService,
} from '../../services/sequence-cache.service';
import { PianoPresetsService } from '../../services/piano-presets';
import { PianoSequencerComponent } from './lib-sequencer/piano-sequencer.component';

interface PianoKey {
  pitch: Pitch;
  label: string;
  isBlack: boolean;
  /** Computer keyboard shortcut (only on the lower octave). */
  hotkey?: string;
}

interface PianoSlot {
  /** The white key of this slot (always present). */
  white: PianoKey;
  /** The black key that sits on the right edge of this white slot, if any. */
  black?: PianoKey;
}

/**
 * Lower-octave hotkeys. White keys live on the physical home rows of two
 * octaves so every white key has a unique, non-overlapping binding:
 *  - Octave 4 → Z X C V B N M  (bottom row)
 *  - Octave 5 → A S D F G H J  (home row)
 * Black keys live on the row above:
 *  - Q W (E R) T Y U (I)
 * The order MUST match the order of white keys rendered for each octave.
 */
const HOTKEYS_WHITE: { key: string; note: NoteName; octaveOffset: number }[] =
  [
    { key: 'z', note: 'C', octaveOffset: 0 },
    { key: 'x', note: 'D', octaveOffset: 0 },
    { key: 'c', note: 'E', octaveOffset: 0 },
    { key: 'v', note: 'F', octaveOffset: 0 },
    { key: 'b', note: 'G', octaveOffset: 0 },
    { key: 'n', note: 'A', octaveOffset: 0 },
    { key: 'm', note: 'B', octaveOffset: 0 },
    { key: 'a', note: 'C', octaveOffset: 1 },
    { key: 's', note: 'D', octaveOffset: 1 },
    { key: 'd', note: 'E', octaveOffset: 1 },
    { key: 'f', note: 'F', octaveOffset: 1 },
    { key: 'g', note: 'G', octaveOffset: 1 },
    { key: 'h', note: 'A', octaveOffset: 1 },
    { key: 'j', note: 'B', octaveOffset: 1 },
  ];
const HOTKEYS_BLACK: { key: string; note: NoteName; octaveOffset: number }[] =
  [
    { key: 'q', note: 'C#', octaveOffset: 0 },
    { key: 'w', note: 'D#', octaveOffset: 0 },
    { key: 'r', note: 'F#', octaveOffset: 0 },
    { key: 't', note: 'G#', octaveOffset: 0 },
    { key: 'y', note: 'A#', octaveOffset: 0 },
    { key: 'u', note: 'C#', octaveOffset: 1 },
    { key: 'i', note: 'D#', octaveOffset: 1 },
  ];

const WHITE_SEMITONES: NoteName[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const BLACK_AFTER: Record<NoteName, NoteName | null> = {
  C: 'C#',
  D: 'D#',
  E: null,
  F: 'F#',
  G: 'G#',
  A: 'A#',
  B: null,
  'C#': null,
  'D#': null,
  'F#': null,
  'G#': null,
  'A#': null,
};

const HOTKEY_BY_NOTE_OCTAVE: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const h of HOTKEYS_WHITE) map[`${h.note}|${h.octaveOffset}`] = h.key;
  for (const h of HOTKEYS_BLACK) map[`${h.note}|${h.octaveOffset}`] = h.key;
  return map;
})();

@Component({
  selector: 'lib-piano-page',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    PianoSequencerComponent,
  ],
  templateUrl: './piano-page.component.html',
  styleUrl: './piano-page.component.scss',
})
export class PianoPageComponent implements OnInit, OnDestroy {
  /** Number of octaves rendered on screen. */
  public readonly octaveCount = 2;
  /** Lowest octave shown (C of this octave is the leftmost key). */
  public baseOctave = 4;
  public readonly minOctave = 1;
  public readonly maxOctave = 7;

  public volume = 25;
  public waveform: OscillatorType | VoiceName = 'softPad';

  /** Each white key + its (optional) right-edge black key. */
  public keySlots: PianoSlot[] = [];

  public activeKeys = new Set<string>();

  /** User-saved sequences (from localStorage). */
  public cachedSequences: CachedSequence[] = [];
  /** Working buffer for the textarea in the cache form. */
  public sequenceInputText = '';
  /** Optional name for the sequence being saved. */
  public sequenceInputName = '';
  /** Last validation error message (shown under the textarea). */
  public sequenceInputError = '';
  /** ID of the cached sequence currently playing (highlight). */
  public playingCachedId: string | null = null;

  public presetKeys: string[] = [];

  /** Loop state per preset key. When true, the preset keeps re-playing
   * until the user toggles it off or stops everything. */
  public loopingPresets = new Set<string>();
  /** Which preset is currently playing (or queued via loop). Used to
   * illuminate the active card. Only one preset plays at a time. */
  public playingPreset: string | null = null;

  /** Human label for each preset, derived from its key. */
  public presetLabels: Record<string, string> = {
    success: 'Éxito',
    gentle: 'Suave',
    flow: 'Flujo',
    alert: 'Atención',
    bounce: 'Rebote',
    chime: 'Campana',
    test: 'Test 1',
    test2: 'Test 2',
  };

  @ViewChild(PianoSequencerComponent)
  private sequencer!: PianoSequencerComponent;

  public waveformOptions: (OscillatorType | VoiceName)[] = [
    // Soft / mellow first
    'glass',
    'marimba',
    'musicBox',
    'softPiano',
    'softPad',
    'sine',
    'triangle',
    'pad',
    // Character voices
    'piano',
    'bell',
    'organ',
    'pluck',
    'lead',
    'bass',
    'square',
    'sawtooth',
  ];

  /**
   * SVG path string for the waveform preview, sampled across 1 full cycle
   * (96px wide, 40px tall, centered on y=20). For composite voices we draw
   * a simplified harmonic-spectrum bar instead of an oscillator shape, since
   * those voices are mixes of several oscillators.
   */
  public waveformPath(w: OscillatorType | VoiceName): string {
    const compositeRecipes: Record<string, Harmonic[]> = {
      glass: [
        { mult: 1, gain: 1, type: 'sine' },
        { mult: 3.01, gain: 0.18, type: 'sine' },
        { mult: 5.99, gain: 0.06, type: 'sine' },
      ],
      marimba: [
        { mult: 1, gain: 1, type: 'triangle' },
        { mult: 4, gain: 0.32, type: 'sine' },
      ],
      musicBox: [
        { mult: 1, gain: 0.9, type: 'triangle' },
        { mult: 2, gain: 0.35, type: 'sine' },
        { mult: 3.01, gain: 0.18, type: 'sine' },
        { mult: 5.98, gain: 0.08, type: 'sine' },
      ],
      softPiano: [
        { mult: 1, gain: 1, type: 'sine' },
        { mult: 2, gain: 0.18, type: 'triangle' },
        { mult: 3, gain: 0.05, type: 'sine' },
      ],
      softPad: [
        { mult: 1, gain: 0.6, type: 'sine' },
        { mult: 2, gain: 0.1, type: 'sine' },
      ],
      piano: [
        { mult: 1, gain: 1, type: 'sine' },
        { mult: 2, gain: 0.45, type: 'triangle' },
        { mult: 3, gain: 0.18, type: 'sine' },
        { mult: 4, gain: 0.08, type: 'sine' },
      ],
      organ: [
        { mult: 1, gain: 0.55, type: 'sine' },
        { mult: 2, gain: 0.4, type: 'sine' },
        { mult: 3, gain: 0.3, type: 'sine' },
        { mult: 4, gain: 0.18, type: 'sine' },
        { mult: 6, gain: 0.1, type: 'sine' },
        { mult: 8, gain: 0.06, type: 'sine' },
      ],
      lead: [
        { mult: 1, gain: 0.45, type: 'sawtooth' },
        { mult: 2, gain: 0.2, type: 'sawtooth' },
      ],
      bass: [
        { mult: 1, gain: 1, type: 'sine' },
        { mult: 2, gain: 0.15, type: 'triangle' },
      ],
      bell: [
        { mult: 1, gain: 0.7, type: 'sine' },
        { mult: 2.76, gain: 0.5, type: 'sine' },
        { mult: 5.4, gain: 0.25, type: 'sine' },
        { mult: 8.93, gain: 0.12, type: 'sine' },
      ],
      pad: [
        { mult: 1, gain: 0.55, type: 'sine' },
        { mult: 2, gain: 0.2, type: 'sine' },
        { mult: 3, gain: 0.1, type: 'triangle' },
      ],
      pluck: [
        { mult: 1, gain: 1, type: 'triangle' },
        { mult: 2, gain: 0.35, type: 'triangle' },
        { mult: 3, gain: 0.12, type: 'triangle' },
      ],
    };

    // Composite voice → harmonic-spectrum view (vertical bars centered).
    if (compositeRecipes[w]) {
      const rec = compositeRecipes[w];
      const maxMult = Math.max(...rec.map((r) => r.mult));
      const barCount = rec.length;
      const gap = 2;
      const totalW = 92; // leave a small margin
      const barW = (totalW - gap * (barCount - 1)) / barCount;
      let path = '';
      rec.forEach((h, i) => {
        const x = 2 + i * (barW + gap);
        const hPx = Math.max(2, h.gain * 16);
        const yTop = 20 - hPx;
        const yBot = 20 + hPx;
        path += `M${x.toFixed(1)} ${yBot.toFixed(1)} L${x.toFixed(1)} ${yTop.toFixed(1)} `;
        void maxMult;
      });
      return path.trim();
    }

    // Raw oscillator shape — sample one full period across 96 px.
    const samples = 48;
    const w2 = 96;
    const amp = 16;
    const pts: [number, number][] = [];
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const x = t * w2;
      const phase = t * 2 * Math.PI;
      let y = 0;
      switch (w) {
        case 'sine':
          y = Math.sin(phase);
          break;
        case 'triangle':
          y = (2 / Math.PI) * Math.asin(Math.sin(phase));
          break;
        case 'square':
          y = Math.sin(phase) >= 0 ? 1 : -1;
          break;
        case 'sawtooth':
          y = 2 * (t - Math.floor(t + 0.5));
          break;
      }
      pts.push([x, 20 - y * amp]);
    }
    return pts
      .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`)
      .join(' ');
  }

  constructor(
    private piano: PianoSoundService,
    private cdr: ChangeDetectorRef,
    private sequenceCache: SequenceCacheService,
    private presetsSvc: PianoPresetsService,
  ) {
    this.cachedSequences = this.sequenceCache.list();
  }

  async ngOnInit(): Promise<void> {
    this.rebuildSlots();
    this.piano.setVolume(this.volume / 100);
    this.piano.setWaveform(this.waveform);
    // Carga presets desde assets/piano-presets.json (si existe) +
    // defaults de la lib. No requiere recompilar la librería para
    // agregar presets nuevos: basta con editar el JSON del consumidor.
    await this.presetsSvc.loadAll();
    this.presetKeys = this.presetsSvc.keys();
    this.cdr.markForCheck();
  }

  ngOnDestroy(): void {
    this.piano.stopAll();
    this.piano.stopSequence();
  }

  /**
   * Rebuilds the rendered keyboard based on the current baseOctave.
   * Hotkeys are assigned to both octaves (octaveOffset 0 = baseOctave,
   * octaveOffset 1 = baseOctave + 1).
   */
  public rebuildSlots(): void {
    const slots: PianoSlot[] = [];
    for (let o = 0; o < this.octaveCount; o++) {
      const octave = this.baseOctave + o;
      for (const w of WHITE_SEMITONES) {
        const whiteKey: PianoKey = {
          pitch: { note: w, octave },
          label: `${w}${octave}`,
          isBlack: false,
        };
        const whiteHk = HOTKEY_BY_NOTE_OCTAVE[`${w}|${o}`];
        if (whiteHk) whiteKey.hotkey = whiteHk;
        const slot: PianoSlot = { white: whiteKey };

        const blackNote = BLACK_AFTER[w];
        if (blackNote) {
          const blackKey: PianoKey = {
            pitch: { note: blackNote, octave },
            label: `${blackNote}${octave}`,
            isBlack: true,
          };
          const blackHk = HOTKEY_BY_NOTE_OCTAVE[`${blackNote}|${o}`];
          if (blackHk) blackKey.hotkey = blackHk;
          slot.black = blackKey;
        }
        slots.push(slot);
      }
    }
    this.keySlots = slots;
    this.activeKeys.clear();
  }

  public shiftOctave(delta: number): void {
    const next = this.baseOctave + delta;
    if (next < this.minOctave || next > this.maxOctave) return;
    this.baseOctave = next;
    this.rebuildSlots();
  }

  public onVolumeChange(): void {
    this.piano.setVolume(this.volume / 100);
  }

  public onWaveformChange(): void {
    this.piano.setWaveform(this.waveform);
  }

  public pressKey(key: PianoKey): void {
    const label = `${key.pitch.note}${key.pitch.octave}`;
    this.piano.playNote(key.pitch, { waveform: this.waveform });
    this.activeKeys.add(label);
  }

  public releaseKey(key: PianoKey): void {
    const label = `${key.pitch.note}${key.pitch.octave}`;
    this.activeKeys.delete(label);
    this.piano.stopNote(key.pitch);
  }

  public isActive(key: PianoKey): boolean {
    return this.activeKeys.has(`${key.pitch.note}${key.pitch.octave}`);
  }

  /**
   * Click handler on a preset card. Toggles playback:
   *  - If this preset is already playing → stop everything.
   *  - Otherwise → stop everything else and play this one (looping
   *    if the loop switch is on).
   */
  public playPreset(key: string): void {
    const text = this.presetsSvc.get(key);
    if (!text) return;
    if (this.playingPreset === key) {
      this.stopEverything();
      return;
    }
    this.stopEverything();
    this.playingPreset = key;
    const shouldLoop = this.loopingPresets.has(key);
    this.piano.playMidiSteps(text, {
      waveform: this.waveform,
      loop: shouldLoop,
      // Only clear the playing indicator when the pattern finishes
      // naturally — looping presets keep it on until the user stops
      // them. `key` is captured by closure so the callback knows
      // which preset ended.
      onEnd: shouldLoop
        ? undefined
        : () => {
            if (this.playingPreset === key) {
              this.playingPreset = null;
              this.cdr.markForCheck();
            }
          },
    });
    this.cdr.markForCheck();
  }

  /**
   * Click handler on the loop switch. Toggles whether this preset
   * should loop on next play. Does NOT start/stop playback.
   */
  public togglePresetLoop(key: string): void {
    if (this.loopingPresets.has(key)) {
      this.loopingPresets.delete(key);
    } else {
      this.loopingPresets.add(key);
    }
    this.cdr.markForCheck();
  }

  public isPresetLooping(key: string): boolean {
    return this.loopingPresets.has(key);
  }

  public isPresetPlaying(key: string): boolean {
    return this.playingPreset === key;
  }

  /**
   * Returns the class list for a preset card. Active cards (currently
   * playing) get an emerald tint and ring; looping-but-not-playing cards
   * get just the ring; idle cards get the default slate look.
   */
  public presetCardClasses(key: string): Record<string, boolean> {
    const playing = this.isPresetPlaying(key);
    const looping = this.isPresetLooping(key);
    return {
      'bg-slate-800/80': !playing,
      'bg-emerald-500/20': playing,
      'border-slate-700': !playing && !looping,
      'border-emerald-400': playing || looping,
      'ring-2': playing || looping,
      'ring-emerald-400': playing || looping,
    };
  }

  public stopEverything(): void {
    this.piano.stopAll();
    this.piano.stopSequence();
    this.activeKeys.clear();
    this.playingCachedId = null;
    this.playingPreset = null;
    this.cdr.markForCheck();
  }

  // === Cached sequences (localStorage-backed) ===

  public onSequenceInputChange(): void {
    this.sequenceInputError = '';
  }

  public saveSequence(): void {
    const added = this.sequenceCache.add(
      this.sequenceInputText,
      this.sequenceInputName,
    );
    if (!added) {
      this.sequenceInputError =
        'Formato inválido. Usá "step@midi:length" (ej. "0@60:2 4@64:4") o "midi:length" (ej. "60:2 64:4").';
      this.cdr.markForCheck();
      return;
    }
    this.cachedSequences = this.sequenceCache.list();
    this.sequenceInputText = '';
    this.sequenceInputName = '';
    this.sequenceInputError = '';
    this.cdr.markForCheck();
  }

  public removeSequence(id: string): void {
    this.sequenceCache.remove(id);
    if (this.playingCachedId === id) {
      this.stopEverything();
    }
    this.cachedSequences = this.sequenceCache.list();
    this.cdr.markForCheck();
  }

  /** Pre-fill the cache input with whatever is currently in the sequencer. */
  public captureFromSequencer(): void {
    if (!this.sequencer) return;
    this.sequenceInputText = this.sequencer.gridAsText();
    this.sequenceInputName = '';
    this.sequenceInputError = '';
    this.cdr.markForCheck();
  }

  /** Replace the sequencer grid with the given cached sequence (for editing). */
  public loadIntoSequencer(item: CachedSequence): void {
    if (!this.sequencer) return;
    this.sequencer.loadFromText(item.text);
    this.sequenceInputText = item.text;
    this.sequenceInputName = item.name;
    this.sequenceInputError = '';
    this.cdr.markForCheck();
  }

  public playCachedSequence(item: CachedSequence): void {
    if (this.playingCachedId === item.id) {
      this.stopEverything();
      return;
    }
    this.stopEverything();
    this.playingCachedId = item.id;
    this.piano.playMidiSteps(item.text, {
      waveform: this.waveform,
      loop: false,
      onEnd: () => {
        if (this.playingCachedId === item.id) {
          this.playingCachedId = null;
          this.cdr.markForCheck();
        }
      },
    });
    this.cdr.markForCheck();
  }

  public isCachedPlaying(id: string): boolean {
    return this.playingCachedId === id;
  }

  /**
   * Maps a physical keyboard key to a (note, octaveOffset) pair, or null
   * if the key isn't bound.
   */
  private keyToBinding(
    k: string,
  ): { note: NoteName; octaveOffset: number } | null {
    const w = HOTKEYS_WHITE.find((h) => h.key === k);
    if (w) return { note: w.note, octaveOffset: w.octaveOffset };
    const b = HOTKEYS_BLACK.find((h) => h.key === k);
    if (b) return { note: b.note, octaveOffset: b.octaveOffset };
    return null;
  }

  /**
   * Global keyboard listener — turns the computer keyboard into a virtual
   * piano using the two-octave hotkey mapping.
   */
  @HostListener('window:keydown', ['$event'])
  public onKeyDown(event: KeyboardEvent): void {
    if (event.repeat || event.ctrlKey || event.altKey || event.metaKey) {
      return;
    }
    const k = event.key.toLowerCase();
    const target = document.activeElement as HTMLElement | null;
    if (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable)
    ) {
      return;
    }

    if (k === 'arrowleft' || k === 'arrowright') {
      event.preventDefault();
      this.shiftOctave(k === 'arrowleft' ? -1 : 1);
      return;
    }

    const binding = this.keyToBinding(k);
    if (!binding) return;

    event.preventDefault();
    const octave = this.baseOctave + binding.octaveOffset;
    const pitch: Pitch = { note: binding.note, octave };
    this.piano.playNote(pitch, { waveform: this.waveform });
    this.activeKeys.add(`${binding.note}${octave}`);
  }

  @HostListener('window:keyup', ['$event'])
  public onKeyUp(event: KeyboardEvent): void {
    const k = event.key.toLowerCase();
    const binding = this.keyToBinding(k);
    if (!binding) return;
    const octave = this.baseOctave + binding.octaveOffset;
    this.activeKeys.delete(`${binding.note}${octave}`);
    this.piano.stopNote({ note: binding.note, octave });
  }
}
