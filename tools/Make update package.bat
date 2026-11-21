@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Make-UpdatePackage.ps1" %*
echo.
pause
