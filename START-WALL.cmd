@echo off
REM R!OT WALL. Double-click this on the machine driving the screen.
REM
REM That machine is also the server: phones reach it over the venue wifi, so the
REM whole installation runs with NO INTERNET. Do not open the html files directly,
REM they load ES modules and need a real origin.
setlocal
title R!OT WALL
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found. Install it from https://nodejs.org then run this again.
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 8300 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if errorlevel 1 (
  echo   Starting the wall server...
  start "R!OT WALL server" /min node server.mjs 8300
  timeout /t 2 /nobreak >nul
) else (
  echo   Server already running on 8300.
)

set "CHROME="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"

if defined CHROME (
  start "" "%CHROME%" --kiosk --start-fullscreen "http://localhost:8300/wall"
) else (
  start "" "http://localhost:8300/wall"
)

echo.
echo   WALL is on the screen.
echo   Staff page:  http://localhost:8300/admin    key: riot2026
echo.
echo   PHONES: the server window lists the address to put on the QR cards.
echo   They must be on the same wifi as this machine.
echo.
echo   TO STOP: close this window AND the minimized "R!OT WALL server" window.
echo.
pause
