@echo off
title EventQA - Ban AI
call "%~dp0scripts\run-eventqa.cmd" cdp-ai
exit /b %errorlevel%
