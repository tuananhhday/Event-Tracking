@echo off
title EventQA 03 - Proxy khong AI
call "%~dp0..\..\scripts\run-eventqa.cmd" proxy
exit /b %errorlevel%
