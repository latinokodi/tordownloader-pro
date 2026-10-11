/**
 * Autenticación contra Jellyfin.
 *
 * Jellyfin 12 (2026-09-08) retiró las formas antiguas de identificarse: tanto la
 * cabecera `X-Emby-Token` como la clave en la URL (`?api_key=…`) devuelven 401.
 * Con Jellyfin 12.1.0 en el servidor de casa, el listado de la biblioteca y el
 * refresco posterior a una descarga fallaban en silencio: la app recibía 401 y
 * se quedaba sin pósters ni refresco.
 *
 * La forma que sigue valiendo —también en 10.11— es la cabecera Authorization
 * con el esquema MediaBrowser. Se manda además la antigua: el servidor usa la
 * que entiende, así que la app funciona igual contra un 10.11 sin actualizar.
 */

export function jellyfinAuthHeaders(key: string): Record<string, string> {
  const k = (key || '').trim()
  if (!k) return {}
  return {
    Authorization: `MediaBrowser Token="${k}"`,
    'X-Emby-Token': k,
  }
}

/** URL base sin barra final (el usuario suele dejarla puesta). */
export function jellyfinBase(url: string): string {
  return (url || '').trim().replace(/\/+$/, '')
}

/**
 * Ruta del listado de la biblioteca. La clave va en la cabecera, nunca aquí:
 * Jellyfin 12 ignora —y rechaza— la clave en la URL.
 */
export function jellyfinLibraryPath(): string {
  return '/Items?Recursive=true&IncludeItemTypes=Movie,Series&Fields=Path'
}

/** Ruta del póster de un elemento, también sin la clave. */
export function jellyfinPosterPath(itemId: string, tag: string, maxHeight = 450): string {
  const t = tag ? `&tag=${encodeURIComponent(tag)}` : ''
  return `/Items/${itemId}/Images/Primary?maxHeight=${maxHeight}&quality=90${t}`
}
