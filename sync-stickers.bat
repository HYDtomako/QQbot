@echo off
REM 表情包素材登记（双击运行）：盯着 stickers\ 文件夹，新图片自动补进清单.
cd /d "%~dp0"
echo 正在同步 stickers\ 里的素材并开始监听...
echo 以后把图片复制进 stickers\ 就会自动登记；替换同名文件即可换图.
echo 窗口留着就一直盯着；关掉不影响已登记的结果，下次要用再双击本文件.
echo.
node scripts\stickers-watch.ts
echo.
echo 监听已退出. 按任意键关闭窗口.
pause >nul
