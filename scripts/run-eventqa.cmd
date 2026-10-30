@echo off
setlocal
cd /d "%~dp0.."
set "EVENTQA_MODE=%~1"
if /i "%EVENTQA_MODE%"=="cdp" goto runtime
if /i "%EVENTQA_MODE%"=="cdp-ai" goto runtime
if /i "%EVENTQA_MODE%"=="proxy" goto runtime
if /i "%EVENTQA_MODE%"=="stop" goto runtime
echo Khong nhan dien duoc che do chay EventQA.
pause
exit /b 1

:runtime
set "EVENTQA_NODE=%CD%\runtime\node.exe"
if exist "%EVENTQA_NODE%" goto version
where node >nul 2>nul
if errorlevel 1 goto missing_runtime
set "EVENTQA_NODE=node"

:version
"%EVENTQA_NODE%" -e "if (Number(process.versions.node.split('.')[0]) < 24) process.exit(1)" >nul 2>nul
if errorlevel 1 goto missing_runtime
if not exist "node_modules\exceljs\package.json" goto missing_dependencies
if not exist "node_modules\ajv\package.json" goto missing_dependencies
if not exist "node_modules\json5\package.json" goto missing_dependencies
if /i "%EVENTQA_MODE%"=="stop" goto stop
if /i "%EVENTQA_MODE%"=="cdp-ai" goto ai
"%EVENTQA_NODE%" src\cli.mjs serve --mode "%EVENTQA_MODE%" --open
goto result

:ai
"%EVENTQA_NODE%" --env-file-if-exists=.env src\cli.mjs serve --mode cdp-ai --open
goto result

:stop
"%EVENTQA_NODE%" scripts\stop-apps.mjs

:result
set "EVENTQA_EXIT=%errorlevel%"
if not "%EVENTQA_EXIT%"=="0" pause
exit /b %EVENTQA_EXIT%

:missing_runtime
echo.
echo Khong tim thay Node.js 24+ hoat dong.
echo Hay giai nen TOAN BO ban Windows day du, gom thu muc runtime.
echo Khong chay truc tiep file CMD ben trong file ZIP.
pause
exit /b 1

:missing_dependencies
echo.
echo Thieu thu vien cua ung dung.
echo Hay giai nen TOAN BO ban Windows day du, gom thu muc node_modules.
echo Khong chay truc tiep file CMD ben trong file ZIP.
pause
exit /b 1
