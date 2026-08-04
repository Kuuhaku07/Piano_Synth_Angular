/**
 * Parser for the `step@midi:length` string format used by the piano
 * roll, the presets service, the sound service and the sequence cache.
 *
 * Two flavors are supported:
 *
 *  1) **Explicit step** (preferred): `2@60:4 8@64:2`
 *     Each token pins its block to a specific step.
 *
 *  2) **Sequential** (auto-incrementing): `60:4 64:2 67:1`
 *     The cursor advances by `length` after each token.
 *
 * Both flavors support chords via `[m1,m2,...]:length` and
 * `step@[m1,m2,...]:length`. The shared parser keeps the four call sites
 * (sound service, sequencer, cache, presets) in lock-step.
 */

export interface MidiStepEvent {
  /** Step where the note/chord starts (0-based). */
  startStep: number;
  /** MIDI note numbers included in this event (one = note, many = chord). */
  midis: number[];
  /** Duration in steps. Always >= 1 for parsed events. */
  lengthSteps: number;
}

const TOKEN_SPLIT = /[\s\n,;]+/;
const RE_EXPLICIT_NOTE = /^(\d{1,3})@(\d{1,3}):(\d{1,3})$/;
const RE_EXPLICIT_CHORD = /^(\d{1,3})@\[([^\]]+)\]:(\d{1,3})$/;
const RE_SEQ_NOTE = /^(\d{1,3}):(\d{1,3})$/;
const RE_SEQ_CHORD = /^\[([^\]]+)\]:(\d{1,3})$/;

function parseMidiList(raw: string): number[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 127);
}

/**
 * Tokenizes a sequence string in any of the four supported flavors and
 * returns the flat list of events. Sequential tokens pack one after
 * another; explicit tokens keep the step positions written by the user.
 *
 * Tokens that don't parse are silently skipped — callers can decide
 * whether empty output means "invalid input".
 */
export function parseMidiStepTokens(text: string): MidiStepEvent[] {
  const events: MidiStepEvent[] = [];
  if (!text) return events;

  const tokens = text
    .split(TOKEN_SPLIT)
    .map((t) => t.trim())
    .filter(Boolean);

  let cursorStep = 0;

  for (const tok of tokens) {
    let m: RegExpExecArray | null;
    if ((m = RE_EXPLICIT_CHORD.exec(tok))) {
      const start = parseInt(m[1], 10);
      const length = parseInt(m[3], 10);
      if (!length) continue;
      const midis = parseMidiList(m[2]);
      if (midis.length) {
        events.push({ startStep: start, midis, lengthSteps: length });
      }
      continue;
    }
    if ((m = RE_EXPLICIT_NOTE.exec(tok))) {
      const start = parseInt(m[1], 10);
      const midi = parseInt(m[2], 10);
      const length = parseInt(m[3], 10);
      if (!length) continue;
      events.push({ startStep: start, midis: [midi], lengthSteps: length });
      continue;
    }
    if ((m = RE_SEQ_CHORD.exec(tok))) {
      const length = parseInt(m[2], 10);
      if (!length) continue;
      const midis = parseMidiList(m[1]);
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
    if ((m = RE_SEQ_NOTE.exec(tok))) {
      const midi = parseInt(m[1], 10);
      const length = parseInt(m[2], 10);
      if (!length) continue;
      events.push({
        startStep: cursorStep,
        midis: [midi],
        lengthSteps: length,
      });
      cursorStep += Math.max(1, length);
    }
  }

  return events;
}

/**
 * Returns true if at least one token parses cleanly to a valid event.
 * Used by the sequence cache and the save form to reject garbage.
 */
export function hasValidMidiStepToken(text: string): boolean {
  if (!text || !text.trim()) return false;
  const tokens = text.split(TOKEN_SPLIT).map((t) => t.trim()).filter(Boolean);
  if (!tokens.length) return false;
  for (const tok of tokens) {
    if (
      RE_EXPLICIT_NOTE.test(tok) ||
      RE_EXPLICIT_CHORD.test(tok) ||
      RE_SEQ_NOTE.test(tok) ||
      RE_SEQ_CHORD.test(tok)
    ) {
      return true;
    }
  }
  return false;
}