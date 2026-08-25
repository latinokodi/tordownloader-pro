@echo off
cd /d "%~dp0"
echo Starting TorDownloader PRO...
echo.
echo Cleaning up any existing instances...
taskkill /f /im electron.exe >nul 2>&1
timeout /t 2 /nobreak >nul
echo.
call npm install
call npx electron-rebuild -f -w better-sqlite3
call npm run dev
