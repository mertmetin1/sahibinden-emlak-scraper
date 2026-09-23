@echo off
cd /d "%~dp0..\.."
set "PATH=%APPDATA%\npm;%PATH%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"
