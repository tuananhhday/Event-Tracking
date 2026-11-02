@echo off
setlocal
cd /d "%~dp0.."
title EventQA - chon phuong an
echo.
echo   EventQA - Event Tracking QA
echo   ---------------------------------------------
echo   1. Ban thuong (khong AI)   http://127.0.0.1:4173
echo   2. Ban AI (OpenRouter)     http://127.0.0.1:4174
echo   3. Mo ca hai (moi ban mot cua so)
echo   0. Thoat
echo.
choice /c 1230 /n /m "  Chon phuong an [1-3, 0]: "
if errorlevel 4 goto :eof
if errorlevel 3 goto all
if errorlevel 2 goto p2
call "solutions\01-cdp-no-ai\start.cmd" & goto :eof
:p2
call "solutions\02-cdp-ai\start.cmd" & goto :eof
:all
start "EventQA 01 - Ban thuong" cmd /c "solutions\01-cdp-no-ai\start.cmd"
start "EventQA 02 - Ban AI" cmd /c "solutions\02-cdp-ai\start.cmd"
echo   Da mo hai cua so. Dung tat ca: STOP_EVENT_QA.cmd
