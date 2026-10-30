@echo off
title EventQA - CDP khong AI
call "%~dp0scripts\run-eventqa.cmd" cdp
exit /b %errorlevel%
