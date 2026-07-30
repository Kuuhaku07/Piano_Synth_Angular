# ngx-piano

Librería Angular 17 + dashboard standalone del módulo Piano: sintetizador 100% en navegador (Web Audio API), secuenciador tipo piano roll, presets predefinidos y cache editable de secuencias en `localStorage`.

Pensada para centralizar el código del piano y consumirlo desde otros repos vía GitHub Releases.

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
npm run build:lib        # build de la librería → dist/ngx-piano/
npm test
```

---

## Estructura

```
projects/ngx-piano/        # librería (ng-packagr)
  src/
    public-api.ts           # exports granulares
    lib/
      piano.module.ts       # NgModule para consumidores clásicos
      pages/piano/
        piano-page.component.{ts,html,scss}     # <lib-piano-page>
        lib-sequencer/piano-sequencer.component.{ts,html,scss}  # <lib-piano-sequencer>
      services/
        piano-sound.service.ts        # motor de audio
        piano-presets.ts              # 8 presets predefinidos
        sequence-cache.service.ts     # CRUD en localStorage
src/app/                    # dashboard app (standalone, standalone-only)
```

---

## Instalación

En el `package.json` del consumidor:

```json
"ngx-piano": "https://github.com/dev1-tecnosystem/ngx-piano/releases/download/vX.Y.Z/ngx-piano-X.Y.Z.tgz"
```

Después `npm install`. La librería es Angular 17 standalone, así que necesita Angular >= 17 en el peer.

---

## API pública

```ts
import {
  // Componentes standalone
  PianoPageComponent,        // <lib-piano-page>
  PianoSequencerComponent,   // <lib-piano-sequencer>

  // Servicios
  PianoSoundService,         // motor de audio (síntesis + secuencias)
  SequenceCacheService,      // CRUD de secuencias en localStorage

  // Constantes y helpers
  PianoPresets,              // Record<string, string> — presets predefinidos
  isValidSequence,           // (text: string) => boolean

  // NgModule (opcional, para consumidores clásicos)
  PianoModule,

  // Tipos
  type NoteName,             // 'C' | 'C#' | 'D' | ... | 'B'
  type Pitch,                // { note: NoteName; octave: number }
  type VoiceName,            // 'piano' | 'bell' | 'organ' | ... | 'glass' | ...
  type Harmonic,             // { mult: number; gain: number; type?: OscillatorType }
  type SequenceStep,         // { note, durationMs } | { chord, durationMs } | { restMs }
  type PlayOptions,          // { durationMs?, velocity?, waveform? }
  type SequenceOptions,      // { gapMs?, waveform?, velocity?, legatoMs?, humanize?, velocityHumanize? }
  type PianoPresetKey,       // keyof typeof PianoPresets
  type CachedSequence,       // { id, name, text, createdAt }
} from 'ngx-piano';
```

---

## Componentes

### `<lib-piano-page>`

Componente standalone que renderiza el dashboard completo: controles (octava, volumen, waveform), teclado, presets y guardado de secuencias. Es lo más simple de usar.

```ts
import { Component } from '@angular/core';
import { PianoPageComponent } from 'ngx-piano';

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
import { PianoSoundService } from 'ngx-piano';

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
import { PianoSoundService, PianoPresets, NoteName, Pitch } from 'ngx-piano';

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
    await this.piano.playMidiSteps(PianoPresets.flow, { loop: true });
  }

  ngOnDestroy() {
    this.piano.stopAll();
    this.piano.stopSequence();
  }
}
```

---

## `PianoPresets` — formato MIDI:step

`PianoPresets` es un `Record<string, string>` con 8 patrones listos para usar:

```ts
import { PianoPresets, PianoPresetKey } from 'ngx-piano';

PianoPresets.success;   // '2@64:1 4@68:1 5@71:1'
PianoPresets.gentle;    // '0@[36,43]:12 0@76:4 ...'
PianoPresets.flow;
PianoPresets.alert;
PianoPresets.bounce;
PianoPresets.chime;
PianoPresets.test;
PianoPresets.test2;

await this.piano.playMidiSteps(PianoPresets.alert, { waveform: 'bell' });
```

### Formato del string

Cada token describe un evento:

- **`step@midi:length`** — una nota
  - `step` — step en el que arranca (0-based)
  - `midi` — número MIDI (60 = C4, 69 = A4 = 440 Hz, etc.)
  - `length` — duración en steps

- **`step@[m1,m2,...]:length`** — un acorde (varias notas MIDI simultáneas)
- **`midi:length`** o **`[m1,m2,...]:length`** — sin step explícito, auto-incrementa

Ejemplos:

```text
0@60:2           → MIDI 60 (C4) durante 2 steps, arrancando en step 0
2@67:4           → MIDI 67 (G4) durante 4 steps, arrancando en step 2
2@[60,64,67]:4   → acorde C-E-G arrancando en step 2 durante 4 steps
60:2 64:4 67:4   → mismas notas, pero steps auto-asignados 0/2/6
```

**Importante**: el servicio schedulea cada token en el step EXACTO que escribiste — no son secuenciales. Si querés que suenen uno tras otro, tenés que especificar steps crecientes.

Duración de step: **200 ms** por default (configurable vía `stepMs` en `playMidiSteps`). Eso da 100 BPM @ figuras de 1/16.

---

## `SequenceCacheService` — localStorage CRUD

Cache editable de secuencias en `localStorage`. La UI del `<lib-piano-page>` lo usa para el bloque "Guardar secuencia", pero también podés usarlo programáticamente.

```ts
import { inject } from '@angular/core';
import { SequenceCacheService, isValidSequence, CachedSequence } from 'ngx-piano';

const cache = inject(SequenceCacheService);

// Validar antes de guardar
if (isValidSequence('0@60:2 4@64:4')) {
  const item = cache.add('0@60:2 4@64:4', 'Mi melodía'); // → CachedSequence | null
}

// Listar (ordenado por createdAt desc)
const all: CachedSequence[] = cache.list();

cache.remove(item.id);
```

Storage key: `piano-sequence-cache-v1`. Maneja errores de quota / `localStorage` deshabilitado silenciosamente (estado en memoria sigue funcionando).

---

## Tailwind en el consumidor

Los componentes del piano usan clases Tailwind (`bg-slate-900`, `bg-emerald-500`, `rounded-xl`, etc.). Para que el consumidor las compile, agregá la ruta del FESM en `content`:

```js
// tailwind.config.js del consumidor
module.exports = {
  content: [
    './src/**/*.{html,ts}',
    './node_modules/ngx-piano/fesm2022/**/*.mjs',  // ← clave
  ],
};
```

Si usás Tailwind v4, ajustá el `content` según corresponda (`@source` directive).

---

## Flujo de publicación

Cuando hagas cambios en el código del piano:

```bash
# 1. Compilar la librería
npm run build:lib

# 2. Empaquetar como tarball
npm pack dist/ngx-piano --pack-destination .
mv ngx-piano-0.0.1.tgz ngx-piano-X.Y.Z.tgz

# 3. Bumpear la versión en projects/ngx-piano/package.json

# 4. Commit + tag + push (incluyendo dist/ngx-piano/ commiteado)
git add -A
git commit -m "feat: nuevos cambios del piano"
git tag vX.Y.Z
git push origin main --tags

# 5. Crear release en GitHub y subir el tarball como asset
#    https://github.com/dev1-tecnosystem/ngx-piano/releases/new
```

En cada consumidor:

```bash
# Bumpear la URL en package.json y reinstalar
npm install
```

---

## Compatibilidad

- Angular 17+ (los componentes son standalone, pero `PianoModule` exporta un NgModule para consumidores clásicos).
- Web Audio API (todos los navegadores modernos).
- Requiere gesto del usuario para la primera reproducción (política de autoplay del navegador).