@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0SankyoBackup.ps1" -Action Restore
echo.
pause
