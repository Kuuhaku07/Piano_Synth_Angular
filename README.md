# soundboard-ng

Librería Angular 17 standalone + dashboard del módulo Soundboard: sintetizador 100% en navegador (Web Audio API), secuenciador tipo piano roll, presets predefinidos y cache editable de secuencias en `localStorage`.

Pensada para centralizar el código del soundboard y consumirlo desde otros proyectos vía npm (`soundboard-ng`).

---

## Tabla de contenidos

1. [Scripts](#scripts)
2. [Estructura](#estructura)
3. [Instalación](#instalación)
4. [API pública](#api-pública)
5. [Componentes](#componentes)
6. [`PianoSoundService` — guía completa](#pianosoundservice--guía-completa)
7. [`PianoPresets` — formato MIDI:step](#pianopresets--formato-midistep)
8. [`SequenceCacheService` — localStorage CRUD](#sequencecacheservice--localstorage-crud)
9. [Tailwind en el consumidor](#tailwind-en-el-consumidor)
10. [Flujo de publicación](#flujo-de-publicación)

---

## Scripts

```bash
npm install
npm start                # dashboard dev server (http://localhost:4200)
npm run build            # build de la app dashboard
npm run build:lib        # build de la librería → dist/soundboard-ng/
npm test
```

---

## Estructura

```
projects/soundboard-ng/        # librería (ng-packagr)
  src/
    public-api.ts                # exports granulares
    lib/
      piano.module.ts            # NgModule para consumidores clásicos
      pages/piano/
        piano-page.component.{ts,html,scss}      # <lib-piano-page>
        lib-sequencer/piano-sequencer.component.{ts,html,scss}  # <lib-piano-sequencer>
      services/
        piano-sound.service.ts    # motor de audio
        piano-presets.ts          # presets cargables (defaults + JSON del consumidor)
        sequence-cache.service.ts # CRUD en localStorage
src/app/                # dashboard app (standalone)
```

---

## Instalación

En el `package.json` del consumidor:

```json
"soundboard-ng": "^0.1.0"
```

Después `npm install`. La librería es Angular 17 standalone; necesita Angular >= 17 en el peer.

---

## API pública

```ts
import {
  // Componentes standalone
  PianoPageComponent,         // <lib-piano-page>
  PianoSequencerComponent,    // <lib-piano-sequencer>

  // Servicios
  PianoSoundService,          // motor de audio (síntesis + secuencias)
  PianoPresetsService,        // cargador de presets (defaults + JSON del consumidor)
  SequenceCacheService,       // CRUD de secuencias en localStorage

  // Constantes y helpers
  PIANO_PRESETS_DEFAULT,      // defaults congelados de la lib
  isValidSequence,            // (text: string) => boolean

  // NgModule (opcional, para consumidores clásicos)
  PianoModule,

  // Tipos
  type NoteName,              // 'C' | 'C#' | 'D' | ... | 'B'
  type Pitch,                 // { note: NoteName; octave: number }
  type VoiceName,             // 'piano' | 'bell' | 'organ' | ... | 'glass' | ...
  type Harmonic,              // { mult: number; gain: number; type?: OscillatorType }
  type SequenceStep,          // { note, durationMs } | { chord, durationMs } | { restMs }
  type PlayOptions,           // { durationMs?, velocity?, waveform? }
  type SequenceOptions,       // { gapMs?, waveform?, velocity?, legatoMs?, humanize?, velocityHumanize? }
  type PianoPresetKey,        // keyof typeof PIANO_PRESETS_DEFAULT
  type CachedSequence,        // { id, name, text, createdAt }
} from 'soundboard-ng';
```

---

## Componentes

### `<lib-piano-page>`

Componente standalone que renderiza el dashboard completo: controles (octava, volumen, waveform), teclado, presets y guardado de secuencias. Es lo más simple de usar.

```ts
import { Component } from '@angular/core';
import { PianoPageComponent } from 'soundboard-ng';

@Component({
  standalone: true,
  imports: [PianoPageComponent],
  template: '<lib-piano-page></lib-piano-page>',
})
export class MyPage {}
```

### `<lib-piano-sequencer>`

Piano roll editable standalone. Útil si querés armar tu propia UI alrededor.

```ts
@Component({
  standalone: true,
  imports: [PianoSequencerComponent],
  template: `
    <lib-piano-sequencer
      [waveform]="'piano'"
      [baseOctave]="4"
      [octaveCount]="2"
    ></lib-piano-sequencer>
  `,
})
```

`@Input()s`:
- `waveform: OscillatorType | VoiceName` — voz a usar para la preview al hacer click en una celda (default `'softPad'`).
- `baseOctave: number` — octava inicial del eje vertical.
- `octaveCount: number` — cantidad de octavas visibles.

`@Output()s`:
- `notePreview: EventEmitter<Pitch>` — emite cuando el usuario hace click en una celda.

---

## `PianoSoundService` — guía completa

Es el corazón de la librería. Inyectalo en cualquier componente o servicio y sintetiza audio 100% en el navegador con la Web Audio API. No requiere samples externos.

```ts
import { Injectable } from '@angular/core';
import { PianoSoundService } from 'soundboard-ng';

@Injectable({ providedIn: 'root' })
export class MyAudioThing {
  constructor(private piano: PianoSoundService) {}

  async playSomething() {
    await this.piano.playNote('C4', { durationMs: 500, waveform: 'piano' });
  }
}
```

**Importante**: la primera llamada que hagas (cualquier `play*`) inicializa el `AudioContext`. Los navegadores modernos requieren un gesto del usuario antes de reproducir audio — llamá desde un click handler, no desde el constructor.

### API

#### Notas sueltas

```ts
playNote(input: string | Pitch, options?: PlayOptions): Promise<void>
```

Reproduce una nota. Si no pasás `durationMs`, la nota queda sostenida hasta que llames `stopNote`.

```ts
// String shorthand (nota + octava, ej. 'C4', 'F#5', 'Bb3')
await this.piano.playNote('E4');

// Objeto Pitch
await this.piano.playNote({ note: 'G', octave: 4 }, { durationMs: 800 });

// Con voz compuesta (string)
await this.piano.playNote('A3', { waveform: 'lead', velocity: 0.9 });

// Con oscilador raw de Web Audio
await this.piano.playNote('C5', { waveform: 'triangle' });
```

#### Acordes

```ts
playChord(input: Array<string | Pitch>, options?: PlayOptions): Promise<void>
```

Reproduce varias notas simultáneamente con `startTime` sample-accurate (no smear).

```ts
await this.piano.playChord(['C4', 'E4', 'G4'], { durationMs: 1500 });
await this.piano.playChord(
  [{ note: 'C', octave: 3 }, { note: 'G', octave: 3 }, { note: 'B', octave: 3 }],
  { waveform: 'pad' }
);
```

#### Secuencias tipadas

```ts
playSequence(steps: SequenceStep[], options?: SequenceOptions): Promise<void>
```

Reproduce un array de steps tipados. Tiene look-ahead scheduler (cada 25 ms escanea los próximos 150 ms) para evitar jitter de `setTimeout`.

```ts
await this.piano.playSequence(
  [
    { note: 'C4', durationMs: 400 },
    { note: 'E4', durationMs: 400 },
    { note: 'G4', durationMs: 400 },
    { note: 'C5', durationMs: 800 },
    { restMs: 200 },
    { chord: ['E4', 'G4', 'C5'], durationMs: 1200 },
  ],
  {
    waveform: 'piano',
    legatoMs: 60,      // default: 60
    humanize: 0.08,    // default: 0.08 (±8 % jitter en timing)
    velocityHumanize: 0.12,  // default: 0.12 (±12 % jitter en velocity)
  },
);
```

`SequenceStep` es discriminated union:
- `{ note: string; durationMs?: number }` — una nota
- `{ chord: string[]; durationMs?: number }` — un acorde
- `{ restMs: number }` — silencio

#### Secuencias en formato MIDI:step (string)

```ts
playMidiSteps(text: string, options?: SequenceOptions & {
  stepMs?: number;
  totalSteps?: number;
  loop?: boolean;
  onEnd?: () => void;
}): Promise<void>
```

Reproduce una secuencia descrita como string en el formato usado por el piano roll y los presets. Ver [sección PianoPresets](#pianopresets--formato-midistep).

```ts
await this.piano.playMidiSteps(
  '0@60:2 2@[60,64,67]:1 4@64:2 4@67:4',
  {
    stepMs: 200,        // default: 200 (100 BPM @ 1/16)
    loop: true,
    waveform: 'piano',
    onEnd: () => console.log('finished'),
  },
);
```

#### Control de transporte

```ts
stopNote(input: string | Pitch): void   // para una nota específica
stopAll(): void                          // para todo lo que esté sonando
stopSequence(): void                     // para la secuencia activa (playSequence / playMidiSteps)
```

#### Configuración global

```ts
setVolume(value: number): void   // 0..1
getVolume(): number
setWaveform(w: OscillatorType | VoiceName): void   // voz por defecto para playNote sin waveform
```

#### Helpers

```ts
parsePitch(input: string): Pitch | null   // 'C4' → { note: 'C', octave: 4 }; null si es inválido
frequencyOf(pitch: Pitch): number          // { note: 'A', octave: 4 } → 440
getAudioContext(): AudioContext | null     // el contexto subyacente (útil para vis / análisis)
```

### Voces disponibles (`VoiceName`)

Cada voz es un ensamble de osciladores (`PianoSoundService` se encarga del routing):

| Voz       | Carácter                                          |
| --------- | ------------------------------------------------- |
| `glass`   | sine cristalino con shimmer inarmónico            |
| `marimba` | triangle fundamental + decay rápido de madera     |
| `musicBox`| triangle + parciales tipo campanilla               |
| `softPiano` | sine + armónicos suaves                         |
| `softPad` | sines detuneados, ataque lento — la más calmada   |
| `piano`   | sine + triangle decay — acústica-ish              |
| `bell`    | FM-ish con ratios inarmónicos                      |
| `organ`   | Hammond — stack armónico completo                  |
| `pluck`   | triangle con release rápido                       |
| `lead`    | saw detuneado (par) — synth lead                  |
| `bass`    | sine sub + triangle armónico                      |
| `pad`     | sines detuneados + triangle sutil                 |

Más cualquier `OscillatorType` estándar de Web Audio: `'sine'`, `'square'`, `'triangle'`, `'sawtooth'`.

### Ejemplo end-to-end

```ts
import { Component, inject } from '@angular/core';
import { PianoSoundService, PianoPresetsService, NoteName, Pitch } from 'soundboard-ng';

@Component({
  selector: 'app-my-button',
  standalone: true,
  template: `<button (click)="play()">Play C major</button>`,
})
export class MyButton {
  private piano = inject(PianoSoundService);

  async play() {
    // Acorde
    await this.piano.playChord(['C4', 'E4', 'G4'], { durationMs: 1200 });
    // Melodía corta
    await this.piano.playSequence(
      [
        { note: 'C5', durationMs: 300 },
        { note: 'B4', durationMs: 300 },
        { note: 'A4', durationMs: 300 },
        { note: 'G4', durationMs: 600 },
      ],
      { waveform: 'bell' },
    );
    // Preset predefinido
    const presets = inject(PianoPresetsService);
    await presets.loadAll();
    await this.piano.playMidiSteps(presets.get('flow') ?? '', { loop: true });
  }

  ngOnDestroy() {
    this.piano.stopAll();
    this.piano.stopSequence();
  }
}
```

---

## `PianoPresets` — formato MIDI:step

Los presets viven en dos lugares:

1. **`PIANO_PRESETS_DEFAULT`** (exportado por la lib): 8 patrones hardcoded como fallback.
2. **`assets/piano-presets.json`** del consumidor: presets custom que se mergean sobre los defaults en runtime.

`PianoPresetsService` carga los defaults + el JSON del consumidor (si existe) y los expone vía `get(name)`, `getAll()`, `keys()`.

### Cómo personalizar los presets SIN tocar la librería

1. En el consumidor, creá `src/assets/piano-presets.json` con tu propio set. Mismo formato `{ "nombre": "0@60:2 4@64:4" }`.
2. Asegurate de que `HttpClient` esté disponible (`provideHttpClient()` en `app.config.ts`).
3. Nada más. Los presets se cargan al inicializar el servicio y se mergean con los defaults (tu JSON gana si hay claves duplicadas).

Ejemplo de `src/assets/piano-presets.json`:
```json
{
  "wakeup":  "0@60:4 4@64:4 8@67:4 12@72:8",
  "alertar": "0@67:1 1@72:1 2@76:4",
  "intro":   "0@[60,64,67]:8 8@72:8 16@[60,64,67,72]:8"
}
```

Si el JSON no existe o falla la carga, se usan los defaults.

### Formato del string MIDI:step

- **`step@midi:length`** — una nota (`step` step inicial, `midi` nota MIDI, `length` duración en steps)
- **`step@[m1,m2,...]:length`** — un acorde
- **`midi:length`** o **`[m1,m2,...]:length`** — sin step explícito, auto-incrementa

Ejemplos:
```text
0@60:2           → MIDI 60 (C4) durante 2 steps, arrancando en step 0
2@67:4           → MIDI 67 (G4) durante 4 steps, arrancando en step 2
2@[60,64,67]:4   → acorde C-E-G arrancando en step 2 durante 4 steps
60:2 64:4 67:4   → mismas notas, pero steps auto-asignados 0/2/6
```

**Importante**: el servicio schedulea cada token en el step EXACTO que escribiste — no son secuenciales. Si querés que suenen uno tras otro, tenés que especificar steps crecientes.

Duración de step: **200 ms** por default (configurable vía `stepMs` en `playMidiSteps`).

---

## `SequenceCacheService` — localStorage CRUD

Cache editable de secuencias en `localStorage`. La UI del `<lib-piano-page>` lo usa para el bloque "Guardar secuencia", pero también podés usarlo programáticamente.

```ts
import { inject } from '@angular/core';
import { SequenceCacheService, isValidSequence, CachedSequence } from 'soundboard-ng';

const cache = inject(SequenceCacheService);

// Validar antes de guardar
if (isValidSequence('0@60:2 4@64:4')) {
  const item = cache.add('0@60:2 4@64:4', 'Mi melodía'); // → CachedSequence | null
}

// Listar (ordenado por createdAt desc)
const all: CachedSequence[] = cache.list();

cache.remove(item.id);
```

Storage key: `piano-sequence-cache-v1`. Maneja errores de quota / `localStorage` deshabilitado silenciosamente.

---

## Tailwind en el consumidor

Los componentes usan clases Tailwind (`bg-slate-900`, `bg-emerald-500`, `rounded-xl`, etc.). Agregá la ruta del FESM al `content`:

```js
// tailwind.config.js del consumidor
module.exports = {
  content: [
    './src/**/*.{html,ts}',
    './node_modules/soundboard-ng/fesm2022/**/*.mjs',
  ],
};
```

Si usás Tailwind v4, ajustá el `content` según corresponda.

---

## Flujo de publicación

```bash
# 1. Compilar la librería
npm run build:lib

# 2. Empaquetar (opcional, para subir como asset a GitHub Release)
npm pack dist/soundboard-ng --pack-destination .

# 3. Bumpear la versión en projects/soundboard-ng/package.json

# 4. Commit + push
git add -A
git commit -m "feat: nuevos cambios"
git push origin main

# 5. Publicar a npm
cd dist/soundboard-ng
npm publish --access public
```

En cada consumidor:
```bash
npm install
```

---

## Compatibilidad

- Angular 17+ (los componentes son standalone, pero `PianoModule` exporta un NgModule para consumidores clásicos).
- Web Audio API (todos los navegadores modernos).
- Requiere gesto del usuario para la primera reproducción.