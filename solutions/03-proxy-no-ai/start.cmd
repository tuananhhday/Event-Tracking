@echo off
title EventQA 03 - Proxy khong AI
cd /d "%~dp0..\.."
node src\cli.mjs serve --mode proxy --open
if errorlevel 1 pause
