@echo off
rem Opens the Sankyo Chat updater. You can also drop an update zip onto this file.
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "%~dp0SankyoUpdate.ps1" %*
