@echo off
chcp 65001 >nul
title ihr-mcp 离线发布包打包

cd /d "%~dp0"

echo 正在生成离线发布包（dist + 生产依赖 + 部署脚本）...
node scripts\publish.mjs
set "IHR_TASK_EXIT=%errorlevel%"
echo.
pause
exit /b %IHR_TASK_EXIT%
