@echo off
cd /d "%~dp0"
if exist "release\win-unpacked\iPhone Mirror.exe" (
  start "" "release\win-unpacked\iPhone Mirror.exe"
) else if exist "node_modules\electron\dist\electron.exe" (
  set ELECTRON_RUN_AS_NODE=
  start "" "node_modules\electron\dist\electron.exe" .
) else (
  echo Run npm install first, then open this file again.
  pause
)
