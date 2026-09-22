@echo off
REM 桥接服务后台启动器：连接成功后本窗口自动关闭.
set LOG=D:\pi-napcatqq\log-bot.txt
echo 正在清理旧桥接进程（防止重复回复）...
powershell -NoProfile -EncodedCommand RwBlAHQALQBDAGkAbQBJAG4AcwB0AGEAbgBjAGUAIABXAGkAbgAzADIAXwBQAHIAbwBjAGUAcwBzACAALQBGAGkAbAB0AGUAcgAgACIATgBhAG0AZQA9ACcAbgBvAGQAZQAuAGUAeABlACcAIgAgAHwAIABXAGgAZQByAGUALQBPAGIAagBlAGMAdAAgAHsAIAAkAF8ALgBDAG8AbQBtAGEAbgBkAEwAaQBuAGUAIAAtAG0AYQB0AGMAaAAgACcAbQBhAGkAbgBcAC4AdABzACcAIAB9ACAAfAAgAEYAbwByAEUAYQBjAGgALQBPAGIAagBlAGMAdAAgAHsAIABTAHQAbwBwAC0AUAByAG8AYwBlAHMAcwAgAC0ASQBkACAAJABfAC4AUAByAG8AYwBlAHMAcwBJAGQAIAAtAEYAbwByAGMAZQAgAH0A
wscript.exe "%~dp0pi-bot-start-bridge.vbs"
echo 正在启动桥接服务并等待连接（若 NapCat 未启动，请先运行 start-napcat.bat）...
for /l %%i in (1,1,150) do (
  timeout /t 2 /nobreak >nul
  netstat -ano | findstr ":3001" | findstr "ESTABLISHED" >nul 2>&1 && goto ok
  cls
  powershell -NoProfile -Command "Get-Content -Tail 12 -Encoding UTF8 '%LOG%'"
)
echo.
echo 等待超时：请确认 NapCat 已启动，或把本窗口输出发给维护者.
pause
exit
:ok
echo.
echo 连接成功！桥接已转入后台运行，本窗口 2 秒后自动关闭.
timeout /t 2 /nobreak >nul
exit
