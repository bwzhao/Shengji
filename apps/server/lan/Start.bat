@echo off
rem Shengji LAN server (Windows): double-click to run
chcp 65001 >nul
cd /d "%~dp0"
node\node.exe app\lan.mjs
echo.
pause
