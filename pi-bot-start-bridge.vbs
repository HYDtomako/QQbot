' Launch bridge hidden; output to log-bot.txt
CreateObject("WScript.Shell").Run "cmd /c cd /d D:\pi-napcatqq && D:\node\node.exe src\main.ts > D:\pi-napcatqq\log-bot.txt 2>&1", 0, False
