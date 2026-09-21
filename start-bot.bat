@echo off
REM 启动 pi-NapCatQQ 桥接服务（需先启动 NapCat）
cd /d %~dp0
node src/main.ts
