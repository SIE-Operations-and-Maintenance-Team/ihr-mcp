@echo off
chcp 65001 >nul
setlocal
set ACTION=%1
if "%ACTION%"=="" goto usage
if /i "%ACTION%"=="status" (
  sc query ihr-mcp
  goto :eof
)

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo [提示] 该操作需要管理员权限，正在请求提升...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%ACTION%' -Verb RunAs"
  exit /b
)

REM 兼容两种安装名：新装 id=ihr-mcp；历史安装为 ihrmcp.exe
if /i "%ACTION%"=="start" (net start ihr-mcp 2>nul & net start ihrmcp.exe) & goto :eof
if /i "%ACTION%"=="stop" (net stop ihr-mcp 2>nul & net stop ihrmcp.exe 2>nul) & goto :eof
if /i "%ACTION%"=="restart" (
  net stop ihr-mcp 2>nul & net stop ihrmcp.exe 2>nul
  (net start ihr-mcp 2>nul || net start ihrmcp.exe)
  goto :eof
)

:usage
echo 用法: ihr-service.cmd [start^|stop^|restart^|status]
echo   status 无需管理员权限，其余操作会自动请求提升
