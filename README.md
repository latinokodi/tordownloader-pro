<p align="center">
  <img src="build/icon.ico" width="96" alt="TorDownloader PRO" />
</p>

<h1 align="center">TorDownloader PRO</h1>
<p align="center"><strong>Cliente premium de TorBox y Real-Debrid con metabúsqueda y catálogo integrado</strong></p>

<p align="center">
  <img src="https://img.shields.io/badge/plataforma-Windows%20x64-blue?style=flat-square" />
  <img src="https://img.shields.io/badge/versi%C3%B3n-1.0.13-darkgreen?style=flat-square" />
  <img src="https://img.shields.io/badge/licencia-MIT-yellow?style=flat-square" />
</p>

---

## Caracteristicas

- **Metabusqueda integrada** — 17 motores de busqueda funcionando simultaneamente. Sin Docker, sin Jackett, sin configuracion.
- **TorBox + Real-Debrid** — Soporte para ambos servicios debrid. Autenticacion OAuth. Seleccion de archivos RD.
- **Discover** — Catalogo TMDB con exploracion de peliculas y series. Busqueda automatica en proveedores latinos.
- **Actualizaciones automaticas** — La app se actualiza sola desde GitHub Releases. Notificacion, descarga y reinicio sin reinstalar.
- **Descargas locales** — Monitoreo en tiempo real del progreso, velocidad y ETA. Descargas directas a tu PC.
- **FlareSolverr integrado** — Se descarga e instala automaticamente. Reinicio manual desde la barra lateral si se atasca.
- **Modo oscuro profesional** — Interfaz disenada para uso intensivo, tipografia monoespaciada y esquema de color oscuro.
- **Internacionalizacion** — Espanol latinoamericano e ingles. Cambio instantaneo desde la barra lateral.

---

## Instalacion

1. Descarga el instalador desde [Releases](https://github.com/latinokodi/tordownloader-pro/releases)
2. Ejecuta `TorDownloader-PRO-Setup-x.x.x.exe`
3. En Configuracion, vincula tu cuenta TorBox o Real-Debrid
4. Para Discover, ingresa tu TMDB API Key (gratis en themoviedb.org)

**Requisitos:** Windows 10 o superior (x64). No requiere Python, Java, Docker ni dependencias externas.

---

## Uso

### Busqueda
Escribe y presiona Enter. Resultados de 17 motores con titulo, tamano, seeders, indexer y enlace.

### Discover
Explora el catalogo TMDB, selecciona una pelicula o serie, elige temporada y episodio. La app busca automaticamente en proveedores de contenido latino.

### Descargas
Las descargas muestran progreso en tiempo real: estado en la nube (TorBox/RD) y descarga local con velocidad y ETA.

### Configuracion
- Vincular TorBox o Real-Debrid via OAuth
- Carpeta de destino
- TMDB API Key para Discover
- Auto-eliminar completados
- Buscar actualizaciones de la app
- Probar motores de busqueda
- Idioma (ES / EN)

---

## Tecnologia

| Componente | Tecnologia |
|---|---|
| Frontend | React 18 + TypeScript + Tailwind CSS |
| Backend | Electron + Node.js |
| Metabusqueda | Python (PyInstaller .exe) + qBittorrent plugins |
| Base de datos | SQLite (better-sqlite3) |
| Bypass CF | FlareSolverr (auto-descargable) |
| Actualizaciones | electron-updater + GitHub Releases |
| Empaquetado | electron-builder (NSIS) |
| CI/CD | GitHub Actions |
| Tests | Vitest |

---

## Desarrollo

```bash
git clone https://github.com/latinokodi/tordownloader-pro.git
cd tordownloader-pro
npm install
npm run dev       # modo desarrollo
npm test          # ejecutar tests
npm run dist      # generar instalador
```

---

## Descargo de responsabilidad

**TorDownloader PRO es una herramienta de busqueda y gestion de descargas.** No aloja, almacena ni distribuye contenido protegido por derechos de autor. Los resultados provienen de motores publicos de terceros. El usuario es responsable del cumplimiento de las leyes de su jurisdiccion.

---

## Licencia

MIT © 2025 — [latinokodi](https://github.com/latinokodi)
