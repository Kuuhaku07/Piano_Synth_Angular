import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  EventEmitter,
  HostListener,
  Input,
  OnDestroy,
  OnInit,
  Output,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  PianoSoundService,
  NoteName,
  Pitch,
  VoiceName,
} from '../../../services/piano-sound.service';
import { SequenceStep } from '../../../services/piano-sound.service';

export type Quantization = '1/4' | '1/8' | '1/16';

interface Block {
  /** Step index where the note starts (0..steps-1). */
  start: number;
  /** Number of steps the note lasts (1..steps-start). */
  length: number;
}

/**
 * Grid keyed by `${note}|${octave}` — each value is an ARRAY of blocks
 * because the same note can appear at multiple steps in the pattern.
 * The array is kept sorted by `start` so iteration is deterministic.
 */
type Grid = Record<string, Block[]>;

// ---- MIDI helpers ----------------------------------------------------
// MIDI note numbers are the universal standard for representing pitches.
// Convention: A4 = 69 = 440Hz. We use them in the export format so the
// output is interoperable with any music software.

// Indices into the chromatic scale, with C as the root.
const MIDI_PITCH_INDEX: Record<NoteName, number> = {
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

function pitchToMidi(p: Pitch | null): number | null {
  if (!p) return null;
  // MIDI: octave * 12 + pitchIndex. A4 = 69 → (4+1)*12 + 9 = 69.
  return (p.octave + 1) * 12 + MIDI_PITCH_INDEX[p.note];
}

function midiToPitch(midi: number): Pitch | null {
  if (!Number.isFinite(midi) || midi < 0 || midi > 127) return null;
  const noteIdx = midi % 12;
  const octave = Math.floor(midi / 12) - 1;
  const entry = Object.entries(MIDI_PITCH_INDEX).find(
    ([, v]) => v === noteIdx,
  );
  if (!entry) return null;
  return { note: entry[0] as NoteName, octave };
}

/** Parses "C4", "F#5", "Bb3" into a Pitch. Returns null on failure. */
function noteStringToPitch(input: string): Pitch | null {
  const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(input.trim());
  if (!m) return null;
  const letter = m[1].toUpperCase();
  const acc = m[2];
  const octave = parseInt(m[3], 10);
  let base: NoteName;
  if (acc === '#') {
    base = (letter + '#') as NoteName;
  } else if (acc === 'b') {
    // Normalize flats to sharps for the grid keys.
    const flatToSharp: Record<string, NoteName> = {
      Db: 'C#',
      Eb: 'D#',
      Gb: 'F#',
      Ab: 'G#',
      Bb: 'A#',
    };
    base = flatToSharp[letter + 'b'];
    if (!base) return null;
  } else {
    base = letter as NoteName;
  }
  if (!(base in MIDI_PITCH_INDEX)) return null;
  return { note: base, octave };
}

@Component({
  selector: 'lib-piano-sequencer',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './piano-sequencer.component.html',
  styleUrl: './piano-sequencer.component.scss',
})
export class PianoSequencerComponent implements OnInit, OnDestroy {
  /** Voice used for all scheduled notes. */
  @Input() waveform: OscillatorType | VoiceName = 'softPad';
  /** Octave the grid starts at (the lowest row). */
  @Input() baseOctave = 4;
  /** Number of octaves to show. */
  @Input() octaveCount = 2;

  @Output() notePreview = new EventEmitter<Pitch>();

  /** Steps per loop. 16 by default. */
  public steps = 16;
  /** Beats per loop (used to compute BPM). 4 = 4/4 time, 16 sixteenths. */
  public beats = 4;
  public bpm = 100;
  public quantization: Quantization = '1/16';

  /** Grid keyed by `${note}|${octave}`; each entry is a list of blocks. */
  public grid: Grid = {};
  /** Rows: ordered top-down from highest note to lowest. */
  public rows: Array<{ note: NoteName; octave: number }> = [];

  public isPlaying = false;
  public currentStep = -1;

  /**
   * Tracks an in-progress pointer drag on the grid. Modeled after the
   * FL Studio piano roll behavior:
   *  - Pointerdown on an empty cell: create a 1-step block and remember
   *    it as `created`. If pointerup happens without movement, leave it.
   *  - Pointerdown on an existing block: remember the block as
   *    `willToggleOnTap`. If pointerup happens without movement, delete
   *    it (toggle off).
   *  - If the user moves to a different cell before releasing, we treat
   *    it as a drag: extend the block to span the dragged range, and
   *    IGNORE the `willToggleOnTap` flag (the block stays).
   *  - Drag is row-scoped: moving onto a different row mid-drag is
   *    ignored (keeps things predictable).
   */
  private drag: {
    rowKey: string;
    row: { note: NoteName; octave: number };
    anchorStep: number;
    block: Block;
    willToggleOnTap: boolean;
    hasMoved: boolean;
  } | null = null;

  /** ms per step, derived from BPM + quantization. */
  private stepMs = (60 / this.bpm) * 1000 / 4; // '1/16' default
  /** Scheduler state. */
  private nextStepTime = 0;
  private audioCtx: AudioContext | null = null;
  private rafHandle: number | null = null;
  private timerHandle: any = null;

  constructor(
    private piano: PianoSoundService,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    this.recomputeRows();
    this.recomputeStepMs();
  }

  ngOnDestroy(): void {
    this.stop();
  }

  // ---------------- Public API ----------------

  public togglePlay(): void {
    if (this.isPlaying) {
      this.stop();
    } else {
      this.start();
    }
  }

  public clear(): void {
    this.stop();
    this.grid = {};
    this.syncTextBufferFromGrid();
    this.cdr.markForCheck();
  }

  public setBpm(value: number): void {
    this.bpm = Math.max(40, Math.min(240, value));
    this.recomputeStepMs();
    this.cdr.markForCheck();
  }

  public setQuantization(q: Quantization): void {
    this.quantization = q;
    this.recomputeStepMs();
    this.cdr.markForCheck();
  }

  public getStepDurationMs(): number {
    return this.stepMs;
  }

  /**
   * Buffered text in the output textarea. Mirrors `gridAsText()` and is
   * kept in sync automatically whenever the grid mutates. The textarea
   * is bound via `[ngModel]` (one-way), so the buffer is the source of
   * truth for the visible text. Editing the textarea calls
   * `loadFromText()` which replaces the grid.
   */
  public textBuffer = '';

  /**
   * Recomputes `textBuffer` from the current grid. Called automatically
   * after any grid mutation.
   */
  private syncTextBufferFromGrid(): void {
    this.textBuffer = this.gridAsText();
  }

  public copyLabel = 'Copiar';

  public async copyToClipboard(): Promise<void> {
    const text = this.gridAsText();
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      this.copyLabel = '¡Copiado!';
      this.cdr.markForCheck();
      setTimeout(() => {
        this.copyLabel = 'Copiar';
        this.cdr.markForCheck();
      }, 1500);
    } catch {
      this.copyLabel = 'Error';
      this.cdr.markForCheck();
      setTimeout(() => {
        this.copyLabel = 'Copiar';
        this.cdr.markForCheck();
      }, 1500);
    }
  }

  public playExported(): void {
    const steps = this.gridAsSequence();
    if (!steps.length) return;
    this.piano.playSequence(steps, { waveform: this.waveform });
  }

  /**
   * Handles paste events on the output textarea. If the clipboard payload
   * contains MIDI note tokens (either `midi:length` or `step@midi:length`,
   * optionally with chords `[a,b,c]:length`), loads it into the grid and
   * suppresses the default paste so the textarea shows the freshly
   * regenerated buffer.
   */
  public onPaste(event: ClipboardEvent): void {
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (!text.trim()) return;
    // Heuristic detection: any token looking like `n:n`, `[...]:n`, or
    // `n@n:n`.
    const looksLikeMidiSteps =
      /(^|\s)\d{1,3}:\d{1,3}(\s|$)/.test(text) ||
      /(^|\s)\[[^\]]+\]:\d{1,3}(\s|$)/.test(text) ||
      /(^|\s)\d{1,3}@\d{1,3}:\d{1,3}(\s|$)/.test(text) ||
      /(^|\s)\d{1,3}@\[[^\]]+\]:\d{1,3}(\s|$)/.test(text);
    if (!looksLikeMidiSteps) return;
    event.preventDefault();
    this.loadFromText(text);
  }

  // ---------------- Grid helpers ----------------

  /**
   * Returns the block at (row, step) — i.e. the one that owns this
   * specific cell. A row can have multiple blocks; this finds the one
   * whose [start, start+length) range covers `step`.
   */
  public blockAt(
    row: { note: NoteName; octave: number },
    step: number,
  ): Block | null {
    const blocks = this.grid[this.rowKey(row)] ?? [];
    for (const b of blocks) {
      if (step >= b.start && step < b.start + b.length) return b;
    }
    return null;
  }

  /**
   * Returns the block (if any) that STARTS at `startStep` in this row —
   * used by the drag handler to know which block to extend.
   */
  public blockStartingAt(
    row: { note: NoteName; octave: number },
    startStep: number,
  ): Block | null {
    const blocks = this.grid[this.rowKey(row)] ?? [];
    return blocks.find((b) => b.start === startStep) ?? null;
  }

  /**
   * Pointer-down on a cell. Starts a tentative paint:
   *  - Empty cell: create a 1-step block; willToggleOnTap = false (we
   *    want to KEEP the block on release — it's a new note).
   *  - Cell with a block: remember the existing block; willToggleOnTap
   *    = true (we want to DELETE it on release unless the user drags).
   *
   * The decision between "tap" and "drag" is deferred to pointerup —
   * see endDrag().
   */
  public onPointerDown(
    row: { note: NoteName; octave: number },
    step: number,
    event: PointerEvent,
  ): void {
    if (event.button !== 0) return;
    const key = this.rowKey(row);
    const existing = this.blockAt(row, step);

    if (existing) {
      this.drag = {
        rowKey: key,
        row,
        anchorStep: step,
        block: existing,
        willToggleOnTap: true,
        hasMoved: false,
      };
    } else {
      // Create a 1-step block right now. It stays unless the user starts
      // dragging onto it weirdly — but `onPointerEnter` only extends
      // blocks whose anchor matches, so a fresh block from pointerdown
      // is safe to keep.
      const blocks = this.grid[key] ?? [];
      const newBlock: Block = { start: step, length: 1 };
      this.grid[key] = [...blocks, newBlock].sort(
        (a, b) => a.start - b.start,
      );
      this.drag = {
        rowKey: key,
        row,
        anchorStep: step,
        block: newBlock,
        willToggleOnTap: false,
        hasMoved: false,
      };
      this.piano.playNote(
        { note: row.note, octave: row.octave },
        { waveform: this.waveform, durationMs: 250 },
      );
    }
    this.syncTextBufferFromGrid();
    this.cdr.markForCheck();
  }

  /**
   * Pointer enters a cell while a drag is in progress. Same-row only.
   * Extends the block to span from `anchorStep` to the current step.
   * Marking hasMoved makes the eventual tap-toggle a no-op.
   */
  public onPointerEnter(
    row: { note: NoteName; octave: number },
    step: number,
  ): void {
    if (!this.drag) return;
    if (this.rowKey(row) !== this.drag.rowKey) return;
    if (step === this.drag.anchorStep) return;
    this.drag.hasMoved = true;
    const start = this.drag.anchorStep;
    const lo = Math.min(start, step);
    const hi = Math.max(start, step);
    const length = Math.min(this.steps - lo, hi - lo + 1);
    if (this.drag.block.length !== length) {
      this.drag.block.length = length;
      this.syncTextBufferFromGrid();
      this.cdr.markForCheck();
    }
  }

  /**
   * Pointerup anywhere. Decides tap vs drag using the drag state.
   */
  @HostListener('window:pointerup')
  public endDrag(): void {
    if (!this.drag) return;
    if (!this.drag.hasMoved && this.drag.willToggleOnTap) {
      // Tap on a pre-existing block → delete it.
      const key = this.drag.rowKey;
      const blocks = (this.grid[key] ?? []).filter(
        (b) => b !== this.drag!.block,
      );
      if (blocks.length === 0) {
        delete this.grid[key];
      } else {
        this.grid[key] = blocks;
      }
    }
    // Otherwise: leave the block alone (tap on empty = keep new block,
    // drag = keep resized block).
    this.drag = null;
    this.syncTextBufferFromGrid();
    this.cdr.markForCheck();
  }

  @HostListener('window:pointercancel')
  public cancelDrag(): void {
    this.drag = null;
  }

  private rowKey(row: { note: NoteName; octave: number }): string {
    return `${row.note}|${row.octave}`;
  }

  private recomputeRows(): void {
    const list: Array<{ note: NoteName; octave: number }> = [];
    const semitones: NoteName[] = [
      'B',
      'A#',
      'A',
      'G#',
      'G',
      'F#',
      'F',
      'E',
      'D#',
      'D',
      'C#',
      'C',
    ];
    for (let o = this.octaveCount - 1; o >= 0; o--) {
      const octave = this.baseOctave + o;
      for (const s of semitones) {
        list.push({ note: s, octave });
      }
    }
    this.rows = list;
  }

  private recomputeStepMs(): void {
    const quarterMs = (60 / this.bpm) * 1000;
    let div = 4;
    if (this.quantization === '1/4') div = 1;
    else if (this.quantization === '1/8') div = 2;
    else if (this.quantization === '1/16') div = 4;
    this.stepMs = quarterMs / div;
  }

  // ---------------- Export ----------------

  /**
   * Exports the current grid as an array of SequenceStep ready to be
   * passed to PianoSoundService.playSequence(). Each block becomes one
   * step (or a chord step if multiple rows have a block at the same
   * start time).
   */
  public gridAsSequence(): SequenceStep[] {
    const stepMs = this.stepMs;
    // Flatten every block across all rows, tagged with its note info.
    interface Flat {
      start: number;
      length: number;
      note: string;
      pitch: Pitch;
    }
    const flat: Flat[] = [];
    for (const [key, blocks] of Object.entries(this.grid)) {
      const [note, octaveStr] = key.split('|');
      const octave = parseInt(octaveStr, 10);
      const pitch: Pitch = { note: note as NoteName, octave };
      for (const b of blocks) {
        flat.push({
          start: b.start,
          length: b.length,
          note: `${note}${octave}`,
          pitch,
        });
      }
    }
    // Group by start time → chords.
    flat.sort((a, b) => a.start - b.start);
    const out: SequenceStep[] = [];
    let i = 0;
    while (i < flat.length) {
      const group = [flat[i]];
      let j = i + 1;
      while (j < flat.length && flat[j].start === flat[i].start) {
        group.push(flat[j]);
        j += 1;
      }
      // Use the longest block length as the chord duration so chords
      // don't get cut off by shorter siblings.
      const length = Math.max(...group.map((g) => g.length));
      if (group.length === 1) {
        out.push({
          note: group[0].note,
          durationMs: Math.round(length * stepMs),
        });
      } else {
        out.push({
          chord: group.map((g) => g.note),
          durationMs: Math.round(length * stepMs),
        });
      }
      i = j;
    }
    return out;
  }

  public gridAsText(): string {
    // Two-part flat list. Every block has an explicit step position
    // (e.g. `2@60:4` = MIDI 60 starts at step 2, lasts 4 steps). This
    // round-trips perfectly with arbitrary grids where blocks are not
    // packed sequentially.
    const out: string[] = [];
    for (const [, blocks] of Object.entries(this.grid)) {
      for (const b of blocks) {
        const lengthSteps = Math.max(1, b.length);
        // Build the inner note/chord payload (MIDI numbers).
        // We need the note info to compute MIDI; the grid key is
        // `${note}|${octave}` so we can recover the pitch from it.
      }
    }
    // Rebuild with explicit pitch recovery: walk rows so we know the note.
    for (const row of this.rows) {
      const blocks = this.grid[`${row.note}|${row.octave}`] ?? [];
      for (const b of blocks) {
        const midi = pitchToMidi({ note: row.note, octave: row.octave });
        if (midi == null) continue;
        out.push(`${b.start}@${midi}:${Math.max(1, b.length)}`);
      }
    }
    // Sort by step for readability.
    out.sort((a, b) => {
      const sa = parseInt(a.split('@')[0], 10);
      const sb = parseInt(b.split('@')[0], 10);
      return sa - sb;
    });
    return out.join(' ');
  }

  /**
   * Replaces the current grid from a text payload. Accepts two flavors:
   *
   * 1) **Explicit step** (preferred): `2@60:4 8@64:2` — `step@midi:length`.
   *    Each token pins its block to a specific step in the grid. This is
   *    the format the sequencer exports and round-trips losslessly even
   *    when blocks are sparse / non-contiguous.
   *
   * 2) **Sequential** (fallback): `60:4 64:2 67:1` — tokens pack one
   *    after another; the cursor advances by `length` after each. Useful
   *    for quickly typing a melody without specifying positions.
   *
   * Both flavors support chords with `[60,64,67]:4` and
   * `2@[60,64,67]:4`. Tokens that don't parse are silently skipped.
   */
  public loadFromText(text: string): void {
    this.stop();
    const next: Grid = {};
    const tokens = (text || '')
      .replace(/[\n,;]/g, ' ')
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean);

    let cursorStep = 0;

    // Explicit-step: step@midi:length or step@[midis]:length
    const explicitNoteRegex = /^(\d{1,3})@(\d{1,3}):(\d{1,3})$/;
    const explicitChordRegex = /^(\d{1,3})@\[([^\]]+)\]:(\d{1,3})$/;
    // Sequential: midi:length or [midis]:length
    const seqNoteRegex = /^(\d{1,3}):(\d{1,3})$/;
    const seqChordRegex = /^\[([^\]]+)\]:(\d{1,3})$/;

    const clampStep = (s: number): number =>
      Math.max(0, Math.min(this.steps - 1, s));

    const place = (
      midi: number,
      length: number,
      startStep: number,
    ): void => {
      const pitch = midiToPitch(midi);
      if (!pitch) return;
      const key = `${pitch.note}|${pitch.octave}`;
      const list = next[key] ?? [];
      const step = clampStep(startStep);
      // Avoid stacking blocks at the same exact start on the same row.
      if (list.some((b) => b.start === step)) return;
      list.push({ start: step, length: Math.max(1, length) });
      next[key] = list.sort((a, b) => a.start - b.start);
    };

    for (const tok of tokens) {
      // Try explicit-step forms first.
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
        for (const m of midis) place(m, length, start);
        continue;
      }
      const expNote = explicitNoteRegex.exec(tok);
      if (expNote) {
        const start = parseInt(expNote[1], 10);
        const midi = parseInt(expNote[2], 10);
        const length = parseInt(expNote[3], 10);
        if (!Number.isFinite(start) || !length) continue;
        place(midi, length, start);
        continue;
      }

      // Sequential forms.
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
        for (const m of midis) place(m, length, cursorStep);
        cursorStep += Math.max(1, length);
        continue;
      }
      const seqNote = seqNoteRegex.exec(tok);
      if (seqNote) {
        const midi = parseInt(seqNote[1], 10);
        const length = parseInt(seqNote[2], 10);
        if (!length) continue;
        place(midi, length, cursorStep);
        cursorStep += Math.max(1, length);
        continue;
      }
    }
    this.grid = next;
    this.syncTextBufferFromGrid();
    this.cdr.markForCheck();
  }

  // ---------------- Playback ----------------

  private start(): void {
    const ctx = this.piano.getAudioContext();
    if (ctx) {
      this.audioCtx = ctx;
      this.audioCtx.resume().catch(() => undefined);
    }
    this.isPlaying = true;
    this.currentStep = -1;
    this.nextStepTime = 0;
    this.timerHandle = setInterval(() => this.tick(), 25);
    this.cdr.markForCheck();
  }

  private stop(): void {
    this.isPlaying = false;
    this.currentStep = -1;
    if (this.timerHandle) {
      clearInterval(this.timerHandle);
      this.timerHandle = null;
    }
    if (this.rafHandle) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    this.cdr.markForCheck();
  }

  /**
   * Look-ahead scheduler. Every 25ms checks which steps are due in the
   * next 100ms and pre-schedules them on the audio timeline.
   */
  private tick(): void {
    if (!this.isPlaying || !this.audioCtx) return;
    const now = this.audioCtx.currentTime;
    if (this.nextStepTime === 0) {
      this.nextStepTime = now + 0.05;
    }
    const lookahead = 0.1;
    let advanced = false;
    while (this.nextStepTime < now + lookahead) {
      const stepIdx =
        ((this.currentStep + 1) % this.steps + this.steps) % this.steps;
      this.scheduleStep(stepIdx, this.nextStepTime);
      this.currentStep = stepIdx;
      this.nextStepTime += this.stepMs / 1000;
      advanced = true;
    }
    if (advanced) {
      this.cdr.markForCheck();
    }
  }

  private scheduleStep(stepIdx: number, audioTime: number): void {
    if (!this.audioCtx) return;
    const delayMs = Math.max(
      0,
      (audioTime - this.audioCtx.currentTime) * 1000,
    );
    for (const row of this.rows) {
      const block = this.blockStartingAt(row, stepIdx);
      if (!block) continue;
      const noteDurMs = block.length * this.stepMs;
      setTimeout(() => {
        this.piano.playNote(
          { note: row.note, octave: row.octave },
          { waveform: this.waveform, durationMs: noteDurMs },
        );
      }, delayMs);
    }
  }

  public playheadFraction(): number {
    if (!this.isPlaying || !this.audioCtx) return 0;
    const now = this.audioCtx.currentTime;
    if (this.nextStepTime === 0) return 0;
    const elapsed = now - (this.nextStepTime - this.stepMs / 1000);
    return Math.max(0, Math.min(1, elapsed / (this.stepMs / 1000)));
  }
}
