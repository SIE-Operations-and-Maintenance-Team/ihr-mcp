@echo off
chcp 65001 >nul
setlocal
set "IHR_SERVICE_ACTION=%~1"
if /i "%IHR_SERVICE_ACTION%"=="status" goto run
if /i "%IHR_SERVICE_ACTION%"=="start" goto admin
if /i "%IHR_SERVICE_ACTION%"=="stop" goto admin
if /i "%IHR_SERVICE_ACTION%"=="restart" goto admin
echo 用法: ihr-service.cmd [start^|stop^|restart^|status]
exit /b 1
:admin
net session >nul 2>&1
if errorlevel 1 goto elevate
:run
cd /d "%~dp0"
node scripts\service-control.mjs "%IHR_SERVICE_ACTION%"
exit /b %errorlevel%
:elevate
set "IHR_ELEVATE_SCRIPT=%~f0"
powershell -NoProfile -Command "$ErrorActionPreference='Stop'; $p=Start-Process -FilePath $env:IHR_ELEVATE_SCRIPT -ArgumentList $env:IHR_SERVICE_ACTION -Verb RunAs -Wait -PassThru; exit $p.ExitCode"
exit /b %errorlevel%
