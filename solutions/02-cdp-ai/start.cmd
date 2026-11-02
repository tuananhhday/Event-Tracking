@echo off
title EventQA 02 - Ban AI
call "%~dp0..\..\scripts\run-eventqa.cmd" cdp-ai
exit /b %errorlevel%
