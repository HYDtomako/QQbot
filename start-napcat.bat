@echo off
REM 启动 NapCatQQ（机器人 QQ 号快速登录；登录态失效时会回退二维码，扫窗口里的码即可）
REM 按你的环境修改 NAPCAT_DIR 与 BOT_QQ
set NAPCAT_DIR=D:\NapCat.Shell.Windows.Node
set BOT_QQ=你的机器人QQ号

cd /d %NAPCAT_DIR%
node.exe ./index.js -q %BOT_QQ%
