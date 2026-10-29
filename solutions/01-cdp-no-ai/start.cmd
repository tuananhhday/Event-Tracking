@echo off
title EventQA 01 - CDP khong AI
cd /d "%~dp0..\.."
node src\cli.mjs serve --mode cdp --open
if errorlevel 1 pause
