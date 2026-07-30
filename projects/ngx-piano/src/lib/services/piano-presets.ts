import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

/**
 * Cada preset es un string en el formato MIDI:step que usa el piano roll.
 *
 *   `step@midi:length`     — una nota
 *   `step@[m1,m2,...]:length` — un acorde
 *   `midi:length`          — nota sin step explícito (auto-incrementa)
 *
 * El servicio schedulea cada token en el step EXACTO que escribiste —
 * no son secuenciales. Si querés que suenen uno tras otro, especificá
 * steps crecientes.
 *
 * Duración de step: 200ms por default (configurable vía `stepMs`).
 *
 * ---
 *
 * **Cómo personalizar los presets SIN tocar la librería:**
 *
 * 1. En el consumidor, creá `src/assets/piano-presets.json` con tu propio
 *    set de presets. Mismo formato: `{ "nombre": "0@60:2 4@64:4" }`.
 *    Podés sobrescribir los defaults, agregar nuevos o dejar solo los
 *    que te interesen.
 *
 * 2. Asegurate de que `HttpClient` esté disponible en tu app
 *    (`provideHttpClient()` en `app.config.ts`).
 *
 * 3. Nada más. Los presets se cargan al inicializar el servicio y se
 *    mezclan con los defaults (tu JSON gana si hay claves duplicadas).
 *
 * Ejemplo de `src/assets/piano-presets.json`:
 * ```json
 * {
 *   "wakeup":  "0@60:4 4@64:4 8@67:4 12@72:8",
 *   "alertar": "0@67:1 1@72:1 2@76:4",
 *   "intro":   "0@[60,64,67]:8 8@72:8 16@[60,64,67,72]:8"
 * }
 * ```
 *
 * Si el JSON no existe o falla la carga, se usan los defaults de abajo.
 */
export const PIANO_PRESETS_DEFAULT: Readonly<Record<string, string>> = Object.freeze({
  // C-E-G major arpeggio ascending.
  success:
    '2@64:1 4@68:1 5@71:1',

  // Slow descending lullaby over a held low chord.
  gentle:
    '0@[36,43]:12 0@76:4 4@74:4 8@72:6 12@71:4 16@72:4 20@[36,43,55,60]:10',

  // Cascading up-and-back arpeggio ending on a held chord.
  flow:
    '0@72:4 4@76:4 8@79:4 12@83:4 16@81:4 20@79:4 24@76:4 28@72:4 32@[48,67,76]:10',

  // Three short attention notes (G4, C5, E5).
  alert: '0@67:3 3@72:3 6@76:5',

  // Bouncy dance riff — bass note + chord on the off-beat.
  bounce:
    '0@60:2 2@[60,64,67]:1 3@60:2 5@[60,64,67]:1 6@60:2 8@[60,64,67]:1 9@60:2 11@[60,64,67]:1',

  // Two chimes in the C5–E5 range.
  chime: '3@72:1 5@79:3',

  // Test 1 — sparse, overlapping notes.
  test:
    '2@75:1 2@67:2 5@72:1 7@74:1 8@67:5 11@74:1 14@74:1 15@74:1 15@64:1',

  // Test 2 — bass + melody with shared steps.
  test2:
    '2@67:1 2@62:4 4@70:2 7@67:1 8@74:1 10@65:1 12@72:1 12@63:1 15@64:1',
});

/**
 * Ruta por defecto donde la lib busca `piano-presets.json` en el consumidor.
 * Si querés otra ruta, overrideá `PRESETS_URL` antes de inyectar el servicio
 * (o cambiá el valor acá para tu app).
 */
export const PRESETS_URL = 'assets/piano-presets.json';

/**
 * Servicio que carga presets desde `assets/piano-presets.json` del consumidor
 * y los expone como un `Record<string, string>`. Si el JSON no existe, falla
 * la red o está mal formado, devuelve los defaults de la lib.
 *
 * Cualquier consumidor puede agregar presets nuevos creando ese JSON — sin
 * recompilar la lib ni tocar TypeScript.
 */
@Injectable({ providedIn: 'root' })
export class PianoPresetsService {
  private http = inject(HttpClient);
  private cache: Readonly<Record<string, string>> | null = null;

  /**
   * Devuelve todos los presets (defaults + override del consumidor).
   * Hace una sola request HTTP; los siguientes llamados usan el cache.
   */
  async loadAll(): Promise<Readonly<Record<string, string>>> {
    if (this.cache) return this.cache;
    try {
      const remote = await firstValueFrom(
        this.http.get<Record<string, string>>(PRESETS_URL),
      );
      if (remote && typeof remote === 'object') {
        this.cache = Object.freeze({ ...PIANO_PRESETS_DEFAULT, ...remote });
      } else {
        this.cache = PIANO_PRESETS_DEFAULT;
      }
    } catch {
      // JSON no existe, 404, CORS, etc. → defaults.
      this.cache = PIANO_PRESETS_DEFAULT;
    }
    return this.cache;
  }

  /**
   * Versión síncrona. Útil después de que `loadAll()` se haya resuelto al
   * menos una vez. Si nunca se cargó, devuelve los defaults.
   */
  getAll(): Readonly<Record<string, string>> {
    return this.cache ?? PIANO_PRESETS_DEFAULT;
  }

  /**
   * Devuelve el texto de un preset por nombre. Si no existe, devuelve null.
   * Útil para el `PianoPageComponent` que muestra tarjetas por preset.
   */
  get(name: string): string | null {
    return this.getAll()[name] ?? null;
  }

  /**
   * Lista de nombres de presets (claves del Record).
   */
  keys(): string[] {
    return Object.keys(this.getAll());
  }
}

/**
 * Mantengo el export `PianoPresets` por compatibilidad con código previo
 * que lo consuma como objeto literal. Devuelve los defaults sincrónicamente.
 * Para los presets que el consumidor haya sobreescrito vía JSON, usá
 * `PianoPresetsService.get(name)` en su lugar.
 *
 * @deprecated Usa `PianoPresetsService.get()` / `getAll()` para acceder
 * a los presets (incluye los del JSON del consumidor).
 */
export const PianoPresets: Readonly<Record<string, string>> = PIANO_PRESETS_DEFAULT;

export type PianoPresetKey = keyof typeof PIANO_PRESETS_DEFAULT;