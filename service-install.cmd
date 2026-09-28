@echo off
chcp 65001 >nul
title ihr-mcp 服务安装

REM ---- 管理员权限自检与自提升 ----
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo [提示] 安装 Windows 服务需要管理员权限，正在请求提升...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

cd /d "%~dp0"

REM ---- 前置检查 ----
if not exist "dist\index.js" (
  echo [错误] 未找到 dist\index.js，请先执行 npm run build
  pause
  exit /b 1
)
if not exist "node_modules\node-windows" (
  echo [错误] 未找到 node-windows 依赖，请先执行 npm install
  pause
  exit /b 1
)

echo 正在安装 ihr-mcp Windows 服务...
node scripts\service-install.mjs
echo.
pause
