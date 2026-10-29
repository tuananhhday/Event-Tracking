@echo off
cd /d "%~dp0"
node scripts\stop-apps.mjs
if errorlevel 1 pause
