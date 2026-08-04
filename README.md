<p align="center">
  <img src="build/icon.ico" width="96" alt="TorDownloader PRO" />
</p>

<h1 align="center">TorDownloader PRO</h1>
<p align="center"><strong>Cliente premium de TorBox y Real-Debrid con metabúsqueda y catálogo integrado</strong></p>

<p align="center">
  <img src="https://img.shields.io/badge/plataforma-Windows%20x64-blue?style=flat-square" />
  <img src="https://img.shields.io/badge/versi%C3%B3n-1.0.14-darkgreen?style=flat-square" />
  <img src="https://img.shields.io/badge/licencia-MIT-yellow?style=flat-square" />
</p>

---

## Características

- **Metabúsqueda integrada** — 17 motores de búsqueda funcionando simultáneamente. Sin Docker, sin Jackett, sin configuración.
- **TorBox + Real-Debrid** — Soporte para ambos servicios débrid. Autenticación OAuth. Selección de archivos RD.
- **Discover** — Catálogo TMDB con exploración de películas y series. Búsqueda automática en proveedores latinos.
- **Actualizaciones automáticas** — La app se actualiza sola desde GitHub Releases. Notificación, descarga y reinicio sin reinstalar.
- **Descargas locales** — Monitoreo en tiempo real del progreso, velocidad y ETA. Descargas directas a tu PC.
- **FlareSolverr integrado** — Se descarga e instala automáticamente. Reinicio manual desde la barra lateral si se atasca.
- **Modo oscuro profesional** — Interfaz diseñada para uso intensivo, tipografía monoespaciada y esquema de color oscuro.
- **Internacionalización** — Español latinoamericano e inglés. Cambio instantáneo desde la barra lateral.

---

## Instalación

1. Descarga el instalador desde [Releases](https://github.com/latinokodi/tordownloader-pro/releases)
2. Ejecuta `TorDownloader-PRO-Setup-x.x.x.exe`
3. En Configuración, vincula tu cuenta TorBox o Real-Debrid
4. Para Discover, ingresa tu TMDB API Key (gratis en themoviedb.org)

**Requisitos:** Windows 10 o superior (x64). No requiere Python, Java, Docker ni dependencias externas.

---

## Uso

### Búsqueda
Escribe y presiona Enter. Resultados de 17 motores con título, tamaño, seeders, indexer y enlace.

### Discover
Explora el catálogo TMDB, selecciona una película o serie, elige temporada y episodio. La app busca automáticamente en proveedores de contenido latino.

### Descargas
Las descargas muestran progreso en tiempo real: estado en la nube (TorBox/RD) y descarga local con velocidad y ETA.

### Configuración
- Vincular TorBox o Real-Debrid vía OAuth
- Carpeta de destino
- TMDB API Key para Discover
- Auto-eliminar completados
- Buscar actualizaciones de la app
- Probar motores de búsqueda
- Idioma (ES / EN)

---

## Tecnología

| Componente | Tecnología |
|---|---|
| Frontend | React 18 + TypeScript + Tailwind CSS |
| Backend | Electron + Node.js |
| Metabúsqueda | Python (PyInstaller .exe) + qBittorrent plugins |
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

**TorDownloader PRO es una herramienta de búsqueda y gestión de descargas.** No aloja, almacena ni distribuye contenido protegido por derechos de autor. Los resultados provienen de motores públicos de terceros. El usuario es responsable del cumplimiento de las leyes de su jurisdicción.

---

## Licencia

MIT © 2025 — [latinokodi](https://github.com/latinokodi)
