@echo off
rem Run once on the super admin's PC, from the SankyoChat folder on the share.
rem Makes the "Open the updater" button in Sankyo Chat (Admin settings - Update the app) open the updater.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0SankyoUpdate.ps1" -RegisterLink
echo.
pause
