@echo off
title Sahibinden Panel
cd /d "%~dp0..\.."
set "PATH=%APPDATA%\npm;%PATH%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
if errorlevel 1 pause
