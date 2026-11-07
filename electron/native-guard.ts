// native-guard.ts — traducir el fallo de un módulo nativo a algo accionable.
//
// `better-sqlite3` se compila contra la ABI de UN runtime concreto. Si el usuario
// instala con una versión de Node y ejecuta con otra (o con Electron, que lleva su
// propia ABI), el módulo no carga y lo que veía era:
//
//   The module '...better_sqlite3.node' was compiled against a different Node.js
//   version using NODE_MODULE_VERSION 127...  →  [FATAL] Cannot read properties of
//   undefined (reading 'prepare')
//
// Ese mensaje final no dice nada útil. Aquí se reconoce el caso y se devuelve el
// comando exacto que lo arregla, antes de que la app intente usar la base.

export type NativeProblema = 'ok' | 'abi' | 'no-compilado' | 'sin-instalar' | 'otro'

export interface NativeDiagnostico {
  problema: NativeProblema
  /** Qué pasó, en una línea. */
  detalle: string
  /** Comando que lo arregla (vacío si no hay problema). */
  arreglo: string
  /** Valores del choque de ABI, si se pudieron leer. */
  abi?: { compilado: string; requerido: string }
}

const REGEX_ABI = /compiled against a different Node\.js version using NODE_MODULE_VERSION (\d+)[^]*?requires NODE_MODULE_VERSION (\d+)/i
const REGEX_ABI_CORTO = /NODE_MODULE_VERSION (\d+)[^]*NODE_MODULE_VERSION (\d+)/i
const REGEX_NO_INSTALADO = /Cannot find module '?better-sqlite3'?/i
const REGEX_NO_COMPILADO = /Could not locate the bindings file|bindings file not found|better_sqlite3\.node|No such file or directory.*\.node/i

/**
 * Decide qué hacer con un error al cargar `better-sqlite3`.
 * `electron` es la versión de Electron si se está ejecutando dentro de la app de
 * escritorio (process.versions.electron); sin ella se asume Node a secas.
 */
export function diagnoseNativeError(err: unknown, electron?: string): NativeDiagnostico {
  const msg = err instanceof Error ? err.message : String((err as any)?.message ?? err ?? '')
  const pila = err instanceof Error ? String(err.stack || '') : ''
  const texto = `${msg}\n${pila}`

  const abi = REGEX_ABI.exec(texto) || REGEX_ABI_CORTO.exec(texto)
  if (abi) {
    return {
      problema: 'abi',
      detalle:
        `better-sqlite3 está compilado para Node ABI ${abi[1]} y este runtime necesita ABI ${abi[2]}` +
        (electron ? ` (Electron ${electron})` : ''),
      arreglo: electron ? 'npx @electron/rebuild -f -w better-sqlite3' : 'npm rebuild better-sqlite3',
      abi: { compilado: abi[1], requerido: abi[2] },
    }
  }
  if (REGEX_NO_INSTALADO.test(texto)) {
    return { problema: 'sin-instalar', detalle: 'las dependencias no están instaladas', arreglo: 'npm install' }
  }
  if (REGEX_NO_COMPILADO.test(texto)) {
    return {
      problema: 'no-compilado',
      detalle: 'el binario de better-sqlite3 no existe (instalación a medias o copiada de otro equipo)',
      arreglo: electron ? 'npx @electron/rebuild -f -w better-sqlite3' : 'npm rebuild better-sqlite3',
    }
  }
  return { problema: 'otro', detalle: msg || 'error desconocido al cargar better-sqlite3', arreglo: 'npm rebuild better-sqlite3' }
}

/** Mensaje listo para imprimir en consola, con el comando y el porqué. */
export function nativeHelp(d: NativeDiagnostico): string {
  if (d.problema === 'ok') return ''
  const lineas = [
    '',
    '  [MediaPilot] No se pudo abrir la base de datos.',
    `  Causa: ${d.detalle}.`,
    `  Arréglalo con:  ${d.arreglo}`,
  ]
  if (d.problema === 'abi') {
    lineas.push(
      '  Pasa cuando se instalan las dependencias con una versión de Node y luego se',
      '  ejecuta con otra (o con Electron). También si la carpeta vive en OneDrive y',
      '  los binarios llegan sincronizados desde otro equipo.',
    )
  }
  lineas.push('', '  Después vuelve a arrancar start.bat (o `npm run server`).', '')
  return lineas.join('\n')
}

/**
 * Carga better-sqlite3 o aborta con un mensaje que se puede seguir. Se hace con
 * `require` en tiempo de ejecución (y no con un import arriba del archivo) para
 * que el fallo ocurra aquí, donde hay contexto, y no como excepción sin capturar
 * seguida de "Cannot read properties of undefined (reading 'prepare')".
 */
export function loadBetterSqlite3(): any {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('better-sqlite3')
  } catch (e) {
    const electron = (process as any)?.versions?.electron
    const d = diagnoseNativeError(e, electron)
    console.error(nativeHelp(d))
    process.exit(1)
  }
}
