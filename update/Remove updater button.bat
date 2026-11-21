@echo off
rem Stops the "Open the updater" button in Sankyo Chat from opening the updater on this PC.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0SankyoUpdate.ps1" -UnregisterLink
echo.
pause
