@echo off
chcp 65001 >nul
title LongCut 长视频规整

rem 切到项目根目录（本文件在 longcut\ 下）
cd /d "%~dp0.."

if not exist "node_modules\.bin\tsx.cmd" (
  echo.
  echo   [x] 找不到 tsx，说明依赖没装好。
  echo       请先在项目根目录执行：  pnpm install
  echo.
  pause
  exit /b 1
)

echo.
echo   LongCut 启动中，浏览器会自动打开 http://127.0.0.1:5180
echo   关掉这个窗口 = 停止服务（标记已经存盘，关掉不会丢）
echo.

start "" http://127.0.0.1:5180
call "node_modules\.bin\tsx.cmd" "longcut\server.ts"

echo.
echo   服务已停止。
pause
