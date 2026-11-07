@echo off
setlocal
cd /d "%~dp0"
title MediaPilot

set "SOLO_COMPROBAR="
if /i "%~1"=="check" set "SOLO_COMPROBAR=1"

echo.
echo   MediaPilot
echo   ==========
echo.
if defined SOLO_COMPROBAR echo   Modo comprobacion: solo revisa las dependencias.
echo.

echo %CD% | find /i "OneDrive" >nul
if not errorlevel 1 (
  echo   [i] La carpeta del proyecto esta dentro de OneDrive. Si la app falla al
  echo       abrir la base de datos, muevela a una ruta local como C:\MediaPilot.
  echo.
)

:: ── 1/4 · Node.js ────────────────────────────────────────────────────────────
echo   [1/4] Node.js
call :hay node
if not errorlevel 1 goto node_ok
echo         no esta instalado.
call :instalar "OpenJS.NodeJS.LTS" "Node.js LTS"
call :refrescar_path
call :hay node
if errorlevel 1 (
  echo.
  echo   [!] No se pudo instalar Node.js automaticamente.
  echo       Descargalo de https://nodejs.org ^(version LTS^) y vuelve a ejecutar este archivo.
  echo.
  pause
  exit /b 1
)
:node_ok
for /f "delims=" %%v in ('node --version 2^>nul') do echo         instalado: %%v

:: ── 2/4 · Python ─────────────────────────────────────────────────────────────
echo   [2/4] Python
call :python_ok
if not errorlevel 1 goto py_ok
echo         no esta instalado.
call :instalar "Python.Python.3.12" "Python 3.12"
call :refrescar_path
call :python_ok
if not errorlevel 1 goto py_ok
echo.
echo   [!] Sin Python no funciona la busqueda de titulos.
echo       Descargalo de https://www.python.org/downloads y vuelve a ejecutar este archivo.
echo.
pause
exit /b 1
:py_ok
for /f "delims=" %%v in ('%PY% --version 2^>^&1') do echo         instalado: %%v
echo         instalando cloudscraper ^(busqueda anti-Cloudflare^)...
%PY% -m pip install --quiet cloudscraper

:: ── 3/4 · FFmpeg (opcional) ──────────────────────────────────────────────────
echo   [3/4] FFmpeg ^(opcional^)
call :hay ffmpeg
if not errorlevel 1 goto ffmpeg_fin
echo         no esta instalado. Se usa para ordenar las pistas de audio y para
echo         comprobar la duracion antes de descargar.
choice /c SN /n /m "         Instalarlo ahora con winget? [S/N] "
if errorlevel 2 goto ffmpeg_fin
call :instalar "Gyan.FFmpeg" "FFmpeg"
call :refrescar_path
call :hay ffmpeg
if errorlevel 1 (
  echo         [!] No se pudo instalar. La app funcionara, pero sin post-proceso.
  goto ffmpeg_fin
)
echo         instalado.
:ffmpeg_fin

:: ── 4/4 · La aplicacion ──────────────────────────────────────────────────────
echo   [4/4] MediaPilot
if defined SOLO_COMPROBAR goto solo_check

if not exist "node_modules" (
  echo         instalando dependencias ^(solo la primera vez, tarda unos minutos^)...
  call npm install
  if errorlevel 1 (
    echo.
    echo   [!] Fallo npm install. Revisa tu conexion y vuelve a intentarlo.
    pause
    exit /b 1
  )
) else (
  echo         dependencias: ya instaladas.
)

:: ── Comprobacion del modulo nativo ──────────────────────────────────────────
rem better-sqlite3 se compila contra la ABI de la version de Node con la que se
rem instalan las dependencias. Si el equipo usa otra (o los binarios llegan
rem sincronizados desde otro equipo por OneDrive), la app arranca pero la base
rem no abre y la pantalla se llena de "Error occurred in handler". Aqui se
rem detecta antes de arrancar y se recompila solo.
echo         comprobando la base de datos ^(better-sqlite3^)...
node -e "require('better-sqlite3')" >nul 2>&1
if not errorlevel 1 goto sqlite_ok
echo         no carga con este Node; recompilando...
call npm rebuild better-sqlite3 >nul 2>&1
node -e "require('better-sqlite3')" >nul 2>&1
if not errorlevel 1 goto sqlite_ok
echo.
echo   [!] La base de datos no se puede abrir en este equipo.
echo       Prueba a mano:  npm rebuild better-sqlite3
echo       Si sigue igual, borra la carpeta node_modules y vuelve a ejecutar
echo       este archivo.
echo.
echo       Evita tener el proyecto dentro de OneDrive: sincroniza los binarios
echo       de otro equipo y la base deja de cargar.
echo.
pause
exit /b 1
:sqlite_ok

echo         arrancando el servidor web...
echo         Abre http://127.0.0.1:9650 en tu navegador. Deja esta ventana abierta;
echo         para parar el servidor pulsa Ctrl+C.
echo.
rem Cierra una instancia previa del servidor (si la hay) para liberar el puerto.
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 9650 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"
call npm run server
echo.
echo   MediaPilot se ha cerrado.
pause
exit /b 0

:solo_check
echo.
echo   Todo listo. Ejecuta este archivo sin argumentos para arrancar la aplicacion.
echo.
pause
exit /b 0

:: ── Subrutinas ───────────────────────────────────────────────────────────────

:hay
where %~1 >nul 2>&1
exit /b %errorlevel%

:python_ok
rem Deja en PY el comando que funciona. Comprueba de verdad que responda: en
rem Windows 'python' puede ser el alias de la Store y no haber Python detras.
set "PY="
py -3 --version >nul 2>&1
if not errorlevel 1 set "PY=py -3"
if defined PY exit /b 0
python --version >nul 2>&1
if not errorlevel 1 set "PY=python"
if defined PY exit /b 0
exit /b 1

:instalar
rem %1 = id de winget · %2 = nombre para el mensaje
where winget >nul 2>&1
if errorlevel 1 (
  echo         [!] winget no esta disponible en este equipo: habria que instalarlo a mano.
  exit /b 1
)
echo         instalando con winget: %~2 ...
winget install -e --id %~1 --accept-source-agreements --accept-package-agreements --silent
exit /b %errorlevel%

:refrescar_path
rem winget actualiza el PATH del usuario, pero esta consola ya lo leyo al abrirse:
rem se vuelve a leer del registro para poder usar lo recien instalado sin cerrarla.
for /f "usebackq tokens=2,*" %%a in (`reg query "HKCU\Environment" /v Path 2^>nul`) do set "PATH_USUARIO=%%b"
if defined PATH_USUARIO set "PATH=%PATH_USUARIO%;%PATH%"
exit /b 0
