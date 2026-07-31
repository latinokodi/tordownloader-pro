<p align="center">
  <img src="build/icon.ico" width="96" alt="TorDownloader PRO" />
</p>

<h1 align="center">TorDownloader PRO</h1>
<p align="center"><strong>Cliente premium de TorBox con metabúsqueda integrada</strong></p>

<p align="center">
  <img src="https://img.shields.io/badge/plataforma-Windows%20x64-blue?style=flat-square" />
  <img src="https://img.shields.io/badge/versi%C3%B3n-1.0.6-darkgreen?style=flat-square" />
  <img src="https://img.shields.io/badge/licencia-MIT-yellow?style=flat-square" />
</p>

---

## Características

- **Metabúsqueda integrada** — 17 motores de búsqueda de torrents funcionando simultáneamente. Sin Docker, sin Jackett, sin configuración.
- **Integración TorBox** — Añade magnets y torrents a tu cuenta TorBox con un solo clic. Autenticación OAuth segura.
- **Descargas locales** — Monitoreo en tiempo real del progreso, velocidad y ETA. Descargas directas desde TorBox a tu PC.
- **Bypass Cloudflare** — FlareSolverr se descarga e instala automáticamente en el primer arranque. Transparente para el usuario.
- **Modo oscuro profesional** — Interfaz diseñada para uso intensivo, con tipografía monoespaciada y esquema de color oscuro.
- **Historial y control** — Gestiona todas tus descargas desde un panel unificado. Cancela, elimina o limpia completadas.
- **Internacionalización** — Español (latinoamericano) e inglés. Cambio instantáneo desde la barra lateral.

---

## Instalación

1. Descarga el instalador desde la sección [Releases](https://github.com/latinokodi/tordownloader-pro/releases)
2. Ejecuta `TorDownloader-PRO-Setup-x.x.x.exe`
3. Sigue el asistente de instalación
4. Al abrir la aplicación, vincula tu cuenta TorBox desde el panel de Configuración

**Requisitos:** Windows 10 o superior (x64). No requiere Python, Java, Docker ni dependencias externas.

---

## Uso

### Búsqueda
Escribe tu búsqueda en la barra superior y presiona Enter. Los resultados se agregan de todos los motores disponibles. Cada resultado muestra:
- Título
- Tamaño
- Seeders / Leechers
- Indexer (motor de origen)
- Enlace magnet / torrent

### Descargas
Haz clic en cualquier resultado para añadirlo a TorBox. El panel de Descargas muestra el progreso en tiempo real:
- **Estado TorBox** — Procesando, descargando, completado
- **Descarga local** — Progreso, velocidad, ETA, ruta de destino

### Configuración
Accede desde el icono de engranaje en la barra lateral:
- Vincular/desvincular cuenta TorBox
- Carpeta de destino para descargas locales
- Auto-eliminar torrents completados
- Probar motores de búsqueda
- Seleccionar idioma (ES / EN)

---

## Tecnología

| Componente | Tecnología |
|---|---|
| Frontend | React 18 + TypeScript + Tailwind CSS |
| Backend | Electron + Node.js |
| Metabúsqueda | Python (PyInstaller .exe) + qBittorrent plugins |
| Base de datos | SQLite (better-sqlite3) |
| Bypass CF | FlareSolverr (auto-descargable) |
| Empaquetado | electron-builder (NSIS) |
| CI/CD | GitHub Actions |

---

## Desarrollo

```bash
# Clonar
git clone https://github.com/latinokodi/tordownloader-pro.git
cd tordownloader-pro

# Instalar dependencias
npm install

# Ejecutar en modo desarrollo
start.bat
# o manualmente:
npm run dev
```

Para generar el instalador localmente:

```bash
npm run pyinstaller   # Construye qbit-runner.exe
npm run build         # Compila TypeScript + Vite
npm run dist          # Genera el instalador NSIS
```

---

## Descargo de responsabilidad

**TorDownloader PRO es una herramienta de búsqueda y gestión de descargas.** No aloja, almacena ni distribuye contenido protegido por derechos de autor. Los resultados de búsqueda provienen de motores públicos de terceros y el usuario es el único responsable del uso que haga de los mismos.

- Esta aplicación no infringe ninguna ley por sí misma. Es un cliente que interactúa con APIs públicas y motores de búsqueda de torrents.
- El usuario debe asegurarse de cumplir con las leyes de derechos de autor de su jurisdicción.
- TorDownloader PRO no elude medidas tecnológicas de protección (DRM) ni facilita la piratería.
- El uso de TorBox está sujeto a los términos y condiciones de [torbox.app](https://torbox.app).
- Los motores de búsqueda incluidos son plugins públicos del ecosistema qBittorrent, utilizados conforme a sus licencias originales.

**Al usar esta aplicación, aceptas que eres el único responsable de tu actividad y eximes a los desarrolladores de cualquier responsabilidad legal.**

---

## Licencia

MIT © 2025 — [latinokodi](https://github.com/latinokodi)
