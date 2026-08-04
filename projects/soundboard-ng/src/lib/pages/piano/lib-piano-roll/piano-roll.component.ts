import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostListener,
  Input,
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
} from '../../../services/piano-sound.service';
import { SequenceStep } from '../../../services/piano-sound.service';
import {
  midiToPitch,
  pitchToMidi,
} from '../../../services/music-theory';
import {
  parseMidiStepTokens,
} from '../../../services/midi-step-parser';

interface Block {
  start: number;
  length: number;
}

type Grid = Record<string, Block[]>;

@Component({
  selector: 'lib-piano-roll',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './piano-roll.component.html',
  styleUrl: './piano-roll.component.scss',
})
export class PianoRollComponent implements OnInit, OnDestroy {
  @Input() waveform: OscillatorType | VoiceName = 'softPad';
  @Input() baseOctave = 4;
  @Input() octaveCount = 2;

  totalSteps = 32;
  minSteps = 32;
  readonly expandBy = 16;
  readonly cellWidthPx = 34;
  readonly noteColWidthPx = 55;

  bpm = 100;
  quantization: '1/4' | '1/8' | '1/16' = '1/16';
  isPlaying = false;
  currentStep = -1;
  loop = false;

  grid: Grid = {};
  rows: Array<{ note: NoteName; octave: number }> = [];

  textBuffer = '';
  copyLabel = 'Copiar';

  @ViewChild('viewport') private viewportRef!: ElementRef<HTMLDivElement>;

  private drag: {
    rowKey: string;
    row: { note: NoteName; octave: number };
    anchorStep: number;
    block: Block;
    willToggleOnTap: boolean;
    hasMoved: boolean;
  } | null = null;

  private stepMs = (60 / this.bpm) * 1000 / 4;
  private endStep = 0;
  private nextStepTime = 0;
  private audioCtx: AudioContext | null = null;
  private timerHandle: any = null;

  private seeking = false;
  private seekStep = 0;

  constructor(
    private piano: PianoSoundService,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    this.recomputeRows();
    this.recomputeStepMs();
    this.syncTextBufferFromGrid();
  }

  ngOnDestroy(): void {
    this.stop();
  }

  get stepNumbers(): number[] {
    return Array.from({ length: this.totalSteps }, (_, i) => i);
  }

  get lastUsedStep(): number {
    return this.endStep;
  }

  get playheadPx(): number {
    if (this.currentStep < 0 && !this.seeking) return -1;
    if (this.seeking) return this.seekStep * this.cellWidthPx;
    const frac = this.isPlaying ? this.playheadFraction() : 0;
    return (this.currentStep + frac) * this.cellWidthPx;
  }

  get gridWidthPx(): number {
    return this.totalSteps * this.cellWidthPx;
  }

  get rowCount(): number {
    return this.rows.length;
  }

  // ---- Public API ----

  togglePlay(): void {
    if (this.isPlaying) {
      this.stop();
    } else {
      this.start();
    }
  }

  clear(): void {
    this.stop();
    this.grid = {};
    this.endStep = 0;
    this.totalSteps = this.minSteps;
    this.syncTextBufferFromGrid();
    this.cdr.markForCheck();
  }

  setBpm(value: number): void {
    this.bpm = Math.max(40, Math.min(240, value));
    this.recomputeStepMs();
    this.cdr.markForCheck();
  }

  setQuantization(q: '1/4' | '1/8' | '1/16'): void {
    this.quantization = q;
    this.recomputeStepMs();
    this.cdr.markForCheck();
  }

  getStepDurationMs(): number {
    return this.stepMs;
  }

  async copyToClipboard(): Promise<void> {
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
      this.copyLabel = 'Copiado!';
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

  playExported(): void {
    const steps = this.gridAsSequence();
    if (!steps.length) return;
    this.piano.playSequence(steps, { waveform: this.waveform });
  }

  onPaste(event: ClipboardEvent): void {
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (!text.trim()) return;
    const looksLikeMidiSteps =
      /(^|\s)\d{1,3}:\d{1,3}(\s|$)/.test(text) ||
      /(^|\s)\[[^\]]+\]:\d{1,3}(\s|$)/.test(text) ||
      /(^|\s)\d{1,3}@\d{1,3}:\d{1,3}(\s|$)/.test(text) ||
      /(^|\s)\d{1,3}@\[[^\]]+\]:\d{1,3}(\s|$)/.test(text);
    if (!looksLikeMidiSteps) return;
    event.preventDefault();
    this.loadFromText(text);
  }

  // ---- Playhead seeking ----

  onPlayheadDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    this.seeking = true;
    const step = this.stepAtClientX(event.clientX);
    this.seekStep = Math.max(0, step);
    this.cdr.markForCheck();

    const onMove = (e: PointerEvent) => {
      if (!this.seeking) return;
      const s = Math.max(0, this.stepAtClientX(e.clientX));
      this.seekStep = s;
      this.cdr.markForCheck();
    };
    const onUp = () => {
      if (!this.seeking) return;
      this.seeking = false;
      this.currentStep = this.seekStep;
      if (this.isPlaying && this.audioCtx) {
        this.nextStepTime = this.audioCtx.currentTime;
      }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      this.cdr.markForCheck();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  private stepAtClientX(clientX: number): number {
    const vp = this.viewportRef?.nativeElement;
    if (!vp) return 0;
    const rect = vp.getBoundingClientRect();
    const x = clientX - rect.left + vp.scrollLeft - this.noteColWidthPx;
    return Math.max(0, Math.floor(x / this.cellWidthPx));
  }

  // ---- Grid helpers ----

  blockAt(row: { note: NoteName; octave: number }, step: number): Block | null {
    const blocks = this.grid[this.rowKey(row)] ?? [];
    for (const b of blocks) {
      if (step >= b.start && step < b.start + b.length) return b;
    }
    return null;
  }

  blockStartingAt(
    row: { note: NoteName; octave: number },
    startStep: number,
  ): Block | null {
    const blocks = this.grid[this.rowKey(row)] ?? [];
    return blocks.find((b) => b.start === startStep) ?? null;
  }

  isBlack(row: { note: NoteName }): boolean {
    return row.note.includes('#');
  }

  isStepPlaying(step: number): boolean {
    if (!this.isPlaying) return false;
    if (this.seeking) return this.seekStep === step;
    return this.currentStep === step;
  }

  onPointerDown(
    row: { note: NoteName; octave: number },
    step: number,
    event: PointerEvent,
  ): void {
    if (event.button !== 0) return;
    this.ensureStepVisible(step);
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
      this.updateEndStep();
    }
    this.syncTextBufferFromGrid();
    this.cdr.markForCheck();
  }

  onPointerEnter(
    row: { note: NoteName; octave: number },
    step: number,
  ): void {
    if (!this.drag) return;
    if (this.rowKey(row) !== this.drag.rowKey) return;
    if (step === this.drag.anchorStep) return;

    this.ensureStepVisible(step);
    this.drag.hasMoved = true;
    const start = this.drag.anchorStep;
    const lo = Math.min(start, step);
    const hi = Math.max(start, step);
    const length = hi - lo + 1;
    if (this.drag.block.length !== length) {
      this.drag.block.length = length;
      this.updateEndStep();
      this.syncTextBufferFromGrid();
      this.cdr.markForCheck();
    }
  }

  @HostListener('window:pointerup')
  endDrag(): void {
    if (!this.drag) return;
    if (!this.drag.hasMoved && this.drag.willToggleOnTap) {
      const key = this.drag.rowKey;
      const blocks = (this.grid[key] ?? []).filter(
        (b) => b !== this.drag!.block,
      );
      if (blocks.length === 0) {
        delete this.grid[key];
      } else {
        this.grid[key] = blocks;
      }
      this.updateEndStep();
    }
    this.drag = null;
    this.syncTextBufferFromGrid();
    this.cdr.markForCheck();
  }

  @HostListener('window:pointercancel')
  cancelDrag(): void {
    this.drag = null;
  }

  onKeyDown(event: KeyboardEvent): void {
    if (event.key !== ' ') return;
    if (event.repeat || event.ctrlKey || event.altKey || event.metaKey) return;
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
    event.preventDefault();
    if (target?.tagName === 'BUTTON') {
      target.blur();
    }
    this.togglePlay();
  }

  // ---- Export ----

  gridAsSequence(): SequenceStep[] {
    const stepMs = this.stepMs;
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

  gridAsText(): string {
    const out: string[] = [];
    for (const row of this.rows) {
      const blocks = this.grid[this.rowKey(row)] ?? [];
      for (const b of blocks) {
        const midi = pitchToMidi({ note: row.note, octave: row.octave });
        if (midi == null) continue;
        out.push(`${b.start}@${midi}:${Math.max(1, b.length)}`);
      }
    }
    out.sort((a, b) => {
      const sa = parseInt(a.split('@')[0], 10);
      const sb = parseInt(b.split('@')[0], 10);
      return sa - sb;
    });
    return out.join(' ');
  }

  loadFromText(text: string): void {
    this.stop();
    const next: Grid = {};

    const events = parseMidiStepTokens(text || '');

    let maxStep = 0;

    const place = (
      midi: number,
      length: number,
      startStep: number,
    ): void => {
      const pitch = midiToPitch(midi);
      if (!pitch) return;
      const key = this.rowKey(pitch);
      const list = next[key] ?? [];
      if (list.some((b) => b.start === startStep)) return;
      list.push({ start: startStep, length: Math.max(1, length) });
      next[key] = list.sort((a, b) => a.start - b.start);
      if (startStep + length > maxStep) {
        maxStep = startStep + length;
      }
    };

    for (const ev of events) {
      for (const m of ev.midis) place(m, ev.lengthSteps, ev.startStep);
    }

    this.grid = next;
    this.endStep = maxStep;
    this.ensureTotalStepsCovers(maxStep);
    this.syncTextBufferFromGrid();
    this.cdr.markForCheck();
  }

  // ---- Playback ----

  playheadFraction(): number {
    if (!this.isPlaying || !this.audioCtx) return 0;
    const now = this.audioCtx.currentTime;
    if (this.nextStepTime === 0) return 0;
    const elapsed = now - (this.nextStepTime - this.stepMs / 1000);
    return Math.max(0, Math.min(1, elapsed / (this.stepMs / 1000)));
  }

  // ---- Private ----

  rowKey(row: { note: NoteName; octave: number }): string {
    return `${row.note}|${row.octave}`;
  }

  private recomputeRows(): void {
    const list: Array<{ note: NoteName; octave: number }> = [];
    const semitones: NoteName[] = [
      'B', 'A#', 'A', 'G#', 'G', 'F#', 'F',
      'E', 'D#', 'D', 'C#', 'C',
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

  private syncTextBufferFromGrid(): void {
    this.textBuffer = this.gridAsText();
  }

  private updateEndStep(): void {
    let max = 0;
    for (const [, blocks] of Object.entries(this.grid)) {
      for (const b of blocks) {
        if (b.start + b.length > max) max = b.start + b.length;
      }
    }
    this.endStep = max;
    this.ensureTotalStepsCovers(max);
  }

  private ensureTotalStepsCovers(maxStep: number): void {
    const needed = maxStep + this.expandBy;
    if (needed > this.totalSteps) {
      this.totalSteps = Math.max(
        this.minSteps,
        Math.ceil(needed / this.expandBy) * this.expandBy,
      );
    }
  }

  private ensureStepVisible(step: number): void {
    if (step >= this.totalSteps - 4) {
      this.totalSteps += this.expandBy;
    }
  }

  private start(): void {
    const ctx = this.piano.getAudioContext();
    if (ctx) {
      this.audioCtx = ctx;
      this.audioCtx.resume().catch(() => undefined);
    }
    this.isPlaying = true;
    this.nextStepTime = 0;
    this.timerHandle = setInterval(() => this.tick(), 25);
    this.cdr.markForCheck();
  }

  private stop(): void {
    this.isPlaying = false;
    if (this.timerHandle) {
      clearInterval(this.timerHandle);
      this.timerHandle = null;
    }
    this.cdr.markForCheck();
  }

  private tick(): void {
    if (!this.isPlaying || !this.audioCtx) return;
    const now = this.audioCtx.currentTime;
    if (this.nextStepTime === 0) {
      this.nextStepTime = now + 0.05;
    }
    const lookahead = 0.1;
    let advanced = false;

    while (this.nextStepTime < now + lookahead) {
      const next = this.currentStep + 1;
      if (next >= this.endStep + 1) {
        if (this.loop) {
          this.currentStep = -1;
          this.nextStepTime = now + 0.05;
          break;
        } else {
          this.stop();
          return;
        }
      }
      this.scheduleStep(next, this.nextStepTime);
      this.currentStep = next;
      this.nextStepTime += this.stepMs / 1000;
      advanced = true;
    }

    if (advanced) {
      this.followPlayhead();
      this.cdr.markForCheck();
    }
  }

  private followPlayhead(): void {
    const vp = this.viewportRef?.nativeElement;
    if (!vp) return;
    const playheadX = this.noteColWidthPx + this.currentStep * this.cellWidthPx;
    const viewLeft = vp.scrollLeft;
    const viewWidth = vp.clientWidth;
    const viewRight = viewLeft + viewWidth;
    const margin = this.cellWidthPx * 4;

    if (playheadX < viewLeft + margin) {
      vp.scrollLeft = Math.max(0, playheadX - margin);
    } else if (playheadX > viewRight - margin) {
      vp.scrollLeft = playheadX - viewWidth + margin;
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
}
