/*
 * Public API Surface of ngx-piano
 */

export { PianoPageComponent } from './lib/pages/piano/piano-page.component';
export { PianoSequencerComponent } from './lib/pages/piano/lib-sequencer/piano-sequencer.component';

export { PianoSoundService } from './lib/services/piano-sound.service';
export type {
  NoteName,
  Pitch,
  VoiceName,
  Harmonic,
  SequenceStep,
  PlayOptions,
  SequenceOptions,
} from './lib/services/piano-sound.service';

export {
  PIANO_PRESETS_DEFAULT,
  PianoPresetsService,
  PRESETS_URL,
} from './lib/services/piano-presets';
export type { PianoPresetKey } from './lib/services/piano-presets';

export { SequenceCacheService } from './lib/services/sequence-cache.service';
export type { CachedSequence } from './lib/services/sequence-cache.service';
export { isValidSequence } from './lib/services/sequence-cache.service';

export { PianoModule } from './lib/piano.module';