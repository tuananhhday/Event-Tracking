@echo off
title EventQA 01 - CDP khong AI
call "%~dp0..\..\scripts\run-eventqa.cmd" cdp
exit /b %errorlevel%
