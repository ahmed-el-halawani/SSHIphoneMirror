@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-Mirror.ps1" -Action Stop
pause
