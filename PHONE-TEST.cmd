@echo off
title R!OT WALL, phone test
cd /d "%~dp0"
echo.
echo   R!OT WALL, phone test
echo   ---------------------------------------------
echo   Starting the wall, opening an HTTPS tunnel and
echo   putting a QR on screen. Scan it with the phone.
echo.
echo   Closing this window takes the tunnel down.
echo   ---------------------------------------------
echo.
node phone-test.mjs %*
echo.
pause
