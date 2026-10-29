@echo off
setlocal
cd /d "%~dp0"
title EventQA - chon phuong an
echo.
echo   EventQA - Event Tracking QA
echo   ---------------------------------------------
echo   1. CDP khong AI          http://127.0.0.1:4173
echo   2. CDP + OpenRouter      http://127.0.0.1:4174
echo   3. Proxy khong AI        http://127.0.0.1:4175
echo   4. Mo ca ba (moi phuong an mot cua so)
echo   0. Thoat
echo.
choice /c 12340 /n /m "  Chon phuong an [1-4, 0]: "
if errorlevel 5 goto :eof
if errorlevel 4 goto all
if errorlevel 3 goto p3
if errorlevel 2 goto p2
call "solutions\01-cdp-no-ai\start.cmd" & goto :eof
:p2
call "solutions\02-cdp-ai\start.cmd" & goto :eof
:p3
call "solutions\03-proxy-no-ai\start.cmd" & goto :eof
:all
start "EventQA 01 - CDP" cmd /c "solutions\01-cdp-no-ai\start.cmd"
start "EventQA 02 - CDP + AI" cmd /c "solutions\02-cdp-ai\start.cmd"
start "EventQA 03 - Proxy" cmd /c "solutions\03-proxy-no-ai\start.cmd"
echo   Da mo ba cua so. Dung tat ca: STOP_EVENT_QA.cmd
