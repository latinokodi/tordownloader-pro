@echo off
cd /d "%~dp0"
echo Starting TorDownloader PRO...
echo.
echo Cleaning up any existing TorDownloader instances...
REM Targeted cleanup: only kills THIS app's Electron processes.
REM Never use "taskkill /im electron.exe" here - it would also kill
REM vidautodownAPP, VS Code, Discord and every other Electron app.
powershell -NoProfile -Command "$f = \"Name='electron.exe'\"; $procs = @(Get-CimInstance Win32_Process -Filter $f | Where-Object { $_.ExecutablePath -like '*\tordownloaderElectron\*' }); if ($procs.Count -gt 0) { $procs | ForEach-Object { Write-Host ('  Stopping stale TorDownloader PID ' + $_.ProcessId) }; $procs | Stop-Process -Force -ErrorAction SilentlyContinue; for ($i = 0; $i -lt 20; $i++) { Start-Sleep -Milliseconds 500; if (@(Get-CimInstance Win32_Process -Filter $f | Where-Object { $_.ExecutablePath -like '*\tordownloaderElectron\*' }).Count -eq 0) { break } }; Write-Host '  Stale instances cleared.' } else { Write-Host '  No stale instances found.' }"
timeout /t 2 /nobreak >nul
echo.
call npm install
call npx electron-rebuild -f -w better-sqlite3
call npm run dev
