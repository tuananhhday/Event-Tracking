@echo off
title EventQA 02 - CDP + OpenRouter
call "%~dp0..\..\scripts\run-eventqa.cmd" cdp-ai
exit /b %errorlevel%
