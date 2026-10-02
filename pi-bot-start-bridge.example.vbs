' 后台静默启动桥接服务（输出到 log-bot.txt）。
' 用法：复制本文件为 pi-bot-start-bridge.vbs 后使用。
' 路径由脚本自身位置推导，无需改；node 从 PATH 里找（找不到就改成 node.exe 的完整路径）。
Dim sh, dir
Set sh = CreateObject("WScript.Shell")
dir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
sh.Run "cmd /c cd /d """ & dir & """ && node src\main.ts > """ & dir & "log-bot.txt"" 2>&1", 0, False
