@echo off
rem Puts back the app version from before the last update. data is never touched.
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "%~dp0SankyoUpdate.ps1" -Undo
