@echo off
chcp 65001 >nul
title ihr-mcp 服务卸载

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo [提示] 卸载 Windows 服务需要管理员权限，正在请求提升...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

cd /d "%~dp0"

echo 正在卸载 ihr-mcp Windows 服务（会先自动停止）...
node scripts\service-uninstall.mjs
echo.
pause
