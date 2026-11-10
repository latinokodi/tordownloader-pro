@echo off
setlocal
cd /d "%~dp0"

echo Starting TorDownloader PRO...
echo.

REM ---------------------------------------------------------------------------
REM 1/4  Stop stale Electron processes belonging to THIS checkout only.
REM      Never use "taskkill /im electron.exe": that would also kill VS Code,
REM      Discord and every other Electron app. Matching is by executable path
REM      under this script's own directory, so it works from any clone/folder.
REM ---------------------------------------------------------------------------
echo [1/4] Cleaning up running TorDownloader instances...
powershell -NoProfile -Command "$root = (Resolve-Path '%~dp0').Path.TrimEnd('\') + '\'; $filter = \"Name='electron.exe'\"; function Get-AppProc { @(Get-CimInstance Win32_Process -Filter $filter | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, 'OrdinalIgnoreCase') }) }; $procs = Get-AppProc; if ($procs.Count -gt 0) { $procs | ForEach-Object { Write-Host ('  Stopping stale PID ' + $_.ProcessId) }; $procs | Stop-Process -Force -ErrorAction SilentlyContinue; for ($i = 0; $i -lt 40; $i++) { Start-Sleep -Milliseconds 250; if ((Get-AppProc).Count -eq 0) { break } }; Write-Host '  Stale instances cleared.' } else { Write-Host '  No stale instances found.' }; exit 0"
if errorlevel 1 goto :fail

REM ---------------------------------------------------------------------------
REM 2/4  Install dependencies ONLY when they are missing or the lockfile moved.
REM      npm ci installs exactly package-lock.json and never rewrites it, so the
REM      tree (including the minimatch overrides) cannot drift between runs.
REM ---------------------------------------------------------------------------
echo [2/4] Checking dependencies against package-lock.json...
powershell -NoProfile -Command "if ((Test-Path 'node_modules\.bin') -and (Test-Path 'node_modules\.package-lock.json') -and ((Get-Item 'node_modules\.package-lock.json').LastWriteTimeUtc -ge (Get-Item 'package-lock.json').LastWriteTimeUtc)) { exit 0 } else { exit 1 }"
if errorlevel 1 (
  echo   Lockfile changed - installing exactly-locked dependencies...
  call npm ci --prefer-offline --no-audit --no-fund --loglevel=error
  if errorlevel 1 goto :fail
) else (
  echo   Already in sync with package-lock.json.
)

REM ---------------------------------------------------------------------------
REM 3/4  Rebuild better-sqlite3 for Electron's ABI. Required after any install:
REM      npm ships a Node-ABI binary, Electron needs its own NODE_MODULE_VERSION.
REM      electron-builder already depends on @electron/rebuild, so no extra
REM      devDependency is needed for this.
REM ---------------------------------------------------------------------------
echo [3/4] Rebuilding native modules for Electron...
call npx --no-install electron-builder install-app-deps
if errorlevel 1 goto :fail

REM ---------------------------------------------------------------------------
REM 4/4  Launch.
REM ---------------------------------------------------------------------------
echo [4/4] Starting Electron...
echo.
call npm run dev
if errorlevel 1 goto :fail
exit /b 0

:fail
echo.
echo ERROR: TorDownloader PRO failed to start (see the message above).
echo   Install dependencies : npm ci
echo   Rebuild native module: npx electron-builder install-app-deps
echo.
pause
exit /b 1
