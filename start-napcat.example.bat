@echo off
REM Start NapCatQQ with quick login. Copy this file to start-napcat.bat and fill in your values.
REM NOTE: keep the real start-napcat.bat ANSI/GBK encoded (never re-save as UTF-8),
REM and end every comment/echo line with an ASCII character (a trailing period works).
set NAPCAT_DIR=D:\NapCat.Shell.Windows.Node
set BOT_QQ=10000

cd /d %NAPCAT_DIR%
node.exe ./index.js -q %BOT_QQ%
REM Keep the window open on error so the reason stays visible.
pause
