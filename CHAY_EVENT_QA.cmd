@echo off
title EventQA - Ban thuong
call "%~dp0scripts\run-eventqa.cmd" cdp
exit /b %errorlevel%
