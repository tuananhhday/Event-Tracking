@echo off
setlocal
cd /d "%~dp0"
title EventQA - Chon che do tren web
if exist "runtime\node.exe" (
  "runtime\node.exe" --env-file-if-exists=.env src\cli.mjs hub --open
) else (
  node --env-file-if-exists=.env src\cli.mjs hub --open
)
if errorlevel 1 pause
