@echo off
chcp 65001 >nul
setlocal
title ihr-mcp 服务安装
net session >nul 2>&1
if errorlevel 1 goto elevate
cd /d "%~dp0"
node scripts\service-install.mjs
set "IHR_TASK_EXIT=%errorlevel%"
echo.
pause
exit /b %IHR_TASK_EXIT%
:elevate
set "IHR_ELEVATE_SCRIPT=%~f0"
powershell -NoProfile -Command "$ErrorActionPreference='Stop'; $p=Start-Process -FilePath $env:IHR_ELEVATE_SCRIPT -Verb RunAs -Wait -PassThru; exit $p.ExitCode"
exit /b %errorlevel%
