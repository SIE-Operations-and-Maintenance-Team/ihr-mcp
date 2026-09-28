@echo off
chcp 65001 >nul
title ihr-mcp 离线发布包打包

cd /d "%~dp0"

echo 正在生成离线发布包（dist + 生产依赖 + 部署脚本）...
node scripts\publish.mjs
echo.
pause
