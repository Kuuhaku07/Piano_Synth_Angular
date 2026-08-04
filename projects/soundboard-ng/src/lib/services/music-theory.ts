/**
 * Shared music-theory helpers used by the audio service, the sequencer
 * and the sequence cache. Extracted so we don't ship four copies of the
 * NOTE_INDEX table around the codebase.
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

export interface Pitch {
  note: NoteName;
  octave: number;
}

export const NOTE_INDEX: Record<NoteName, number> = {
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

const NOTE_NAMES: NoteName[] = [
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

const FLAT_TO_SHARP: Record<string, NoteName> = {
  Db: 'C#',
  Eb: 'D#',
  Gb: 'F#',
  Ab: 'G#',
  Bb: 'A#',
};

/**
 * Parses a string pitch like "C4", "F#5", "Bb3" into a Pitch object.
 * Returns null if the string cannot be parsed.
 */
export function parsePitch(input: string): Pitch | null {
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
 * Converts a MIDI note number (0..127) to a Pitch. Returns null if the
 * MIDI number is out of range.
 */
export function midiToPitch(midi: number): Pitch | null {
  if (!Number.isFinite(midi) || midi < 0 || midi > 127) return null;
  const idx = midi % 12;
  const octave = Math.floor(midi / 12) - 1;
  return { note: NOTE_NAMES[idx], octave };
}

/**
 * Converts a Pitch to a MIDI note number. Returns null if the pitch is
 * null. MIDI = (octave + 1) * 12 + index. With C4 = 60, A4 = 69, etc.
 */
export function pitchToMidi(p: Pitch | null): number | null {
  if (!p) return null;
  return (p.octave + 1) * 12 + NOTE_INDEX[p.note];
}

export function semitones(): NoteName[] {
  return NOTE_NAMES.slice();
}