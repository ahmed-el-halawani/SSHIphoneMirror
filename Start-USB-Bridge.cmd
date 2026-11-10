@echo off
cd /d "%~dp0"
node scripts\usb-mac-bridge.cjs %*
if errorlevel 1 pause
