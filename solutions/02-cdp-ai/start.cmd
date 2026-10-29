@echo off
title EventQA 02 - CDP + OpenRouter
cd /d "%~dp0..\.."
node --env-file-if-exists=.env src\cli.mjs serve --mode cdp-ai --open
if errorlevel 1 pause
