@echo off
REM Start NapCatQQ with quick login. Copy this file to start-napcat.bat and configure yourself.
REM NOTE: keep the real start-napcat.bat ANSI/GBK encoded (never re-save as UTF-8),
REM and end every comment/echo line with an ASCII character (a trailing period works).
REM This example is not ready to run. Do not commit the copied bat.
set NAPCAT_DIR=
set BOT_QQ=
if "%NAPCAT_DIR%"=="" goto needcfg
if "%BOT_QQ%"=="" goto needcfg

cd /d %NAPCAT_DIR%
node.exe ./index.js -q %BOT_QQ%
REM Keep the window open on error so the reason stays visible.
pause
exit /b 0

:needcfg
echo configure yourself: copy this file to start-napcat.bat, then set NAPCAT_DIR and BOT_QQ.
pause
exit /b 1
