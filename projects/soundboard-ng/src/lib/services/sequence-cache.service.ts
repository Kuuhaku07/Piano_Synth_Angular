import { Injectable } from '@angular/core';
import { hasValidMidiStepToken } from './midi-step-parser';

export interface CachedSequence {
  /** Stable unique id (timestamp-based). */
  id: string;
  /** User-facing name. Defaults to "Secuencia N". */
  name: string;
  /** The original pasted text (step@midi:length format). */
  text: string;
  /** Epoch ms when saved. */
  createdAt: number;
}

const STORAGE_KEY = 'piano-sequence-cache-v1';

/**
 * Parses a sequence string in the same format the piano sequencer accepts:
 *   `step@midi:length` for single notes,
 *   `step@[m1,m2,...]:length` for chords,
 *   `midi:length` or `[midis]:length` for sequential (auto-incrementing step).
 *
 * Returns true if at least one token parses cleanly to a valid (start, midi,
 * length) tuple, so the UI can reject empty / garbage input.
 */
export function isValidSequence(text: string): boolean {
  return hasValidMidiStepToken(text);
}

@Injectable({ providedIn: 'root' })
export class SequenceCacheService {
  private items: CachedSequence[] = [];

  constructor() {
    this.load();
  }

  public list(): CachedSequence[] {
    return [...this.items].sort((a, b) => b.createdAt - a.createdAt);
  }

  public add(text: string, name?: string): CachedSequence | null {
    const trimmed = (text || '').trim();
    if (!isValidSequence(trimmed)) return null;

    const item: CachedSequence = {
      id: `seq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: (name || '').trim() || `Secuencia ${this.items.length + 1}`,
      text: trimmed,
      createdAt: Date.now(),
    };
    this.items.push(item);
    this.persist();
    return item;
  }

  public remove(id: string): void {
    const before = this.items.length;
    this.items = this.items.filter((it) => it.id !== id);
    if (this.items.length !== before) {
      this.persist();
    }
  }

  private load(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.items = parsed.filter(
          (it) =>
            it &&
            typeof it.id === 'string' &&
            typeof it.text === 'string' &&
            typeof it.createdAt === 'number',
        );
      }
    } catch {
      this.items = [];
    }
  }

  private persist(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.items));
    } catch {
      // localStorage quota / disabled — fail silently, in-memory state still works.
    }
  }
}