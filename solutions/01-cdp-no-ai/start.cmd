@echo off
title EventQA 01 - Ban thuong
call "%~dp0..\..\scripts\run-eventqa.cmd" cdp
exit /b %errorlevel%
