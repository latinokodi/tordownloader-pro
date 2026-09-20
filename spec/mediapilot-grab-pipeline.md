# Spec: MediaPilot — pipeline de descarga (grab → descarga → biblioteca)

> Método: **SDD → BDD → TDD**. Este documento manda: si el comportamiento y el
> código discrepan, gana el spec (o se cambia el spec a propósito, nunca a
> escondidas).
> Skills del *skills folder* usadas como método:
> `skills/spec-driven-development` (addyosmani/agent-skills),
> `skills/tdd` (mattpocock/skills), `skills/cucumber-skill` (LambdaTest/agent-skills).

## 1. Objective

Que MediaPilot descargue y coloque episodios/películas **sin intervención**, y
que cualquier fallo de catalogación (episodio de otra serie, archivo en la
carpeta equivocada, dos copias del mismo episodio, falta de subtítulos) se
detecte **dentro de la app** y no en la biblioteca.

Historias de usuario:

1. Como usuario quiero que un capítulo recién emitido llegue el mismo día, y que
   las temporadas antiguas se bajen **en orden** hasta completar la serie.
2. Como usuario quiero que un release de **otra serie homónima o spin-off** nunca
   acabe en mi biblioteca (ni descargado).
3. Como usuario quiero **una sola versión por episodio**, con latino si existe y
   fallback a inglés, y que la versión latina reemplace a la inglesa.
4. Como usuario quiero que todo quede en la estructura que Jellyfin entiende, sin
   tocar nada a mano.
5. Como usuario quiero subtítulos en español e inglés siempre que existan.

## 2. Tech stack

- Electron refactorizado a servidor headless: `electron/server.ts` (router HTTP),
  `worker.ts` (descargas locales), `monitor.ts` (cola y watchlist),
  `grabber.ts` (búsqueda/elección/preflight), `media-layout.ts` (rutas y títulos),
  `library-heal.ts` (consistencia de biblioteca), `preflight.ts` (validación
  barata), `db.ts` (SQLite), motores Python (`*-providers.py`, `meta-search.py`,
  `subtitles.py`), `tmdb-provider.py`.
- Debrid: TorBox (principal) / Real-Debrid.
- Frontend: React + Vite (solo consume la API).
- Bibliotecas: `/srv/storage/arr-data/media/{movies,tv}` (Jellyfin).

## 3. Commands

```
# Servicio
systemctl --user restart tordownloader.service
curl -s http://127.0.0.1:9650/api/version

# Typecheck (fuentes electron; el tsc del proyecto falla por artefactos de composite)
npx tsc --noEmit --target ES2020 --module ESNext --moduleResolution bundler \
  --strict --esModuleInterop --skipLibCheck --resolveJsonModule \
  --lib ES2020,DOM,DOM.Iterable electron/*.ts

# Spec ejecutable (BDD) — RED/GREEN
npm run spec

# Build + despliegue (server bundle + frontend + reinicio)
npx esbuild electron/server.ts --bundle --platform=node --format=cjs \
  --outfile=dist-electron/server.cjs --external:electron --external:better-sqlite3
npx vite build
systemctl --user restart tordownloader.service

# Auditoría de estructura (fuera de la app)
python3 scripts/audit-tv-layout.py /srv/storage/arr-data/media/tv
```

## 4. Project structure

```
electron/          # lógica de la app (TS + motores Python)
spec/              # SDD: este spec + features BDD + runner ejecutable
  features/        #   escenarios Gherkin (comportamiento observable)
  support/         #   parser de Gherkin, definiciones de pasos, runner
scripts/           # utilidades operativas (auditoría de biblioteca, etc.)
dist-electron/     # bundles generados (server.cjs, spec.cjs) — no versionado
```

## 5. Código y estilo

Un solo camino de verdad por responsabilidad; los módulos exportan funciones
puras cuando el comportamiento es una decisión (comparadores, validadores) para
poder probarlas sin arrancar el servicio. Ejemplo:

```ts
/** ¿El release usa solo la parte FINAL del título? ("Strange New Worlds") */
const isTailOfTitle = (tokens: string[]): boolean => {
  if (series.length < 2 || series.length >= tokens.length) return false
  const offset = tokens.length - series.length
  return series.every((t, i) => tokens[offset + i] === t)
}
```

Reglas: comentarios en español explicando **por qué** (no qué); nada de
duplicar la lógica del grabber en el worker; toda decisión destructiva
(borrar/mover) registrada en el log con el motivo.

## 6. Testing strategy

- **BDD (Gherkin)**: `spec/features/*.feature` describe comportamiento
  observable en términos de la app, no de funciones internas.
- **TDD**: cada escenario se escribe primero (RED), luego se implementa lo mínimo
  (GREEN), luego se limpia (REFACTOR). Rodajas verticales: un escenario → un
  cambio; nunca "todos los tests y luego todo el código".
- **Ejecutable**: `npm run spec` bundlea `spec/support/run.ts` con esbuild y lo
  corre en Node contra los **módulos reales** (integración, sin mocks de las
  funciones de dominio). Los escenarios que necesitan red/TMDB se etiquetan
  `@network`; los que necesitan el servicio en marcha, `@manual` (documentados y
  verificados a mano, no automatizados).
- Niveles: unitario puro (validadores, orden, comparación de duración) →
  integración con FS real en directorios temporales (layout, consolidación) →
  integración con APIs reales etiquetada `@network` (preflight contra TorBox,
  resolución de carpetas con TMDB) → operativo (`@manual`: logs y estado del
  servicio).
- Nada de tests que dependan del estado de la biblioteca real: se usan sandboxes
  en `/tmp` y se restauran las filas tocadas de `media_folders`.

## 7. Boundaries

- **Siempre**: escribir el escenario antes del arreglo; `npm run spec` y
  typecheck antes de commitear; registrar en el log todo movimiento/borrado;
  verificar desplegando (bundle + restart) y leyendo logs reales.
- **Preguntar antes**: cambiar el esquema de la BD de forma destructiva, tocar el
  frontend que el usuario tiene sin commitear, borrar medios en lote, cambiar
  ajustes globales (tope de concurrencia, intervalo, alcance de backfill).
- **Nunca**: aceptar un release solo porque su nombre *contiene* el título;
  sobrescribir un archivo al recolocar; descargar para luego borrar lo que se
  podía rechazar antes; dejar duplicados del mismo episodio; tocar la biblioteca
  real en un test.

## 8. Behaviors (contrato)

### B1 · Aceptación del nombre del release
Un release pertenece al objetivo si, tras quitar corchetes, año, SxxEyy (o `8x05`)
y etiquetas de calidad, sus tokens (sin artículos, sin acentos) **son** el título
o un **título alternativo** de TMDB, o son la **parte final** del título
(franquicia omitida). Contener el título no basta.
- Rechaza: `Standoff.The.FBI.Power.and.Paranoia.…`, `FBI International …`,
  `FBI True …`, `FBI Most Wanted …`, `Star Trek Discovery …`.
- Acepta: `FBI S08E01 …`, `Chicago PD …` con título `Chicago P.D. …`,
  `Strange New Worlds …` con título `Star Trek: Strange New Worlds`,
  `Special Ops Lioness …` con alt title `Special Ops: Lioness`.
- Si el release es latino (se busca por IMDB) la comprobación no rechaza: solo
  penaliza, porque el título viene localizado.

### B2 · Preflight antes de descargar
- Si la caché del debrid dice que el torrent no trae ningún archivo de video →
  se descarta y se manda a la lista negra **sin añadirlo**.
- Si el video más grande dura fuera de `max(4 min, 10%)` (episodios) o
  `max(8 min, 15%)` (películas) de lo esperado → se descarta, se borra el
  torrent remoto + la fila local y se prueba el siguiente candidato en la misma
  pasada.
- Sin runtime esperado, sin enlace o con contenedor sin duración → **no bloquea**
  (inconcluso).

### B3 · Orden de la cola (backfill)
- Primero lo recién emitido (posterior a la fecha en que se añadió el título),
  lo más nuevo primero.
- Después el resto **en orden ascendente** (S01E01 → S01E02 → … → S08E24).
- Nada ya descargado (archivo real en disco) vuelve a la cola.

### B4 · Concurrencia
El único limitador de los episodios ya emitidos es `max_concurrent_downloads`
(por defecto 3): la cola encola mientras haya hueco y el worker no arranca más
descargas que ese número. El intervalo del monitor (30 min) no limita el backfill.

### B5 · Estructura para Jellyfin
- Series: `<serie>/Season N/<video>`; películas: `<Película (Año)>/<video>`.
- Se recoloca solo: video suelto en la raíz de la serie → su temporada;
  subcarpetas dentro de una temporada → se aplanan; temporadas vacías → se
  borran; en películas, subcarpetas → se aplanan y videos sueltos en la raíz →
  su carpeta.
- Nunca sobrescribe; si el destino ya tiene ese nombre se informa y no se toca.
- Idempotente: en una biblioteca correcta no mueve nada.

### B6 · Una sola versión por episodio
Cuando aparece la versión latina de un episodio que ya estaba en inglés, el
archivo inglés se borra **después** de que la latina esté completa en disco, y
solo tras confirmación del usuario.

### B7 · Subtítulos
Tras cada descarga local, se piden subtítulos spa + en al URL de Stremio
(`https://opensubtitles-v3.strem.io/subtitles`) usando el **imdb_id real** de la
fila del grab; los fallos se registran y nunca rompen la descarga.

### B8 · Sin carpetas duplicadas del mismo título
El título que publica TMDB puede cambiar: las carpetas existentes se emparejan
por tokens (ignorando artículos y orden) y, entre varias del mismo título, se
elige la que más contenido tiene. El cambio de título no crea carpeta nueva. Los
duplicados existentes se consolidan (videos + sus `.srt`), y `media_folders` se
corrige solo.

### B9 · Adopción de lo que el debrid ya tiene (reconciliación)
La app y el debrid se desincronizan: filas borradas a mano, reinicios, añadidos
desde otro cliente. Quedan torrents **ya listos** en la cuenta (cacheados) que la
app no baja porque no tiene fila — y en cooldown del debrid son lo ÚNICO que se
puede bajar.
- Al reconciliar, se adopta (fila local + cola de descarga) todo torrent del
  debrid que: corresponde a un título **monitorizado** (mismo comparador de
  nombres de B1, con títulos alternativos), trae marcador de episodio, **no** está
  ya en la biblioteca y no supera el tope de tamaño del tipo.
- Nunca se adopta: lo que ya tiene fila local, los **packs** de temporada/colección
  (sin `SxxEyy`), lo que no es de un título monitorizado (spin-offs, WWE, contenido
  ajeno), lo que ya está en disco, ni lo que supera el tope.
- Prioridad: primero lo que ya está listo (`cached`/`completed`), después lo que el
  debrid aún está bajando (`downloading`/`metadl`); dentro de cada grupo, orden
  ascendente de temporada/episodio. Los estados sin contenido (`checking`) se
  descartan hasta que el debrid tenga algo.
- La carpeta destino de lo adoptado se calcula **desde el título emparejado** (tmdb
  id y año del título monitorizado), nunca desde el nombre del torrent: hay
  releases cuyo nombre es un fichero en minúsculas
  (`fbi.s07e20.1080p.web.h264-successfulcrab[EZTVx.to].mkv`) y de ahí salía una
  carpeta fantasma (`fbi s07e20 web successfulcrab mkv/Season 1`) con el episodio
  dentro. El marcador `sxxeyy` se reconoce sin importar mayúsculas.
- Se ejecuta al arrancar el servicio, cada 15 min desde el monitor, y a mano con
  `POST /api/debrid/reconcile`. Respeta `max_concurrent_downloads` al bajar (el
  tope lo aplica el worker) y registra el resumen con el motivo de cada descarte.

## 9. Success criteria (verificables)

1. `npm run spec` en verde, con escenarios que cubren B1–B5, B8 y B9.
2. `POST /api/library/heal` sobre la biblioteca real devuelve `changed:false`.
3. `scripts/audit-tv-layout.py` → 0 problemas; sin episodios duplicados.
4. Logs reales muestran: `cola: N episodio(s) encolado(s) — 3/3 en curso`,
   `✗ descartado antes de añadirlo …`, `✓ preflight OK — X min (esperado Y min)`,
   `[Subs] …: OK: 2 subtítulos descargados`.
5. Un release de otra serie (spin-off/docuserie) no aparece nunca en la cola.

## 10. Open questions

- ¿Se automatiza el escenario de concurrencia (B4) con el servicio en marcha
  (@manual hoy)? Requiere aislar el worker o inyectar un doble del debrid.
- ¿Conviene guardar el runtime esperado en `grab_history` además de en
  `downloads`, para auditar rechazos antiguos?
